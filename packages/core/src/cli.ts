#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "./server.js";

/** §1: `aicommander serve <repo> [--port] [--brain <url>]` */

const USAGE = `aicommander serve <repo> [options]

  --port <n>      port to listen on (default 7777, 0 picks a free one)
  --brain <url>   OpenAI-compatible endpoint, overriding config.json
  --static <dir>  serve a built web app from this directory
  -h, --help      this
`;

interface Parsed {
  repo: string;
  port: number;
  brain?: string;
  staticDir?: string;
}

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd !== "serve") throw new Error(`unknown command: ${cmd ?? "(none)"}\n\n${USAGE}`);

  let repo: string | undefined;
  let port = 7777;
  let brain: string | undefined;
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
        const url = next();
        // `new URL` alone accepts things like "box:8080" (scheme "box:"), which would
        // then fail deep inside the brain client — check the scheme here instead.
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`--brain must be a URL, got: ${url}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(`--brain must be an http(s) URL, got: ${url}`);
        }
        brain = url;
        break;
      }
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
  return { repo: resolve(repo), port, brain, staticDir };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const args = parseArgs(argv);
  const serving = await serve({
    root: args.repo,
    port: args.port,
    brain: args.brain,
    staticDir: args.staticDir,
  });

  const where = args.brain ? `${serving.config.brain.endpoint} (--brain)` : serving.config.brain.endpoint;
  process.stdout.write(
    `ai-commander  ${args.repo}\n` +
      `  http://localhost:${serving.port}\n` +
      `  brain  ${serving.config.brain.model} @ ${where}\n`,
  );

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
