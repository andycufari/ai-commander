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
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',ctrlKey:true,bubbles:true}))`);
    await sleep(200);
    await assertGutterAt(page, 0.55);
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',ctrlKey:true,bubbles:true}))`);
    await sleep(200);
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

    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))`);
    await sleep(250);
    const opened = await tabState();
    check("⌃T opens a tab and shows the strip", opened.strip === 2, opened);
    check("the new tab takes the panel title", opened.title.startsWith("files"), opened.title);
    check("the F-bar follows the focused view", opened.bar.includes("mkdir"), opened.bar);
    await assertTitlesNotClipped(page);
    await assertNoOverflow(page);

    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true}))`);
    await sleep(250);
    const cycled = await tabState();
    check("⌃⇥ cycles back to chat", cycled.title.startsWith("chat"), cycled.title);
    check("the F-bar switches back to chat keys", cycled.bar.includes("sessions"), cycled.bar);

    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true}))`);
    await sleep(200);
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true}))`);
    await sleep(250);
    const closed = await tabState();
    check("⌃W closes the tab and the strip hides again", closed.strip === 0, closed);
    check("the shell is still usable after closing a tab",
      closed.title.startsWith("chat") && (await page.eval<boolean>("!!document.querySelector('.prompt')")),
      closed);

    group("focus");
    const before = await page.eval<string>("document.querySelector('.cols > .blk.focus')?.className ?? ''");
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`);
    await sleep(200);
    const after = await page.eval<string>("[...document.querySelectorAll('.cols > .blk')].findIndex(e=>e.classList.contains('focus'))");
    check("Tab moves focus to the other panel", String(after) === "1", { before, afterIndex: after });
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`);
    await sleep(200);

    group("layout");
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
