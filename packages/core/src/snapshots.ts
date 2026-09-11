import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { git } from "./intents.js";
import { projectDir } from "./config.js";

/**
 * §6 guard 6 — snapshot before each user turn.
 *
 * Plumbing only. Every command here runs against a private index file
 * (.aicommander/tmp-index), so the user's own `git add` staging is never disturbed and
 * HEAD never moves. A snapshot is a tree object plus a ref under refs/aicommander/;
 * it is invisible to `git log` and `git status`, and costs nothing until the working
 * tree actually changes.
 *
 * What goes in is decided by .gitignore and nothing else — the user already said what
 * belongs in their repo, and a second exclusion list would be a second place to be
 * wrong. The one addition is .aicommander/sessions and out/, which this process writes
 * on every turn: snapshotting them would mean each snapshot contained the log of its
 * own creation.
 */

const TMP_INDEX = "tmp-index";

/** Paths never snapshotted: we write them constantly, and they are not the user's work. */
const SELF_WRITTEN = ["sessions", "out"];

export interface Snapshot {
  ref: string;
  tree: string;
  /** Bytes in the tree, for the status line's cost readout. */
  bytes: number;
  /** How long taking it took, in ms. */
  ms: number;
}

const refFor = (sessionId: string, groupId: string): string =>
  `refs/aicommander/${sessionId}-${groupId}`;

/** Run git with a private index so the user's staging area is untouched. */
async function plumbing(root: string, args: string[]): Promise<string> {
  return git(root, args, {
    GIT_INDEX_FILE: join(projectDir(root), TMP_INDEX),
  });
}

/**
 * Take a snapshot of the working tree.
 *
 * Returns undefined when the repo has no git — snapshots are a nicety, and a repo
 * without git should still be usable rather than refusing to run a turn.
 */
export async function takeSnapshot(
  root: string,
  sessionId: string,
  groupId: string,
  onError?: (message: string) => void,
): Promise<Snapshot | undefined> {
  const started = Date.now();
  try {
    await mkdir(projectDir(root), { recursive: true });
    // A stale index — or worse, a stale lock — from a crashed run would make every
    // later snapshot fail silently, which is how rewind quietly stops working.
    await clearIndex(root);

    // add -A respects .gitignore; the pathspecs drop what we write ourselves.
    await plumbing(root, [
      "add", "-A", "--",
      ".",
      ...SELF_WRITTEN.map((d) => `:(exclude).aicommander/${d}`),
    ]);
    const tree = (await plumbing(root, ["write-tree"])).trim();
    const ref = refFor(sessionId, groupId);
    await plumbing(root, ["update-ref", ref, tree]);

    return { ref, tree, bytes: await treeBytes(root, tree), ms: Date.now() - started };
  } catch (err) {
    // No git, or a repo in a state git will not index: the turn still runs, but the
    // reason is worth seeing — a silently missing snapshot makes rewind useless.
    onError?.(err instanceof Error ? err.message : String(err));
    return undefined;
  } finally {
    await clearIndex(root).catch(() => {});
  }
}

/** Remove the private index and any lock left behind by an interrupted run. */
async function clearIndex(root: string): Promise<void> {
  const index = join(projectDir(root), TMP_INDEX);
  await rm(index, { force: true });
  await rm(`${index}.lock`, { force: true });
}

/** Total size of the blobs in a tree, for the cost readout. */
async function treeBytes(root: string, tree: string): Promise<number> {
  try {
    const listing = await git(root, ["ls-tree", "-r", "-l", tree]);
    let total = 0;
    for (const line of listing.split("\n")) {
      // <mode> blob <sha> <size>\t<path>
      const size = Number.parseInt(line.split(/\s+/)[3] ?? "", 10);
      if (Number.isFinite(size)) total += size;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Every path in a snapshot, repo-relative. */
export async function snapshotPaths(root: string, tree: string): Promise<Set<string>> {
  const listing = await git(root, ["ls-tree", "-r", "--name-only", tree]).catch(() => "");
  return new Set(listing.split("\n").filter(Boolean));
}

/**
 * Restore the working tree from a snapshot.
 *
 * Two halves: write every file the snapshot has, then delete the files that exist now
 * and did not then. The second half is what makes a restore actually restore — without
 * it, a file the brain created would survive a rewind that was meant to undo it.
 * .aicommander/ is never touched either way.
 */
export async function restoreSnapshot(root: string, tree: string): Promise<{ written: number; deleted: number }> {
  await clearIndex(root);
  try {
    await plumbing(root, ["read-tree", tree]);
    await plumbing(root, ["checkout-index", "-a", "-f"]);

    const wanted = await snapshotPaths(root, tree);
    const present = await trackableFiles(root);
    let deleted = 0;
    for (const path of present) {
      if (wanted.has(path)) continue;
      await rm(join(root, path), { force: true });
      deleted += 1;
    }
    await pruneEmptyDirs(root);
    return { written: wanted.size, deleted };
  } finally {
    await clearIndex(root).catch(() => {});
  }
}

/**
 * Files git would consider part of the repo right now — tracked or not, minus what
 * .gitignore excludes. Asking git rather than walking the tree ourselves means the
 * ignore rules are interpreted by the thing that owns them.
 */
async function trackableFiles(root: string): Promise<string[]> {
  const listing = await git(root, [
    "ls-files", "--cached", "--others", "--exclude-standard", "--",
    ".", ":(exclude).aicommander",
  ]).catch(() => "");
  return [...new Set(listing.split("\n").filter(Boolean))];
}

/** Remove directories a restore emptied, so a rewind does not leave husks behind. */
async function pruneEmptyDirs(root: string, dir = root): Promise<boolean> {
  const rel = relative(root, dir).split(sep)[0];
  if (rel === ".git" || rel === ".aicommander" || rel === "node_modules") return false;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let empty = entries.length > 0 || dir !== root;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const removed = await pruneEmptyDirs(root, join(dir, entry.name));
      if (!removed) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty && dir !== root) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return true;
  }
  return false;
}

/** Drop the refs for a session, or for one group of it. */
export async function pruneSnapshots(
  root: string,
  sessionId: string,
  groupId?: string,
): Promise<number> {
  const listing = await git(root, ["for-each-ref", "--format=%(refname)", "refs/aicommander/"])
    .catch(() => "");
  const prefix = groupId ? refFor(sessionId, groupId) : `refs/aicommander/${sessionId}-`;
  const doomed = listing.split("\n").filter((r) => (groupId ? r === prefix : r.startsWith(prefix)));
  for (const ref of doomed) {
    await git(root, ["update-ref", "-d", ref]).catch(() => {});
  }
  return doomed.length;
}

/** Does the working tree have changes the user would lose? */
export async function isDirty(root: string): Promise<boolean> {
  const status = await git(root, ["status", "--porcelain", "--", ".", ":(exclude).aicommander"])
    .catch(() => "");
  return status.trim() !== "";
}

export { refFor, SELF_WRITTEN };
