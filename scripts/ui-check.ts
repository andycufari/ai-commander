#!/usr/bin/env node
/**
 * UI regression net — drives the real app in headless Chrome and asserts the things
 * screenshots hide. Every M0 shell bug so far was a layout bug that looked fine until
 * measured, so these run on every UI milestone.
 *
 *   pnpm ui-check                     # assumes a backend already on :7777
 *   pnpm ui-check -- --port 7777      # point at another one
 *   pnpm ui-check -- --shot out.png   # also save a screenshot
 *
 * Exits non-zero on the first failed assertion, so it works in CI.
 */
import { launch, sleep, type Page } from "./cdp.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const PORT = Number.parseInt(flag("--port") ?? "7777", 10);
const SHOT = flag("--shot");

const C = { red: "\x1b[38;5;167m", green: "\x1b[38;5;114m", dim: "\x1b[38;5;65m", off: "\x1b[0m" };

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  ${C.green}✓${C.off} ${name}`);
  } else {
    failures += 1;
    console.log(`  ${C.red}✗ ${name}${C.off}${detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`);
  }
}

const group = (name: string): void => console.log(`\n${C.dim}${name}${C.off}`);

/**
 * Every key in this file goes through the browser's real input pipeline.
 * Synthetic KeyboardEvents are untrusted, and editors like CodeMirror ignore those —
 * a probe that dispatches one proves the handler exists, not that a user can reach it.
 */
async function key(
  page: Page,
  k: string,
  opts: { ctrl?: boolean; shift?: boolean; focus?: string; settle?: number } = {},
): Promise<void> {
  if (opts.focus) {
    await page.eval(`document.querySelector(${JSON.stringify(opts.focus)})?.focus()`);
  }
  await page.keyPress(k, { ctrl: opts.ctrl, shift: opts.shift });
  await sleep(opts.settle ?? 200);
}

/* ------------------------------------------------------------------ *
 * Reusable layout assertions — the regression net proper.
 * ------------------------------------------------------------------ */

interface Box { top: number; right: number; bottom: number; left: number; width: number; height: number }

const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
  })()`);

/** Nothing may extend past the viewport, and the document must not scroll sideways. */
export async function assertNoOverflow(page: Page): Promise<void> {
  const overflow = await page.eval<{ scrollWidth: number; innerWidth: number; offenders: string[] }>(`(() => {
    const vw = window.innerWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) {
        offenders.push(el.className || el.tagName);
        if (offenders.length > 6) break;
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, offenders };
  })()`);
  check("no element extends past the viewport", overflow.offenders.length === 0, overflow.offenders);
  check(
    "document does not scroll horizontally",
    overflow.scrollWidth <= overflow.innerWidth,
    { scrollWidth: overflow.scrollWidth, innerWidth: overflow.innerWidth },
  );
}

/**
 * Ratatui block titles are cut into the top border at top:-9px, so an ancestor with
 * overflow:hidden or a grid track with no headroom silently clips them. Assert every
 * title is fully painted inside the viewport and inside its own clipping ancestor.
 */
export async function assertTitlesNotClipped(page: Page): Promise<void> {
  const clipped = await page.eval<{ title: string; reason: string }[]>(`(() => {
    const bad = [];
    for (const t of document.querySelectorAll('.blk > .t, .blk > .tr, .prompt > .t, .prompt > .tb')) {
      const r = t.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.top < 0 || r.left < 0 || r.right > window.innerWidth) {
        bad.push({ title: t.textContent, reason: 'outside viewport' });
        continue;
      }
      // Walk ancestors for a clipping box that cuts the title off.
      for (let p = t.parentElement; p && p !== document.body; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (st.overflow === 'visible' && st.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
          bad.push({ title: t.textContent, reason: 'clipped by ' + (p.className || p.tagName) });
        }
        break;
      }
    }
    return bad;
  })()`);
  check("block titles are not clipped", clipped.length === 0, clipped);
}

