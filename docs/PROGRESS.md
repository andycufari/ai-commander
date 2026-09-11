# Progress

Current milestone: **M0 — "Claude Code in a browser"**

Update the checklist as items land. One commit per item (`M0: protocol package` style).

---

## M0 — "Claude Code in a browser"

- [x] 1. pnpm monorepo + `packages/protocol` (zod: WS intents, events, tool schemas, config)
- [x] 2. Backend `serve` with WS (`packages/core` + `bin/aicommander`), HTTP `/file`, `/upload`, `/static`, `--brain` override
- [ ] 3. Web app shell — single panel, chat only (React + Vite, tokens from mockups)
- [x] 4. Brain client — streaming, tools, `toolFormat: auto` (OpenAI native + text-tag fallback)
- [~] 5. Core tools — read_file, write_file, edit_file, glob, grep, shell, git ✓;
      `ask_user` still to do (needs the modal round trip, lands with M2 permissions)
- [x] 6. Session store — `session.jsonl` + `meta.json`; reload restores the chat
- [x] 7. Esc cancel (mid-loop, keeps partial text, marks group `cancelled`)

**Demo (must pass before M1):** open `~/lab/x`, ask "list the files and summarize BUILDME.md",
see streaming tool calls, cancel mid-loop, reload the page → same session.

---

## M1 — Commander shell

- [ ] Two panels, tabs, gutter, focus, F-key bar (context-relative), status line, top line
- [ ] files view (NC keys, mark, `@`)
- [ ] editor view (CodeMirror, md preview)
- [ ] image viewer
- [ ] `open_in_panel` tool + click on mentions
- [ ] workspace.json save/restore (tabs, gutter, focus, marks, prompt draft)
- [ ] chokidar → `fs.changed` → files view refresh

**Demo:** brain edits a file → it opens in the other panel; you edit NOTES.md while the loop
runs; close and reopen → identical layout.

---

## M2 — Loop hardening

- [ ] Guards 1–7 (§6)
- [ ] Background jobs + log view
- [ ] Permission engine + rules.json + danger/warning modals (v2 contract)
- [ ] Modes ask / auto / plan
- [ ] Options modal (session/project/global)
- [ ] Snapshots + session navigator (fork/truncate/drop group/drop outputs)
- [ ] Compact (manual + auto), clear, queue/steer
- [ ] Modal system: all tiers + input/pick/progress + toasts

**Demo:** `rm -rf` blocked in auto mode; `npm run dev` becomes a job; repeat grep ×3 pauses;
rewind restores a deleted file; queued message lands at next tool boundary.

---

## M3 — Context

- [ ] system.md (global template in `packages/core/templates/system.md`)
- [ ] boot sequence, skills index, `list_skills` / `read_skill`
- [ ] + picker with 4 tabs, mentions in prose, image attachments (vision), file-hash dedupe
- [ ] Context inspector (`F4` alt view): assembled layers + token counts, read-only

**Demo:** attach a skill twice in one session → second time is a reference, not content.
Context inspector matches what's sent.

---

## M4 — Viewers & special tools

- [ ] Viewer registry + plugin loader (esbuild-wasm)
- [ ] Built-in viewers: video, table (csv/sqlite), pdf, cad (three.js + openscad), circuit (kicad-cli svg)
- [ ] Special tools: sql, comfyui, cad_render, circuit_export
- [ ] Self-improve flow: brain writes a viewer → `viewer.install` → system.md updated

**Demo:** "open the case in 3D, thicken the wall, re-render" works end to end;
"make a viewer for .gcode" produces a working plugin.

---

## M5 — Desktop

- [ ] Tauri 2 shell, backend sidecar, one window per repo
- [ ] `⌃O` open in new window, recents, desktop notifications
- [ ] mac + linux builds (dmg, AppImage/deb)
- [ ] Bundle `rg`; detect `openscad`, `kicad-cli`, `git` → info modal if missing

**Demo:** fresh machine: install, open folder, run a session, quit, reopen → restored.

---

## Notes / open questions

- Palette lives in `apps/web/src/tokens.css`, copied from `harness-layouts-v0.html` `:root`.
- Brain box: `192.168.1.44:8001` (llama.cpp, model id `local-brain`, 27B Q4_K_M, 98k ctx).
  `.40` from BUILDME §9 is not currently up.
- `scripts/chat.ts` drives a session from the terminal until the web app lands
  (`pnpm chat -- --new`). Esc cancels; `/cancel` and `/quit` also work.
- Item 3 (web app shell) is the only M0 item left.
- Open decisions tracked in BUILDME §15.
