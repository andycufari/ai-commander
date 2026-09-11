/**
 * Minimal CDP driver — headless Chrome over its own debugging protocol.
 *
 * Deliberately not Playwright/Puppeteer: this needs a page, some evaluate calls and a
 * screenshot, and Chrome already speaks that. Shared by scripts/ui-check.ts and any
 * future UI harness.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export interface Page {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Evaluate an expression in the page and return it by value. */
  eval<T = unknown>(expression: string): Promise<T>;
  screenshot(path: string): Promise<void>;
  press(key: string): Promise<void>;
  /** Type into a React-controlled input: sets the value through the native setter
   *  so React's onChange actually fires. */
  fill(selector: string, text: string): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function findChrome(): string {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error(`no Chrome found; looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
}

export async function launch(opts: { width?: number; height?: number; port?: number } = {}): Promise<Page> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const port = opts.port ?? 9222 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "aic-cdp-"));

  const chrome: ChildProcess = spawn(findChrome(), [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "about:blank",
  ], { stdio: "ignore" });

  // Wait for the debugging endpoint rather than sleeping a fixed time.
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as
        { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {
      // not listening yet
    }
  }
  if (!target) {
    chrome.kill();
    throw new Error(`Chrome did not expose a debug target on :${port}`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  let id = 0;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; result?: Record<string, unknown> };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result ?? {});
      pending.delete(msg.id);
    }
  });
  const cmd = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await cmd("Page.enable");
  await cmd("Runtime.enable");

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as
      { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value as T;
  };

  return {
    goto: async (url) => {
      await cmd("Page.navigate", { url });
      await sleep(300);
    },
    reload: async () => {
      await cmd("Page.reload");
      await sleep(300);
    },
    eval: evaluate,
    screenshot: async (path) => {
      const s = (await cmd("Page.captureScreenshot", { format: "png" })) as { data: string };
      writeFileSync(path, Buffer.from(s.data, "base64"));
    },
    press: async (key) => {
      await evaluate(`(() => {
        const ev = (t) => new KeyboardEvent(t, { key: ${JSON.stringify(key)}, bubbles: true });
        const el = document.activeElement ?? document.body;
        el.dispatchEvent(ev('keydown'));
        window.dispatchEvent(ev('keydown'));
        document.dispatchEvent(ev('keydown'));
        return true;
      })()`);
    },
    fill: async (selector, text) => {
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('no element: ' + ${JSON.stringify(selector)});
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return true;
      })()`);
    },
    close: async () => {
      ws.close();
      chrome.kill();
    },
  };
}

export { sleep };
