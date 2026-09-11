# Progress

Current milestone: **M2 — Loop hardening** (M0, M1 complete)

Update the checklist as items land. One commit per item (`M0: protocol package` style).

---

## M0 — "Claude Code in a browser"

- [x] 1. pnpm monorepo + `packages/protocol` (zod: WS intents, events, tool schemas, config)
- [x] 2. Backend `serve` with WS (`packages/core` + `bin/aicommander`), HTTP `/file`, `/upload`, `/static`, `--brain` override
- [x] 3. Web app shell — single panel, chat only (React + Vite, tokens from mockups)
- [x] 4. Brain client — streaming, tools, `toolFormat: auto` (OpenAI native + text-tag fallback)
- [~] 5. Core tools — read_file, write_file, edit_file, glob, grep, shell, git ✓;
      `ask_user` still to do (needs the modal round trip, lands with M2 permissions)
- [x] 6. Session store — `session.jsonl` + `meta.json`; reload restores the chat
- [x] 7. Esc cancel (mid-loop, keeps partial text, marks group `cancelled`)

**Demo — PASSED** 2026-09-10, live against `192.168.1.44:8001` (llama.cpp, `local-brain`,
27B Q4_K_M, 98k ctx), driven through the real browser UI:

1. open the repo → top line shows path, brain, `ctx 0/98k`
2. "list the files and summarize BUILDME.md" → streaming `glob`/`shell` + `read_file`
   (over-cap, marked `truncated`), correct two-sentence summary, 2 tools in ~8s
3. `sleep 40` shell command, Esc mid-loop → `cancelled` in under a second
4. reload → same session, transcript restored (2 user turns before and after)

Still open from M0: `ask_user` (needs the modal round trip; lands with M2 permissions).

---

## M1 — Commander shell

- [x] 1. Two panels, draggable gutter, focus, maximize (80%)
- [x] 2. Tabbed view host + context-relative key bar
- [x] 3. files view (NC keys, mark, `@`, tree expansion) + viewer registry + prompt chips
- [x] 4. editor view (CodeMirror 6, md preview, ⌘S with conflict) + image viewer
- [x] 5. `show_files` tool + clickable mentions
- [x] 6. workspace.json save/restore + chokidar → `fs.changed`
- [x] 7. **Demo**

**Demo — PASSED** 2026-09-11, live against `192.168.1.44:8001` (`local-brain`, 27B
Q4_K_M, 98k ctx), driven through the real browser UI:

1. "show me docs/PROGRESS.md, then say which milestone is current" → `read_file` +
   `show_files`, the file opened in the right panel, the chat stayed intact on the left,
   and the model answered correctly from what it read
2. a file created on disk while a 6s shell command was running appeared in the open
   files view mid-loop, and the turn finished normally
3. gutter (0.45), tabs and an unsent prompt draft came back byte-identical after reload

### Landed beyond the original M1 list

First-use feedback moved several things forward:

- **No F-keys.** Many keyboards lack them and the browser claims several, so the bar
  shows ⌘-chords and is clickable. Chords a tab can never own (⌘W/⌘N/⌘T) hang off a
  ⌘K leader; Tauri adds the direct forms later without relearning.
- **Pick modal** (`Pick.tsx`) — the v2 info-tier filterable list, built as the reusable
  one M2's choosers and M3's `+` picker extend. Drives ⌘P, ⌘⇧P, ⌘K, ⌘O, ⌘, and ⌘/.
- **Touched-files list** derived from `session.jsonl`, per-session and reload-proof.
- **Slash commands** — `/clear`, `/new`, `/model`, `/files`, `/touched`, `/help` work;
  `/compact` and `/rewind` name the milestone they arrive in rather than failing silently.
- **`@` completes** repo files inline and produces a chip, not text.
- **`show_files` replaced `open_in_panel`** — the brain names paths, the app decides how
  to display each. Auto-open-on-write was built and then removed: inferring intent from
  a write only covers "here is what I changed".
- **`fs.tree`, `folders.list`, `fs.wrote`, `files.shown`** added to §3.

### Known gaps carried forward

- `⌘O` lists folders but cannot switch repo — one repo per window needs a backend per
  window, which is a Tauri concern (M5).
- The settings modal shows brain and mode read-only; editing is the M2 options modal.
- `~/.aicommander/config.json` supports `apiKey` and `apiKeyEnv`, but nothing writes it
  from the UI yet.
- `ask_user` still unimplemented (M0 item 5) — needs the modal round trip, so it lands
  with the M2 permission modals.

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
- `scripts/ui-check.ts` is the UI regression net — 91 assertions driven through headless
  Chrome over CDP. Run it against a live backend after any UI change:
  `pnpm ui-check`. It resets the workspace between groups and works against any repo.
- `scripts/chat.ts` drives a session from the terminal until the web app lands
  (`pnpm chat -- --new`). Esc cancels; `/cancel` and `/quit` also work.
- Item 3 (web app shell) is the only M0 item left.
- Open decisions tracked in BUILDME §15.
