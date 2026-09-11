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