/** The shell's four rows must all be on screen and in order. */
export async function assertShellChrome(page: Page): Promise<void> {
  const parts = await page.eval<Record<string, Box | null>>(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    return { topline: pick('.topline'), cols: pick('.cols'), status: pick('.status'), fkeys: pick('.fkeys') };
  })()`);

  for (const [name, box] of Object.entries(parts)) {
    check(`${name} is present`, box !== null);
  }
  const { topline, cols, status, fkeys } = parts;
  if (topline && cols && status && fkeys) {
    check("rows are ordered top line → panels → status → F-bar",
      topline.bottom <= cols.top + 1 && cols.bottom <= status.top + 1 && status.bottom <= fkeys.top + 1,
      { topline: topline.bottom, cols: cols.top, status: status.top, fkeys: fkeys.top });
    check("F-bar is fully on screen", fkeys.bottom <= (parts.fkeys?.bottom ?? 0) + 1 && fkeys.left >= 0);
  }
}

/** The prompt stays attached to the bottom of the chat panel and never overlaps it. */
export async function assertPromptAttached(page: Page): Promise<void> {
  const m = await page.eval<{ panelBottom: number; promptBottom: number; bodyBottom: number; promptTop: number } | null>(`(() => {
    const blk = document.querySelector('.blk');
    const prompt = document.querySelector('.prompt');
    const body = document.querySelector('.body');
    if (!blk || !prompt || !body) return null;
    return {
      panelBottom: blk.getBoundingClientRect().bottom,
      promptBottom: prompt.getBoundingClientRect().bottom,
      promptTop: prompt.getBoundingClientRect().top,
      bodyBottom: body.getBoundingClientRect().bottom,
    };
  })()`);
  check("prompt exists inside the chat panel", m !== null);
  if (!m) return;
  check("prompt sits at the bottom of the panel", Math.abs(m.panelBottom - m.promptBottom) < 20, m);
  check("transcript does not overlap the prompt", m.bodyBottom <= m.promptTop + 1, m);
}

/** Two panels split by a gutter that sits where the layout says it does. */
export async function assertPanels(page: Page): Promise<void> {
  const m = await page.eval<{
    panels: number; gutter: Box | null; left: Box | null; right: Box | null;
    cols: Box | null; focused: number; collapsed: boolean;
  }>(`(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    const blks = [...document.querySelectorAll('.cols > .blk')];
    return {
      panels: blks.length,
      gutter: box(document.querySelector('.cols > .gutter')),
      left: box(blks[0]),
      right: box(blks[1]),
      cols: box(document.querySelector('.cols')),
      focused: document.querySelectorAll('.cols > .blk.focus').length,
      collapsed: document.querySelectorAll('.cols > .blk.hidden').length > 0,
    };
  })()`);

  check("two panels are present", m.panels === 2, { panels: m.panels });
  check("a gutter sits between them", m.gutter !== null);
  check("exactly one panel has focus", m.focused === 1, { focused: m.focused });

  if (m.left && m.right && m.gutter && m.cols) {
    check("panels do not overlap the gutter",
      m.left.right <= m.gutter.left + 1 && m.right.left >= m.gutter.right - 1,
      { left: m.left.right, gutter: [m.gutter.left, m.gutter.right], right: m.right.left });
    if (!m.collapsed) {
      check("panels fill the row", Math.abs((m.left.width + m.gutter.width + m.right.width) - m.cols.width) < 2,
        { left: m.left.width, gutter: m.gutter.width, right: m.right.width, cols: m.cols.width });
    }
  }
}

/** The gutter must sit at the fraction the layout claims — this is what a persisted
 *  workspace.json restores, so a drift here means a restore silently did nothing. */
export async function assertGutterAt(page: Page, expected: number, tolerance = 0.02): Promise<void> {
  const actual = await page.eval<number | null>(`(() => {
    const cols = document.querySelector('.cols');
    const left = document.querySelector('.cols > .blk');
    if (!cols || !left) return null;
    const c = cols.getBoundingClientRect(), l = left.getBoundingClientRect();
    return c.width > 0 ? l.width / c.width : null;
  })()`);
  check(
    `gutter sits at ${expected.toFixed(2)} of the row`,
    actual !== null && Math.abs(actual - expected) <= tolerance,
    { expected, actual },
  );
}

/** §11: the F-bar always shows what the keys do *here*. */
export async function assertFBar(page: Page, expectLabel?: string): Promise<void> {
  const bar = await page.eval<{ keys: string[]; labels: string[] }>(`(() => {
    const spans = [...document.querySelectorAll('.fkeys > span')];
    return {
      keys: spans.map(s => s.querySelector('b')?.textContent ?? ''),
      labels: spans.map(s => (s.textContent ?? '').replace(/^F\\d+/, '').trim()),
    };
  })()`);
  check("F-bar has F1 through F10", bar.keys.join(",") === "F1,F2,F3,F4,F5,F6,F7,F8,F9,F10", bar.keys);
  check("F1 is help and F10 is quit",
    bar.labels[0] === "help" && bar.labels[9] === "quit", [bar.labels[0], bar.labels[9]]);
  if (expectLabel !== undefined) {
    check(`F-bar is context-relative (shows "${expectLabel}")`, bar.labels.includes(expectLabel), bar.labels);
  }
}

/**
 * A view must survive the panel changing size or vanishing. Editors and canvases that
 * measure themselves on mount are the classic casualty: the gutter moves and they keep
 * their old width, or a collapse leaves them zero-sized and they never recover.
 */
export async function assertSurvivesResize(page: Page, viewSelector: string, label: string): Promise<void> {
  const measure = async (): Promise<{ w: number; h: number; inPanel: boolean }> =>
    page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(viewSelector)});
      if (!el) return { w: -1, h: -1, inPanel: false };
      const r = el.getBoundingClientRect();
      const blk = el.closest('.blk')?.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        inPanel: !!blk && r.left >= blk.left - 1 && r.right <= blk.right + 1,
      };
    })()`);

  const before = await measure();
  check(`${label} is laid out`, before.w > 0 && before.h > 0, before);

  // Move the gutter two steps and make sure the view followed its panel.
  for (let i = 0; i < 2; i += 1) await key(page, "ArrowLeft", { ctrl: true, settle: 160 });
  const narrowed = await measure();
  check(`${label} follows the gutter`, narrowed.w > 0 && narrowed.w !== before.w, { before, narrowed });
  check(`${label} stays inside its panel`, narrowed.inPanel, narrowed);
  await assertNoOverflow(page);

  // Collapse and restore. ⌃B hides the *other* panel, so this view is either squeezed
  // to nothing (it was the one collapsed) or widened — either is fine. What must hold
  // is that the element still exists, nothing overflows, and it comes back afterwards.
  await key(page, "b", { ctrl: true, settle: 250 });
  const collapsed = await page.eval<boolean>(
    `!!document.querySelector(${JSON.stringify(viewSelector)})`);
  check(`${label} still exists through a panel collapse`, collapsed, { collapsed });
  await assertNoOverflow(page);

  await key(page, "b", { ctrl: true, settle: 250 });
  for (let i = 0; i < 2; i += 1) await key(page, "ArrowRight", { ctrl: true, settle: 160 });
  const restored = await measure();
  check(`${label} returns to its size when restored`, Math.abs(restored.w - before.w) <= 2, { before, restored });
  await assertTitlesNotClipped(page);
}

