import { useEffect, useId } from "react";

/**
 * While a modal is up, only the modal stack receives keys.
 *
 * Every other handler — the window-level keymap and the per-view ones in the files
 * list, the editor and the image viewer — stands down. Enforced in one place rather
 * than by a check in each handler, because a handler that forgets the check is exactly
 * the bug this prevents: Esc reaching both the modal and the loop, or ↑↓ moving a file
 * cursor behind a permission ask.
 *
 * The stack is a counter, not a boolean: a pick opened from a modal must not un-block
 * the keyboard when the inner one closes.
 */

let depth = 0;
const listeners = new Set<(open: boolean) => void>();

const notify = (): void => {
  for (const l of listeners) l(depth > 0);
};

export const modalOpen = (): boolean => depth > 0;

/** Call from a modal component's mount, released on unmount. */
export function pushModal(): () => void {
  depth += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    notify();
  };
}

/** React hook form: holds the lock for as long as the component is mounted. */
export function useModalLock(): void {
  // `useId` gives each instance a stable identity; the lock itself is the effect.
  useId();
  useEffect(() => pushModal(), []);
}

export function onModalChange(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Wrap a key handler so it does nothing while a modal is up. Views use this instead of
 * remembering the rule themselves.
 */
export function unlessModal<E>(handler: (e: E) => void): (e: E) => void {
  return (e) => {
    if (depth > 0) return;
    handler(e);
  };
}

/** Test seam: reset between cases. */
export function __resetModalStack(): void {
  depth = 0;
  notify();
}
