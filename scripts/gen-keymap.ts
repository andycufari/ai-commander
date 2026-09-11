#!/usr/bin/env node
/**
 * Regenerate BUILDME §11 from keymap.ts.
 *
 * The keymap is the source; the spec section is a view of it. Written by hand they
 * drift, and a spec that describes keys the app does not have is worse than no spec.
 *
 *   pnpm gen:keymap          # rewrite the section
 *   pnpm gen:keymap --check  # fail if it is out of date (for CI)
 */
import { readFile, writeFile } from "node:fs/promises";
import { BINDINGS, GROUPS } from "../apps/web/src/keymap.js";

const BUILDME = new URL("../docs/BUILDME.md", import.meta.url).pathname;
const START = "<!-- keymap:start -->";
const END = "<!-- keymap:end -->";

/** The printed chord, without the browser's platform guesswork. */
function hint(b: (typeof BINDINGS)[number]): string {
  const labels: Record<string, string> = {
    Enter: "⏎", Escape: "Esc", Tab: "⇥",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  };
  if (b.chord) {
    const { key, mod, shift, alt } = b.chord;
    return `${mod ? "⌘" : ""}${shift ? "⇧" : ""}${alt ? "⌥" : ""}${labels[key] ?? key.toUpperCase()}`;
  }
  return b.leader ? `⌘K ${b.leader.toUpperCase()}` : "";
}

function render(): string {
  const lines: string[] = [
    "",
    "*Generated from `apps/web/src/keymap.ts` by `pnpm gen:keymap` — edit the table, not this.*",
    "",
    "| key | action | what it does | slash |",
    "|---|---|---|---|",
  ];
  for (const group of GROUPS) {
    const rows = BINDINGS.filter((b) => b.group === group.id);
    if (rows.length === 0) continue;
    lines.push(`| **${group.label}** | | | |`);
    for (const b of rows) {
      lines.push(`| \`${hint(b)}\` | ${b.label} | ${b.describe} | ${b.command ? `\`/${b.command}\`` : ""} |`);
    }
  }
  lines.push(
    "",
    "`⌥1`–`⌥9` selects a tab in the focused panel; the number is printed on the tab.",
    "",
    "Chords a browser tab owns — `⌘W`, `⌘N`, `⌘T`, `⌘Q` — cannot be taken, so the actions",
    "that would want them hang off the `⌘K` leader. Tauri adds the direct forms later",
    "without anything being relearned.",
    "",
  );
  return lines.join("\n");
}

const doc = await readFile(BUILDME, "utf8");
const from = doc.indexOf(START);
const to = doc.indexOf(END);
if (from === -1 || to === -1) {
  console.error(`BUILDME.md has no ${START} / ${END} markers`);
  process.exit(1);
}

const next = `${doc.slice(0, from + START.length)}\n${render()}${doc.slice(to)}`;
if (process.argv.includes("--check")) {
  if (next !== doc) {
    console.error("BUILDME §11 is out of date — run: pnpm gen:keymap");
    process.exit(1);
  }
  console.log("BUILDME §11 matches keymap.ts");
} else {
  await writeFile(BUILDME, next);
  console.log(`BUILDME §11 regenerated from ${BINDINGS.length} bindings`);
}
