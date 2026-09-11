import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * §2: the backend never touches anything outside the repo root.
 * Every file path from an intent or a tool goes through here first.
 */
export class PathEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`path escapes the repo root: ${requested}`);
    this.name = "PathEscapeError";
  }
}

const isInside = (root: string, target: string): boolean => {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Resolve the deepest existing ancestor of `target` through realpath, then re-attach
 * the part that does not exist yet.
 *
 * Both halves matter: realpath alone fails on a file about to be written, and a purely
 * lexical resolve would miss a symlink pointing out of the repo. It also normalises
 * platform aliases — on macOS /var is a symlink to /private/var, so the same directory
 * has two spellings and only realpath makes them comparable.
 */
async function realResolve(target: string): Promise<string> {
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      // Walked to the filesystem root without finding anything that exists.
      if (parent === probe) return target;
      tail.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

/**
 * Resolve `input` against the repo root, rejecting anything above it.
 * Symlinks are resolved first, so a link inside the repo cannot point out of it.
 */
export async function resolveInRoot(root: string, input: string): Promise<string> {
  const realRoot = await realpath(root);
  const requested = isAbsolute(input) ? resolve(input) : resolve(realRoot, input);
  const target = await realResolve(requested);

  if (!isInside(realRoot, target)) throw new PathEscapeError(input);
  return target;
}

/** Repo-relative form for display and for the protocol — always forward slashes. */
export function toRepoPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}
