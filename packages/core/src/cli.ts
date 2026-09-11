#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listModels } from "./discover.js";
import { serve } from "./server.js";

/** §1: `aicommander serve <repo> [--port] [--brain <url>]` */

const USAGE = `aicommander serve <repo> [options]

  --port <n>      port to listen on (default 7777, 0 picks a free one)
  --brain <url>   OpenAI-compatible endpoint, overriding config.json
  --model <id>    model id, overriding config.json. With --brain and no --model,
                  the endpoint is asked and a single available model is adopted.
  --static <dir>  serve a built web app from this directory
  -h, --help      this
`;

/**
 * `--brain http://192.168.1.40:8080` is what you actually type; the client needs the
 * OpenAI-compatible base, so append /v1 when the URL has no path of its own. A URL that
 * already ends in /v1 — or points somewhere deliberate like /openai/v1 — is left alone.
 */
export function normalizeBrainUrl(input: string): string {
  let parsed: URL;
  try {
    // `new URL` alone accepts things like "box:8080" (scheme "box:"), so the scheme is
    // checked below rather than trusted.
    parsed = new URL(input);
  } catch {
    throw new Error(`--brain must be a URL, got: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--brain must be an http(s) URL, got: ${input}`);
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") parsed.pathname = "/v1";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

interface Parsed {
  repo: string;
  port: number;
  brain?: string;
  model?: string;
  /** What the user typed, kept only so the banner can show what changed. */
  rawBrain?: string;
  staticDir?: string;
}

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd !== "serve") throw new Error(`unknown command: ${cmd ?? "(none)"}\n\n${USAGE}`);

  let repo: string | undefined;
  let port = 7777;
  let brain: string | undefined;
  let model: string | undefined;
  let rawBrain: string | undefined;
  let staticDir: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const next = (): string => {
      const v = rest[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--port": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("--port must be 0-65535");
        port = n;
        break;
      }
      case "--brain": {
        rawBrain = next();
        brain = normalizeBrainUrl(rawBrain);
        break;
      }
      case "--model":
        model = next();
        break;
      case "--static":
        staticDir = resolve(next());
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
        if (repo !== undefined) throw new Error("only one repo path");
        repo = arg;
    }
  }

  if (!repo) throw new Error(`serve needs a repo path\n\n${USAGE}`);
  return { repo: resolve(repo), port, brain, model, rawBrain, staticDir };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const args = parseArgs(argv);

  // --brain with no --model: adopt the endpoint's model when it serves exactly one.
  let model = args.model;
  let ctx: number | undefined;
  let adopted: string | undefined;
  let discoveryNote: string | undefined;
  if (args.brain) {
    const found = await listModels(args.brain);
    ctx = found.ctx;
    if (found.error) discoveryNote = `could not ask ${args.brain}/models (${found.error})`;
    else if (model) {
      // --model was explicit; only the context length is worth adopting.
    } else if (found.ids.length === 1) {
      model = found.ids[0];
      adopted = model;
    } else if (found.ids.length > 1) {
      discoveryNote = `${found.ids.length} models available (${found.ids.slice(0, 4).join(", ")}${found.ids.length > 4 ? ", …" : ""}) — pass --model to choose`;
    }
  }

  const serving = await serve({
    root: args.repo,
    port: args.port,
    brain: args.brain,
    model,
    ctx,
    staticDir: args.staticDir,
  });

  const where = args.brain ? `${serving.config.brain.endpoint} (--brain)` : serving.config.brain.endpoint;
  process.stdout.write(
    `ai-commander  ${args.repo}\n` +
      `  http://localhost:${serving.port}\n` +
      `  brain  ${serving.config.brain.model} @ ${where}\n`,
  );
  // Say so when /v1 was appended, so the logged URL is never a surprise.
  if (args.brain && args.rawBrain && args.rawBrain !== args.brain) {
    process.stdout.write(`         normalized from ${args.rawBrain}\n`);
  }
  if (adopted) {
    process.stdout.write(
      `         model adopted from the endpoint (it serves only ${adopted})` +
        `${ctx ? `, ctx ${ctx}` : ""}\n`,
    );
  } else if (discoveryNote) {
    process.stdout.write(`         ${discoveryNote}\n`);
  }

  const stop = () => {
    void serving.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export function runCli(): void {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

// Run when invoked directly as a binary; bin/aicommander calls runCli() itself.
// Tests import parseArgs without either firing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
