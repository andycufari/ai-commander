import type { PanelMode, ViewKind } from "@aicommander/protocol";

/**
 * §10 viewer registry — which view opens a given file.
 *
 * This is the real registry, not a stand-in: M4 adds cad/circuit/table/pdf entries and
 * loads plugin viewers from `.aicommander/viewers/<name>/manifest.json`, whose `match`
 * globs register here the same way. Only the built-in text/markdown/image entries exist
 * today, so anything unrecognised falls back to the editor rather than refusing to open.
 */

export interface ViewerEntry {
  /** Registry key; a plugin viewer uses its manifest name. */
  name: string;
  /** Which view host renders it. */
  view: ViewKind;
  /** Extensions it claims, lower-case, without the dot. */
  extensions: readonly string[];
  /** Exact file names it claims (Makefile, Dockerfile, …). */
  filenames?: readonly string[];
  /** How it opens by default — markdown opens as a rendered view, code as an editor. */
  mode: PanelMode;
  /** Higher wins when two entries claim the same extension; plugins register above built-ins. */
  priority: number;
}

const BUILT_INS: ViewerEntry[] = [
  {
    name: "markdown",
    view: "editor",
    extensions: ["md", "markdown", "mdx"],
    mode: "view",
    priority: 10,
  },
  {
    name: "image",
    view: "viewer",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"],
    mode: "view",
    priority: 10,
  },
  {
    name: "text",
    view: "editor",
    extensions: [
      "txt", "log", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
      "c", "h", "cpp", "hpp", "cc", "rs", "go", "py", "rb", "sh", "bash", "zsh", "fish",
      "js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "html", "xml", "sql",
      "csv", "tsv", "gitignore", "lock", "diff", "patch",
    ],
    filenames: [
      "Makefile", "Dockerfile", "LICENSE", "README", "CHANGELOG",
      "AGENTS.md", "CLAUDE.md", ".gitignore", ".npmrc", ".env",
    ],
    mode: "edit",
    priority: 0,
  },
];

export class ViewerRegistry {
  private entries: ViewerEntry[];

  constructor(entries: readonly ViewerEntry[] = BUILT_INS) {
    this.entries = [...entries];
  }

  /** M4: viewer.install registers a plugin's manifest here. */
  register(entry: ViewerEntry): void {
    this.entries = [...this.entries.filter((e) => e.name !== entry.name), entry];
  }

  list(): readonly ViewerEntry[] {
    return this.entries;
  }

  /** The entry that claims `path`, or the text fallback. */
  resolve(path: string): ViewerEntry {
    const base = basename(path);
    const ext = extensionOf(base);

    const claims = this.entries.filter(
      (e) =>
        (e.filenames?.some((f) => f.toLowerCase() === base.toLowerCase()) ?? false) ||
        (ext !== "" && e.extensions.includes(ext)),
    );
    if (claims.length > 0) {
      return claims.reduce((best, e) => (e.priority > best.priority ? e : best));
    }
    // Unknown extension: open it as text rather than refusing. A binary file will
    // look like noise, which is a clearer signal than a dialog saying no.
    return this.entries.find((e) => e.name === "text") ?? BUILT_INS[2]!;
  }
}

export const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

export function extensionOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  // A leading dot is part of the name (.gitignore), not an extension.
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export const defaultRegistry = new ViewerRegistry();
