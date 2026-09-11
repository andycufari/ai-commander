import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Event, Intent, type Config, type Rules } from "@aicommander/protocol";
import { loadConfig, ensureProjectDir } from "./config.js";
import { PathEscapeError, resolveInRoot } from "./paths.js";
import { SessionStore } from "./sessions.js";
import { Loop } from "./loop.js";
import { WorkspaceStore } from "./workspace.js";
import { watchRepo } from "./watcher.js";
import { handleIntent, type Ctx } from "./intents.js";

export interface ServeOptions {
  root: string;
  port: number;
  /** `serve --brain <url>` — overrides the endpoint from both config files. */
  brain?: string;
  /** `serve --model <id>` — overrides the model, whether given or discovered. */
  model?: string;
  /** Context length discovered from the endpoint, when it reports one. */
  ctx?: number;
  /** Static web build to serve at `/`; omitted in dev, where Vite serves the app. */
  staticDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".stl": "model/stl",
  ".wasm": "application/wasm",
};
const mime = (p: string): string => MIME[extname(p).toLowerCase()] ?? "application/octet-stream";

export interface Serving {
  server: Server;
  port: number;
  config: Config;
  rules: Rules;
  close(): Promise<void>;
}

export async function serve(opts: ServeOptions): Promise<Serving> {
  const root = await resolveRoot(opts.root);
  await ensureProjectDir(root);

  const brainOverride: Record<string, string> = {};
  if (opts.brain) brainOverride.endpoint = opts.brain;
  if (opts.model) brainOverride.model = opts.model;
  const overrideBrain: Record<string, string | number> = { ...brainOverride };
  if (opts.ctx) overrideBrain.ctx = opts.ctx;
  const override = Object.keys(overrideBrain).length ? { brain: overrideBrain } : undefined;
  const { config, rules } = await loadConfig(root, override);

  const sessions = new SessionStore(root);
  const clients = new Set<WebSocket>();

  const broadcast = (event: Event): void => {
    const line = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(line);
  };

  const loop = new Loop({ root, config, rules, sessions, emit: broadcast });
  const workspace = new WorkspaceStore(root);
  const ctx: Ctx = { root, config, rules, sessions, loop, workspace, broadcast, send: broadcast };

  const watcher = watchRepo(root, broadcast, () => randomUUID());

  const server = createServer((req, res) => {
    void httpRoute(req, res, root, opts.staticDir).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : "error");
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    void onConnect(ws, ctx);

    ws.on("message", (raw) => {
      void (async () => {
        const send = (e: Event) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));
        let parsed: Intent;
        try {
          parsed = Intent.parse(JSON.parse(raw.toString()));
        } catch (err) {
          // A malformed intent gets an error back, but the socket stays open.
          send({ id: randomUUID(), type: "error", message: `bad intent: ${(err as Error).message}` });
          return;
        }
        try {
          await handleIntent(parsed, { ...ctx, send });
        } catch (err) {
          send({
            id: randomUUID(),
            type: "error",
            intentId: parsed.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  const port = await listen(server, opts.port);
  return {
    server,
    port,
    config,
    rules,
    close: async () => {
      await watcher.close();
      // Write the layout before the process goes away, rather than losing up to one
      // debounce window of it.
      await workspace.flush();
      await new Promise<void>((resolve) => {
        for (const ws of clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}

/**
 * On connect the client gets everything it needs to render without asking (§2).
 *
 * The workspace goes first and in the same batch: the UI holds its first paint until it
 * arrives, so a restored layout never flashes the default one on the way in.
 */
async function onConnect(ws: WebSocket, ctx: Ctx): Promise<void> {
  const send = (e: Event) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));
  send({ id: randomUUID(), type: "workspace", workspace: await ctx.workspace.load() });
  send({ id: randomUUID(), type: "config", config: ctx.config, root: ctx.root });
  send({ id: randomUUID(), type: "session.list", sessions: await ctx.sessions.list() });
}

async function httpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  staticDir?: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Raw repo file for the viewers (§2). Path-guarded like every other file access.
  if (url.pathname === "/file") {
    const rel = url.searchParams.get("path");
    if (!rel) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing path");
      return;
    }
    let abs: string;
    try {
      abs = await resolveInRoot(root, rel);
    } catch (err) {
      res.writeHead(err instanceof PathEscapeError ? 403 : 500, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : "error");
      return;
    }
    const info = await stat(abs).catch(() => undefined);
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": mime(abs), "content-length": info.size });
    createReadStream(abs).pipe(res);
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, root }));
    return;
  }

  // /upload lands in M1 with the files view; the route exists so the shape is fixed.
  if (url.pathname === "/upload") {
    res.writeHead(501, { "content-type": "text/plain" });
    res.end("upload arrives with the files view (M1)");
    return;
  }

  if (staticDir) {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let abs: string;
    try {
      abs = await resolveInRoot(staticDir, name);
    } catch {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const info = await stat(abs).catch(() => undefined);
    if (info?.isFile()) {
      res.writeHead(200, { "content-type": mime(abs), "content-length": info.size });
      createReadStream(abs).pipe(res);
      return;
    }
    // SPA fallback so a reloaded deep link still boots the app.
    const index = join(staticDir, "index.html");
    if (await stat(index).then(() => true).catch(() => false)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(index).pipe(res);
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

/**
 * The root is realpath'd once here so it is spelled the same way as everything
 * `resolveInRoot` returns. Without this, `toRepoPath` would produce a path full of
 * `../` on any platform where the root sits behind a symlink — on macOS /var is a
 * link to /private/var, so a plain tmpdir already triggers it.
 */
async function resolveRoot(root: string): Promise<string> {
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${root}`);
  return realpath(root);
}

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