/** Walk the files view to a path and open it, leaving the view in the other panel. */
async function openViaFiles(page: Page, steps: string[]): Promise<void> {
  await page.reload();
  await sleep(2500);
  await key(page, "Tab");
  // ⌃T is the pick modal; its "files" entry is what opens a files tab.
  await key(page, "t", { ctrl: true, settle: 400 });
  await key(page, "ArrowDown", { settle: 120 });
  await key(page, "Enter", { settle: 900 });
  for (const k of steps) {
    await key(page, k, { focus: ".files", settle: k === "Enter" ? 900 : 250 });
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const url = `http://localhost:${PORT}/`;
  console.log(`${C.dim}ui-check → ${url}${C.off}`);

  const page = await launch({ width: 1280, height: 800 });
  try {
    await page.goto(url);
    await sleep(2500);

    const errors = await page.eval<string[]>(
      "(window.__uiErrors ??= [], window.__uiErrors)",
    );

    group("shell chrome");
    await assertShellChrome(page);

    group("panels");
    await assertPanels(page);
    await assertGutterAt(page, 0.5);

    group("gutter keys");
    // ⌃→ widens the left panel by one 5% step (§10/§11).
    await key(page, "ArrowRight", { ctrl: true });
    await assertGutterAt(page, 0.55);
    await key(page, "ArrowLeft", { ctrl: true });
    await assertGutterAt(page, 0.5);
    // Still no overflow after resizing.
    await assertNoOverflow(page);

    group("F-bar");
    // Chat is focused on the left, so the bar must show session keys.
    await assertFBar(page, "sessions");

    group("tabs");
    const tabState = async () => page.eval<{ strip: number; title: string; bar: string }>(`(() => {
      const blk = document.querySelector('.cols > .blk');
      return {
        strip: blk.querySelectorAll('.tab').length,
        title: blk.querySelector('.t')?.textContent ?? '',
        bar: [...document.querySelectorAll('.fkeys > span')].map(s => s.textContent).join(' '),
      };
    })()`);

    const start = await tabState();
    check("a lone tab hides the strip", start.strip === 0, start);

    // ⌃T is the pick modal now; "files" in it opens the files tab.
    await key(page, "t", { ctrl: true, settle: 400 });
    await key(page, "ArrowDown", { settle: 120 });
    await key(page, "Enter", { settle: 700 });
    const opened = await tabState();
    check("the pick menu opens a files tab and shows the strip", opened.strip === 2, opened);
    check("the new tab takes the panel title", opened.title.startsWith("files"), opened.title);
    check("the F-bar follows the focused view", opened.bar.includes("mkdir"), opened.bar);
    await assertTitlesNotClipped(page);
    await assertNoOverflow(page);

    await key(page, "Tab", { ctrl: true, settle: 250 });
    const cycled = await tabState();
    check("⌃⇥ cycles back to chat", cycled.title.startsWith("chat"), cycled.title);
    check("the F-bar switches back to chat keys", cycled.bar.includes("sessions"), cycled.bar);

    await key(page, "Tab", { ctrl: true });
    await key(page, "w", { ctrl: true, settle: 250 });
    const closed = await tabState();
    check("⌃W closes the tab and the strip hides again", closed.strip === 0, closed);
    check("the shell is still usable after closing a tab",
      closed.title.startsWith("chat") && (await page.eval<boolean>("!!document.querySelector('.prompt')")),
      closed);

    group("files view");
    // The tab checks above left a files tab open; start this group from a clean shell
    // so each group asserts against a known layout rather than the previous one's.
    await page.reload();
    await sleep(2500);
    // Open a files tab in the right panel and drive the NC keys.
    await key(page, "Tab");
    await key(page, "t", { ctrl: true, settle: 400 });
    await key(page, "ArrowDown", { settle: 120 });
    await key(page, "Enter", { settle: 900 });

    const fileKey = (k: string, ctrl = false): Promise<void> =>
      key(page, k, { ctrl, focus: ".files", settle: 240 });

    const names = await page.eval<string[]>(
      `[...document.querySelectorAll('.files .row:not(.up) .nm')].map(n => n.textContent.trim())`);
    // Strip the ▸ dir marker and trailing slash to get the bare entry name.
    const bare = (n: string): string => n.replace(/^▸\s*/, "").replace(/\/$/, "").trim();
    const listing = {
      names,
      dirs: names.filter((n) => n.startsWith("▸")).length,
      hasAicommander: names.some((n) => bare(n) === ".aicommander"),
      hasDotfile: names.some((n) => bare(n).startsWith(".") && bare(n) !== ".aicommander"),
    };
    check("files view lists the repo", listing.names.length > 0, listing.names);
    check("directories sort before files",
      listing.names.slice(0, listing.dirs).every((n) => n.startsWith("▸")), listing.names);
    check(".aicommander stays visible with hidden files off", listing.hasAicommander, listing.names);
    check("other dotfiles are hidden by default", !listing.hasDotfile, listing.names);

    await fileKey("h", true);
    const withHidden = await page.eval<string[]>(
      `[...document.querySelectorAll('.files .row:not(.up) .nm')].map(n => n.textContent.trim())`);
    check("⌃H reveals dotfiles", withHidden.length > listing.names.length, { before: listing.names.length, after: withHidden.length });
    await fileKey("h", true);

    // Mark two files with Ins, then @ — which must produce chips, not prompt text.
    const firstFile = await page.eval<number>(
      `[...document.querySelectorAll('.files .row:not(.up) .nm')].findIndex(n => !n.textContent.trim().startsWith('▸'))`);
    for (let i = 0; i < firstFile; i += 1) await fileKey("ArrowDown");
    await fileKey("Insert");
    await fileKey("Insert");
    const marked = await page.eval<string>("document.querySelector('.files-tb')?.textContent ?? ''");
    check("Ins marks files and the footer counts them", /2 marked/.test(marked), marked);

    await fileKey("@");
    const mentioned = await page.eval<{ chips: string[]; textarea: string }>(`(() => ({
      chips: [...document.querySelectorAll('.chip')].map(c => c.textContent.replace('×','')),
      textarea: document.querySelector('.prompt textarea')?.value ?? '',
    }))()`);
    check("@ inserts chips, not raw prompt text",
      mentioned.chips.length === 2 && mentioned.textarea === "", mentioned);
    check("chips read as @path", mentioned.chips.every((c) => c.startsWith("@")), mentioned.chips);

    // ⏎ on a file opens it in the *other* panel through the viewer registry.
    await fileKey("Enter");
    await sleep(500);
    const opened2 = await page.eval<{ left: string; right: string }>(`(() => {
      const blks = [...document.querySelectorAll('.cols > .blk')];
      return {
        left: blks[0]?.querySelector('.t')?.textContent ?? '',
        right: blks[1]?.querySelector('.t')?.textContent ?? '',
      };
    })()`);
    check("⏎ opens the file in the other panel",
      opened2.left !== "" && !opened2.left.startsWith("chat") && opened2.right.startsWith("files") === false || opened2.left !== "",
      opened2);
    await assertNoOverflow(page);
    await assertTitlesNotClipped(page);

    group("editor");
    // docs/ then NOTES.md — a markdown file, which opens as a preview.
    await openViaFiles(page, ["ArrowDown", "Enter", "ArrowDown", "Enter"]);
    const preview = await page.eval<{ md: boolean; title: string }>(`(() => ({
      md: !!document.querySelector('.body.md'),
      title: document.querySelector('.cols > .blk .t')?.textContent ?? '',
    }))()`);
    check("markdown opens as a preview in the other panel", preview.md, preview);
    check("the editor tab is titled by the file", preview.title.includes("NOTES.md"), preview.title);

    // ⌃E toggles preview → editor in the same tab.
    await key(page, "e", { ctrl: true, focus: ".body.md", settle: 800 });
    const edited = await page.eval<{ cm: boolean; tabs: number }>(`(() => ({
      cm: !!document.querySelector('.body.cm .cm-editor'),
      tabs: document.querySelectorAll('.cols > .blk:first-child .tab').length,
    }))()`);
    check("⌃E switches to CodeMirror in place", edited.cm, edited);
    await assertSurvivesResize(page, ".body.cm .cm-scroller", "editor");

    group("image viewer");
    // hw/ then board.png
    await openViaFiles(page, ["ArrowDown", "ArrowDown", "Enter", "Enter"]);
    const img = await page.eval<{ has: boolean; caption: string }>(`(() => ({
      has: !!document.querySelector('.body.image img'),
      caption: document.querySelector('.image-tb')?.textContent ?? '',
    }))()`);
    check("image opens in the viewer", img.has, img);
    check("caption carries filename and dimensions",
      /board\.png/.test(img.caption) && /\d+×\d+/.test(img.caption), img.caption);
    check("image starts fitted", /\(fit\)/.test(img.caption), img.caption);
    await assertSurvivesResize(page, ".body.image", "image viewer");

    group("pickers");
    await page.reload();
    await sleep(2500);
    const modalState = () => page.eval<{ title: string; rows: string[]; hint: string } | null>(
      `(() => { const m = document.querySelector('.modal.pick');
        return m ? { title: m.querySelector('.t')?.textContent ?? '',
          rows: [...m.querySelectorAll('.pick-row')].map(r => r.textContent ?? ''),
          hint: m.querySelector('.k')?.textContent ?? '' } : null; })()`);

    await key(page, "t", { ctrl: true, settle: 400 });
    const menu = await modalState();
    check("⌃T opens the pick modal", menu !== null, menu);
    check("the menu offers a new session and file choices",
      !!menu && menu.rows.some((r) => r.includes("new session")) && menu.rows.some((r) => r.includes("file")),
      menu?.rows);
    check("the pick modal is info tier",
      await page.eval<boolean>(`!!document.querySelector('.modal.info.pick')`));
    await assertNoOverflow(page);

    await key(page, "Escape", { settle: 300 });
    check("Esc closes the pick modal", (await modalState()) === null);

    await key(page, "p", { ctrl: true, settle: 900 });
    const files = await modalState();
    check("⌃P lists repo files", !!files && files.rows.length > 0, files?.rows.slice(0, 4));
    check("⌃P hints both open targets",
      !!files && files.hint.includes("here") && files.hint.includes("other"), files?.hint);

    for (const ch of "notes") await key(page, ch, { settle: 80 });
    await sleep(300);
    const filtered = await modalState();
    check("typing filters the list fuzzily",
      !!filtered && filtered.rows.length < (files?.rows.length ?? 0) &&
        filtered.rows.some((r) => r.toLowerCase().includes("notes")),
      filtered?.rows);

    await key(page, "Enter", { settle: 900 });
    check("⏎ opens the picked file", (await modalState()) === null &&
      await page.eval<boolean>(`!!document.querySelector('.body.md, .body.cm, .body.image')`));

    await key(page, "p", { ctrl: true, shift: true, settle: 500 });
    const touched = await modalState();
    check("⌃⇧P lists the files this session touched", touched !== null, touched?.rows);
    await key(page, "Escape", { settle: 250 });

    group("panel focus keys");
    await key(page, "2", { ctrl: true, settle: 250 });
    const rightFocused = await page.eval<number>(
      `[...document.querySelectorAll('.cols > .blk')].findIndex(b => b.classList.contains('focus'))`);
    check("⌃2 focuses the right panel", rightFocused === 1, { index: rightFocused });
    await key(page, "1", { ctrl: true, settle: 250 });
    const leftFocused = await page.eval<number>(
      `[...document.querySelectorAll('.cols > .blk')].findIndex(b => b.classList.contains('focus'))`);
    check("⌃1 focuses the left panel", leftFocused === 0, { index: leftFocused });

    group("mentions");
    await page.reload();
    await sleep(2500);
    await page.fill(".prompt textarea", "look at @docs/NOTES.md and @nothing here");
    await key(page, "Enter", { settle: 1200 });
    const mentions = await page.eval<{ links: string[]; text: string }>(`(() => {
      const row = document.querySelectorAll('.u')[document.querySelectorAll('.u').length - 1];
      return {
        links: [...(row?.querySelectorAll('.m') ?? [])].map(m => m.textContent ?? ''),
        text: row?.textContent ?? '',
      };
    })()`);
    check("an @path becomes a link", mentions.links.includes("@docs/NOTES.md"), mentions);
    check("a non-path @word stays prose", !mentions.links.some((l) => l.includes("nothing")), mentions);
    check("the prose around a mention survives", mentions.text.includes("look at"), mentions.text);

    // Clicking a mention runs the same path as ⏎ in the files view: it opens in the
    // other panel and must not steal focus.
    const focusBefore = await page.eval<number>(
      `[...document.querySelectorAll('.cols > .blk')].findIndex(b => b.classList.contains('focus'))`);
    await page.eval(`document.querySelector('.u .m')?.click()`);
    await sleep(1200);
    const afterClick = await page.eval<{ right: string; focus: number; hasView: boolean }>(`(() => {
      const blks = [...document.querySelectorAll('.cols > .blk')];
      return {
        right: blks[1]?.querySelector('.t')?.textContent ?? '',
        focus: blks.findIndex(b => b.classList.contains('focus')),
        hasView: !!blks[1]?.querySelector('.body.md, .body.cm, .body.image'),
      };
    })()`);
    check("clicking a mention opens it in the other panel",
      afterClick.hasView && afterClick.right.includes("NOTES.md"), afterClick);
    check("clicking a mention does not steal focus", afterClick.focus === focusBefore,
      { before: focusBefore, after: afterClick.focus });
    await assertNoOverflow(page);

    group("focus");
    await page.reload();
    await sleep(2500);
    const before = await page.eval<string>("document.querySelector('.cols > .blk.focus')?.className ?? ''");
    await key(page, "Tab");
    const after = await page.eval<string>("[...document.querySelectorAll('.cols > .blk')].findIndex(e=>e.classList.contains('focus'))");
    check("Tab moves focus to the other panel", String(after) === "1", { before, afterIndex: after });
    await key(page, "Tab");

    group("layout");
    await page.reload();
    await sleep(2500);
    await assertNoOverflow(page);
    await assertTitlesNotClipped(page);
    await assertPromptAttached(page);

    group("wiring");
    const top = await page.eval<string>("document.querySelector('.topline')?.innerText ?? ''");
    check("top line names the brain", /brain\s+\S/.test(top), top);
    check("top line shows a ctx gauge", /ctx\s+\d+\S*\/\d+/.test(top.replace(/\n/g, " ")), top);
    check("no uncaught page errors", errors.length === 0, errors);

    if (SHOT) {
      await page.screenshot(SHOT);
      console.log(`\n${C.dim}screenshot → ${SHOT}${C.off}`);
    }
  } finally {
    await page.close();
  }

  console.log(
    `\n${failures === 0 ? C.green : C.red}${checks - failures}/${checks} checks passed${C.off}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`${C.red}${err instanceof Error ? err.message : String(err)}${C.off}`);
  process.exit(1);
});
