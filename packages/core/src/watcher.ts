import { watch, type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { Event } from "@aicommander/protocol";

/**
 * §12 M1: chokidar → fs.changed → the files view refreshes.
 *
 * Ignores the directories that generate noise rather than news: .git churns on every
 * git command, node_modules is enormous, and .aicommander/sessions and out/ are written
 * by this process on every turn — watching those would mean the app refreshing itself
 * in a loop while the brain works.
 */

const IGNORED_DIRS = new Set([".git", "node_modules"]);

/** Path segments under .aicommander that this process writes constantly. */
const IGNORED_AICOMMANDER = new Set(["sessions", "out"]);

export function shouldIgnore(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  // .aicommander/config.json and workspace.json are worth knowing about; the session
  // log and captured tool output are not.
  const ai = parts.indexOf(".aicommander");
  if (ai !== -1 && parts[ai + 1] && IGNORED_AICOMMANDER.has(parts[ai + 1]!)) return true;
  return false;
}

export interface WatcherHandle {
  close(): Promise<void>;
}

/**
 * Watch the repo and emit batched fs.changed events.
 *
 * Batched at 200ms because a single `npm install` or `git checkout` touches thousands
 * of paths, and the files view only needs to know that *something* changed once.
 */
export function watchRepo(
  root: string,
  emit: (event: Event) => void,
  makeId: () => string,
  batchMs = 200,
): WatcherHandle {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    emit({ id: makeId(), type: "fs.changed", paths });
  };

  const note = (absolute: string): void => {
    if (shouldIgnore(root, absolute)) return;
    const rel = relative(root, absolute).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) return;
    pending.add(rel);
    if (!timer) timer = setTimeout(flush, batchMs);
  };

  const watcher: FSWatcher = watch(root, {
    ignoreInitial: true,
    // Resolving symlinks would follow a link out of the repo; the path guard treats
    // that as an escape, so the watcher should not report it either.
    followSymlinks: false,
    ignored: (path: string) => shouldIgnore(root, path),
  });

  watcher.on("add", note);
  watcher.on("change", note);
  watcher.on("unlink", note);
  watcher.on("addDir", note);
  watcher.on("unlinkDir", note);
  // A watcher error (too many open files, a vanished directory) must not take the
  // backend down — the app is still usable without live refresh.
  watcher.on("error", () => {});

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
