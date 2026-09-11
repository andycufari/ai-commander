import type { Attachment } from "@aicommander/protocol";

/**
 * Prompt chips — the visual form of an Attachment (§7).
 *
 * The files view's `@` produces these, and so will the M3 `+` picker; they are the same
 * component because they mean the same thing: a thing the harness will place in context
 * itself, rather than text the user typed. Chips are kept beside the prompt's text, never
 * inside it, so editing prose can never half-delete an attachment.
 */

export interface Chip {
  /** Stable within a draft; used as the React key and for removal. */
  key: string;
  attachment: Attachment;
  /** What the chip reads as: `@path`, `/skill`, `#tool`, or an image's name. */
  label: string;
}

export const chipKey = (a: Attachment): string => {
  switch (a.kind) {
    case "file": return `file:${a.path}`;
    case "skill": return `skill:${a.name}`;
    case "image": return `image:${a.file}`;
    case "tool": return `tool:${a.name}`;
  }
};

export const chipLabel = (a: Attachment): string => {
  switch (a.kind) {
    case "file": return `@${a.path}`;
    case "skill": return `/${a.name}`;
    case "image": return a.file.split("/").pop() ?? a.file;
    case "tool": return `#${a.name}`;
  }
};

export const toChip = (a: Attachment): Chip => ({
  key: chipKey(a),
  attachment: a,
  label: chipLabel(a),
});

/** Add attachments to a draft, ignoring ones already there (§7 dedupes by identity). */
export function addChips(existing: readonly Chip[], attachments: readonly Attachment[]): Chip[] {
  const seen = new Set(existing.map((c) => c.key));
  const next = [...existing];
  for (const a of attachments) {
    const chip = toChip(a);
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    next.push(chip);
  }
  return next;
}

export const removeChip = (existing: readonly Chip[], key: string): Chip[] =>
  existing.filter((c) => c.key !== key);

/** A file chip needs a hash so the context assembler can dedupe unchanged files (§7).
 *  The backend fills it at send time; until then it is empty. */
export const fileAttachment = (path: string): Attachment => ({ kind: "file", path, hash: "" });
