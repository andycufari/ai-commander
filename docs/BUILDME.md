# AI Commander — BUILDME

> Norton Commander for building with AI. Two panels, a brain, your repo.
> Local-first desktop harness: chat + tools + file manager + viewers, driven by any OpenAI-compatible model (default: a box on the LAN).

Attachments (read before touching UI):
- `docs/mockups/v0-layouts.html` — layout studies, A chosen
- `docs/mockups/v1-commander.html` — Ratatui-style screens, F-key bar, loop, permission, + picker, context stack
- `docs/mockups/v2-modals-options.html` — modal tiers, options modal, open folder, workspace layout

---

## 0. What this is

An IDE-shaped app that is **not** a coding IDE. It's for iterating projects with an LLM: markdown, firmware, CAD, circuits, images, data. It keeps the UX of Claude Code (prompt → tool loop → Esc) and adds what a terminal can't: see the file the brain mentions, navigate the tree, run several sessions, edit a doc or look at a schematic next to the chat.

Non-goals (v1): multi-repo windows, collaborative sessions, cloud sync, plugins marketplace, Windows support.

Principles:
1. **Keyboard first, mouse welcome.** Every action has a key. The F-bar always shows what the keys do *here*.
2. **The harness owns context.** User attaches things; the harness decides where they land so the model reads them well and nothing is duplicated.
3. **Danger always blocks.** No mode, flag, or setting bypasses the permission rules.
4. **Everything is a file in the repo.** Sessions, config, rules, system prompt, viewers — all under `.aicommander/`, tracked by git by default.
5. **Terminal look, DOM guts.** Ratatui aesthetics; real DOM so viewers can render CAD and circuits.

---

## 1. Stack

| layer | choice | why |
|---|---|---|
| language | TypeScript everywhere | one codebase, shared types |
| UI | React 18 + Vite, no component library, CSS variables | terminal look is custom anyway |
| editor | CodeMirror 6 | md + code, small, keyboard-native |
| CAD viewer | three.js (STL/OBJ/glTF loaders); OpenSCAD via `openscad` CLI → STL | good enough for v1 |
| circuit viewer | `kicad-cli sch export svg` → SVG viewer with pan/zoom; part click → mention | native parser later |
| backend | Node 22, `ws`, `better-sqlite3`, `execa` | agent loop, tools, sessions |
| git | shell out to `git` binary | reliability > libraries |
| brain | OpenAI-compatible `/v1/chat/completions`, streaming, tools | llama.cpp, vLLM, Ollama, OpenRouter, Anthropic via proxy |
| desktop | Tauri 2, backend as sidecar | light, mac + linux |
| packaging | pnpm workspaces | |

```
ai-commander/
├── apps/
│   ├── web/            React app (also served by the backend for the web phase)
│   └── desktop/        Tauri shell; spawns backend sidecar; window per repo
├── packages/
│   ├── core/           agent loop, tools, context assembler, permissions, session store, git
│   ├── protocol/       shared TS types: WS events, tool schemas, config schemas (zod)
│   └── viewers/        built-in viewers (md, image, video, cad, circuit, table) + plugin loader
├── docs/
│   ├── mockups/        the three HTML files
│   └── BUILDME.md      this
└── bin/aicommander     `aicommander serve <repo> [--port]`
```

---

## 2. Runtime model

- One backend process per repo (`aicommander serve /path/to/repo`). Tauri spawns it; in web mode you run it by hand and open `http://localhost:7777`.
- Backend exposes: WS `/ws` (events both ways), HTTP `/upload` (multipart → repo path), `/file?path=` (raw file for viewers), `/static` (the web app).
- UI state lives in the backend, not the browser: reload = same session, same tabs. Browser only renders and sends intents.
- Backend never runs outside the repo root: every file tool resolves and rejects paths above root (symlinks resolved).

---

## 3. Protocol (packages/protocol)

WS messages are `{ id, type, ...payload }`. Client → server are **intents**; server → client are **events**. All typed with zod, exported to both sides.

The envelope `id` is the message's own id: the server echoes it as `error.intentId` and on
reply events, so a session-scoped intent names its target as `sessionId`, never `id`.

Intents (client → server):
```
session.create { name? }                 session.open { sessionId }
session.close { sessionId }              session.rename { sessionId, name }
session.delete { sessionId, confirm: "delete" }
session.send { sessionId, text, attachments: Attachment[] }     // queues if running
session.cancel { sessionId }
session.rewind { sessionId, groupId, mode: "fork"|"truncate" }
session.dropGroup { sessionId, groupId } session.dropToolOutput { sessionId, groupId }
session.compact { sessionId }            session.clear { sessionId }
permission.answer { requestId, answer: "once"|"session"|"deny", editedCommand? }
ask.answer { requestId, choice }
panel.opened { requestId, outcome: "opened"|"already-open"|"not-found", side?, view? }
options.set { scope: "session"|"project"|"global", sessionId?, patch }
fs.list { path }  fs.tree { limit? }  fs.read { path }  fs.write { path, content, baseHash }  fs.mkdir  fs.rename  fs.copy  fs.move  fs.delete { path, confirm }
git.status  git.log { path?, n }  git.diff { path? }  git.commit { message }  git.checkout { ref }
workspace.set { patch }                  workspace.get
viewer.list                              viewer.install { name }  (after brain writes one)
```

Events (server → client):
```
session.state { sessionId, status: "idle"|"running"|"paused"|"cancelled", ctxUsed, ctxMax, toolCount, elapsed, queued? }
turn.start { sessionId, groupId, role }
token { sessionId, groupId, delta }                         // streaming brain text
tool.start { sessionId, groupId, callId, name, args }
tool.output { callId, delta }                              // streaming shell output
tool.end { callId, ok, summary, outputPath?, truncated }
permission.request { requestId, sessionId, tool, command, rule, reason, level }
ask.request { requestId, sessionId, question, options[] }
job.start/job.output/job.end { jobId, ... }                // background shell jobs
open_in_panel { path, viewer?, mode: "view"|"edit", target: "other"|"left"|"right", requestId? }
mention.add { text }                                       // viewer → prompt
fs.changed { paths[] }                                     // chokidar
git.changed { branch, dirty, ahead }
toast { level: "info"|"warning", text }
compact.done { sessionId, before, after, summaryPath }
workspace { ...full state }
error { intentId?, message }
```

Reply events — these carry back the data an intent asked for. Each quotes the requesting
intent's envelope id as `intentId` so a caller can match a reply to its own request:
```
fs.listed { intentId, path, entries: FsEntry[] }           // ← fs.list
fs.tree { intentId, paths[], truncated }                   // ← fs.tree (⌃P)
fs.content { intentId, path, content, hash }               // ← fs.read
fs.wrote { intentId, path, hash }                          // ← fs.write
git.result { intentId, action, text }                      // ← any git.* intent
session.list { sessions: SessionMeta[] }                   // on connect
session.events { sessionId, meta, groups }                 // replayed log, on open + reconnect
config { config, root }                                    // merged global+project + repo root, on connect and after options.set
```

---

## 4. Session model & storage

```
.aicommander/
├── workspace.json      panels, tabs, gutter, focus, marked files, prompt draft
├── config.json         project defaults (schema §9)
├── rules.json          permission regexes, merged over ~/.aicommander/rules.json
├── system.md           harness manual for the brain (copied from global on first open)
├── sessions/
│   ├── index.sqlite    sessions, groups, tokens, fulltext(messages)
│   └── <id>/
│       ├── session.jsonl
│       ├── meta.json   { id, name, model, created, forkedFrom?, snapshots: [{groupId, gitRef}] }
│       └── img/
├── out/                full tool outputs over the cap: <callId>.txt
├── snapshots/          (empty; refs live in .git/refs/aicommander/*)
└── viewers/<name>/     manifest.json + index.jsx
~/.aicommander/         config.json, rules.json, system.md, recents.json
```

`session.jsonl` — one event per line, replayable to rebuild UI and context:

```jsonl
{"t":"user","id":"g18","ts":...,"text":"...","attachments":[{"kind":"file","path":"firmware/main.c","hash":"..."},{"kind":"skill","name":"esp32-lowpower"},{"kind":"image","file":"img/pcb-v3.jpg"}]}
{"t":"snapshot","group":"g18","ref":"refs/aicommander/s014-g18"}
{"t":"brain","id":"g18","text":"...","toolCalls":[...]}
{"t":"tool","id":"g18","callId":"c1","name":"read_file","args":{...},"ok":true,"summary":"212 lines","outputPath":null,"tokens":1400}
{"t":"permission","callId":"c3","rule":"rm -rf","answer":"deny"}
{"t":"cancel","group":"g20"}
{"t":"compact","upTo":"g16","summaryPath":"out/compact-1.md","before":58000,"after":11000}
```

A **group** = one user turn + the brain turn(s) and tool calls it caused. Groups are the unit for rewind, delete, drop-tool-output, and token accounting.

Sqlite (`index.sqlite`) is a derived index — rebuildable from jsonl. Tables: `sessions`, `groups(session, id, ts, userText, brainText, tokens, toolCount)`, `fts(messages)`. The brain's `sql` tool uses a *separate* db, `.aicommander/data.sqlite`, never the index.

---

## 5. Tools

### Core (always on)
| tool | notes |
|---|---|
| `read_file { path, range? }` | returns content with line numbers; over cap → head + tail + outputPath |
| `write_file { path, content }` | creates dirs; refuses outside root |
| `edit_file { path, old, new, all? }` | exact-match replace like Claude Code; returns unified diff |
| `glob { pattern }` | |
| `grep { pattern, path?, glob? }` | ripgrep if present, else JS |
| `shell { cmd, cwd?, timeout? }` | see §6 for timeout → background, permission rules |
| `job { action: "status"\|"output"\|"kill", jobId }` | background shell jobs |
| `git { action, ...}` | status, log, diff, add, commit, checkout, branch, stash. `push` and history rewrites go through permission rules |
| ~~`open_in_panel`~~ | **not a model tool.** The harness opens files itself — see auto-open below |
| `ask_user { question, options[] }` | renders an info modal; loop pauses; answer returned as tool result |
| `list_skills {}` / `read_skill { name }` | index is already in system prompt; this pulls full content |

### Special (opt-in per session via `#`)
| tool | notes |
|---|---|
| `sql { query }` | `.aicommander/data.sqlite`; DDL allowed; returns rows (cap 200) |
| `comfyui { workflow, inputs }` | POST to configured ComfyUI; polls; saves outputs to `assets/gen/`; returns paths + opens in panel |
| `cad_render { path, format: "stl"\|"png" }` | openscad CLI |
| `circuit_export { path }` | kicad-cli → svg |
| viewer-provided tools | declared in a viewer's `manifest.json` |

Tool results are compact: a `summary` line for the UI, `content` for the model. Output over `toolOutputCap` chars is truncated (head 60% / tail 40%) and the full text written to `out/<callId>.txt`; the model receives the path.

---

## 6. The loop

```
user turn
  → snapshot (git ref)                      [guard 6]
  → assemble context (§7)
  → stream brain
  → for each tool call:
        parse → repair if malformed         [guard 7]
        permission check (§8)               may pause → modal
        repeat guard                        [guard 1]
        run (shell: timeout → job)          [guard 4]
        cap output                          [guard 3]
        error guard                         [guard 2]
     → append results → stream brain again
  → until: no tool calls | cancel | guard pause | max tool calls | max turns
  → status idle, notify if window blurred
```

Guards (spec'd in the options modal, all in `config.json`):
1. **repeat-call guard** — identical `name+args` N times (default 3) in one group → pause, `ask_user`-style modal: "continue / stop / tell it something".
2. **consecutive-error guard** — N tool errors in a row (default 4) → same pause.
3. **tool output cap** — default 8000 chars, full output to `out/`.
4. **shell timeout → background job** — default 120s. On timeout the process is *not* killed: it becomes a job; the tool returns `{jobId, tail}`; output streams to a `log` tab in the other panel; `job.kill` exists; the brain can poll with `job`.
5. **steer mid-loop** — `session.send` while running queues the message; it's injected as a user message at the *next tool boundary* (not after the loop). UI shows it as "queued" in the prompt footer. Esc = cancel current tool + stop loop, keep partial text, mark group `cancelled`.
6. **snapshot before each user turn** — `git add -A && git write-tree`-style ref under `refs/aicommander/<session>-<group>` without touching the index or HEAD. Rewind to a group = restore working tree from that ref (warning modal if dirty) + fork or truncate the log. Untracked files included. Snapshots pruned when sessions are deleted.
7. **malformed tool calls** — try: JSON repair (trailing commas, single quotes, unquoted keys), XML-ish tool tags, fenced JSON. On failure return a tool error with the parse message so the model retries; counts toward guard 2.

Modes:
- **ask** — every write/edit/shell/git-write asks (info-style permission, Enter = allow). Danger rules use the danger modal.
- **auto** — only danger rules ask.
- **plan** — read-only tools only; write attempts return a tool error "plan mode".

Auto-compact at 75% ctx: summarize groups older than the last 6, keep all file edits as a list, write summary to `out/compact-N.md`, replace in context. Manual compact = F6 → same, with a warning modal first.

---

## 7. Context assembly (packages/core/context.ts)

Built fresh every turn, in this order, each layer a separate system/user block:

1. **harness manual** — `.aicommander/system.md`. Explains panels, auto-open, mentions, permissions, modes, `ask_user`, `sql`, viewers. The brain's UX contract. Editable in-app (F4 → editor in other panel).
2. **project boot** — from `config.json.boot`, default `["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"]`; loaded in order if present (AGENTS or CLAUDE, first found, unless both listed explicitly).
3. **skills index** — `skills/*/SKILL.md` frontmatter → `name — description`, one line each.
4. **tools** — core + enabled special tools (schemas go in the API `tools` field, not the prompt).
5. **git state** — branch, dirty count, last 3 commits (one line each).
6. **session** — messages. Attachments are inserted as blocks *above the user turn that mentioned them*: `<file path="..." hash="...">`, `<skill name="...">`, images as vision content. A file attached again with the same hash is replaced by `<file path="..." unchanged/>`. Compacted summary replaces old groups.

Mentions in prose (`@path`, `/skill`, `#tool`) typed without the picker resolve the same way at send time.

---

## 8. Permissions

`rules.json` (global merged with project; project wins on same id):
```json
{
  "danger": [
    { "id": "rm-rf", "match": "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)", "tool": "shell", "note": "recursive delete" },
    { "id": "git-force", "match": "push\\s+.*--force|push\\s+-f", "tool": "git" },
    { "id": "git-reset-hard", "match": "reset\\s+--hard", "tool": "git" },
    { "id": "sudo", "match": "^\\s*sudo\\b", "tool": "shell" },
    { "id": "outside-root", "builtin": true },
    { "id": "network", "match": "\\b(curl|wget|nc|ssh|scp)\\b", "tool": "shell", "level": "warning" }
  ],
  "allow": [ { "id": "npm-test", "match": "^npm (test|run lint)$", "tool": "shell" } ]
}
```
- `level: "danger"` (default) → danger modal, no Enter default, Esc = deny. Answers: once / session / edit / deny. Deny returns the rule note to the brain as a tool error.
- `level: "warning"` → warning modal, Enter = safe (deny), letter to allow.
- `allow` short-circuits ask mode.
- "outside-root" is built-in and cannot be removed.

---

## 9. Config schema

```jsonc
// .aicommander/config.json (project) / ~/.aicommander/config.json (global) — same shape, project overrides
{
  "brain": { "endpoint": "http://192.168.1.40:8080/v1", "model": "qwen3-27b", "apiKey": "", "temperature": 0.6, "ctx": 128000, "toolFormat": "auto" },
  "mode": "ask",
  "loop": { "maxToolCallsPerTurn": 50, "maxTurnsPerPrompt": 20, "shellTimeoutSec": 120, "toolOutputCap": 8000, "repeatGuard": 3, "errorGuard": 4 },
  "context": { "autoCompactAt": 0.75, "keepLastGroups": 6 },
  "boot": ["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"],
  "tools": { "special": ["sql"] },                // enabled by default in new sessions
  "notify": true,
  "comfyui": { "endpoint": "http://192.168.1.40:8188" }
}
```
Session overrides live in `meta.json.options` and show as "session" in the options modal.

---

## 10. UI spec

Reference: `v1-commander.html` for screens, `v2-modals-options.html` for modals. Palette and tokens are in those files' `:root`. Font: JetBrains Mono → IBM Plex Mono → system mono.

### Shell
- Top line: app name, repo path, git branch + state, brain + endpoint, ctx used/max.
- Two panels, gutter draggable and `⌃←/→` (5% steps), persisted. `⌃B` collapses the other panel; again restores.
- Panel = tabbed **view host**. Views: `chat`, `files`, `editor`, `viewer`, `log`, `sql`. `⌃W` close, `⌃⇥` cycle.
- A file the brain writes or edits opens itself in the other panel (§5 auto-open), activating an existing tab rather than duplicating it. Never moves focus.
- Focus = bright border. `Tab` swaps panel focus.
- Status line: mode-specific hints left, state right (idle / running · n tools · elapsed / files changed / saved).
- F-key bar: context-relative (see §11). Ctrl+1..0 mirror F1..F10 in web mode.

### Views
- **chat** — message list, tool calls rendered as collapsed one-liners (click/`Space` expands), mentions clickable → open in the other panel. Prompt attached at bottom: multiline (`⇧⏎`), grows to 40% of panel, footer shows `queued` when running. `+` button / `F2` / `@ / #` open the picker.
- **files** — NC list: name, size, date. `↑↓` move, `⏎` open in other panel (dir: enter), `Backspace` up, `Ins` mark, `@` mentions marked set into prompt, `⌃F` filter. Drop zone for upload. Shows `skills/` and `.aicommander/` with subtle labels.
- **editor** — CodeMirror; md with live preview toggle (`⌃E` edit⇄view); `⌃S` save; unsaved marker in tab; external change → warning modal (v2).
- **viewer** — chosen by extension via viewer registry: images/video native; `.stl/.obj/.gltf/.scad` → cad; `.kicad_sch/.kicad_pcb` → circuit; `.csv/.sqlite` → table; pdf → iframe. Viewer can emit `mention.add`.
- **log** — streaming output of a background job or the session's raw events.
- **sql** — table browser for `data.sqlite`, query box.

### Overlays
- **+ picker** — tabs `@ files / skills # tools ! images`, filter, `⏎` attach, `⌃⏎` attach + open in other panel. Shows where each item lands.
- **session navigator / rewind** — `F7` or `Esc Esc`. Groups with token cost; `⏎` continue from here (fork), `t` truncate, `Del` drop group, `x` drop tool outputs, `c` compact above, `/` search.
- **options** — `F5` (v2). Values labelled session/project/global; apply / save as project / save as global.
- **open folder** — `⌃O` (v2). Recents, then filesystem; here / new window / browse. No `.aicommander/` → create + offer gitignore (default no). No git → offer init.
- **modals** — three tiers + input/pick/progress, exactly as v2 §1. Toasts bottom-right, 4s, stack 3.

### Viewer plugin API (self-improve)
```
.aicommander/viewers/<name>/
├── manifest.json   { "name", "match": ["**/*.gcode"], "tools": [ { name, description, schema, "run": "run.js" } ] }
├── index.jsx       default export React component: ({ path, content, url, api }) => JSX; api.mention(text), api.openInOther(path)
└── run.js          optional: tools the viewer contributes (node, sandboxed to repo root)
```
Loaded at startup and on `viewer.install`. The brain can write one, then must append a line to `system.md` describing it. Plugin JSX is transpiled with esbuild-wasm at load; errors show in a warning modal, never crash the panel.

---

## 11. Keymap

<!-- keymap:start -->

*Generated from `apps/web/src/keymap.ts` by `pnpm gen:keymap` — edit the table, not this.*

| key | action | what it does | slash |
|---|---|---|---|
| **panels** | | | |
| `⌘1` | left panel | focus the left panel |  |
| `⌘2` | right panel | focus the right panel |  |
| `⇥` | swap panels | move focus to the other panel |  |
| `⌘B` | collapse | hide the other panel, or bring it back |  |
| `⌘⇧⏎` | maximize | widen this panel to 80%, or restore it |  |
| `⌘0` | even split | put the gutter back in the middle |  |
| `⌘→` | widen | move the gutter right by 5% |  |
| `⌘←` | narrow | move the gutter left by 5% |  |
| `⌘⇥` | next tab | cycle tabs in the focused panel |  |
| `⌘K T` | new tab | open a file manager tab here |  |
| `⌘K W` | close tab | close the active tab |  |
| **open** | | | |
| `⌘/` | help | every key, and what it does | `/help` |
| `⌘K` | menu | sessions, files, and everything else |  |
| `⌘⇧A` | attach | the + picker: files, skills, tools, images | `/attach` |
| `⌘P` | file | fuzzy-find a file; ⏎ here, ⌘⏎ the other panel | `/files` |
| `⌘⇧P` | touched | files this session has read or changed | `/touched` |
| `` | file manager | focus the file manager | `/browse` |
| `⌘O` | open folder | another repo |  |
| `⌘⇧M` | system | edit what the brain is told about the harness | `/system` |
| `⌘I` | context | what the last turn actually sent, layer by layer | `/context` |
| `⌘,` | settings | mode, loop limits, brain | `/model` |
| **session** | | | |
| `⌘K N` | new session | start a conversation in a new tab | `/new` |
| `⌘⇧S` | sessions | switch to another conversation | `/sessions` |
| `⌘K L` | clear | empty this conversation, keeping the session | `/clear` |
| `⌘K R` | rewind | the navigator: fork, truncate, drop a turn | `/rewind` |
| **the loop** | | | |
| `⌘K C` | compact | summarise the older turns to free context | `/compact` |
| `Esc` | cancel | stop the running turn |  |

`⌥1`–`⌥9` selects a tab in the focused panel; the number is printed on the tab.

Chords a browser tab owns — `⌘W`, `⌘N`, `⌘T`, `⌘Q` — cannot be taken, so the actions
that would want them hang off the `⌘K` leader. Tauri adds the direct forms later
without anything being relearned.
<!-- keymap:end -->

Files focused:
```
F2 menu   F3 view   F4 edit   F5 copy   F6 move   F7 mkdir   F8 delete   F9 upload
Ins mark  @ mention marked   ⏎ open in other   Backspace up   ⌃F filter
```
Chat focused:
```
F2 + attach   F3 sessions   F4 system prompt   F5 options   F6 compact   F7 rewind   F8 clear   F9 open ▸
⏎ send   ⇧⏎ newline   Esc cancel loop   Esc Esc rewind   ⌃G git panel in other
```
Editor focused: `⌃S save   ⌃E edit⇄view   F3 back to view   Esc → chat`
Modals: letters shown on buttons; `⏎`/`Esc` per tier contract (§v2).

---

## 12. Milestones (build order for Claude Code)

Each milestone ends with a demo you can run and a checklist. Don't start the next until the checklist passes.

### M0 — "Claude Code in a browser"
- pnpm monorepo, protocol package with zod, backend `serve` with WS, web app shell (single panel, chat only).
- Brain client: streaming, tools, `toolFormat: auto` (OpenAI native, plus text-tag fallback for models without native tool calling).
- Core tools: read/write/edit/glob/grep/shell/git/ask_user.
- session.jsonl + meta.json; reload restores the chat.
- Esc cancel.
- ✅ Open `~/lab/x`, ask "list the files and summarize BUILDME.md", see streaming tool calls, cancel mid-loop, reload page → same session.

### M1 — Commander shell
- Two panels, tabs, gutter, focus, F-key bar (context-relative), status line, top line.
- files view (NC keys, mark, `@`), editor view (CodeMirror, md preview), image viewer.
- auto-open on write + click on mentions.
- workspace.json save/restore (tabs, gutter, focus, marks, prompt draft).
- chokidar → fs.changed → files view refresh.
- ✅ Brain edits a file → it opens in the other panel; you edit NOTES.md while the loop runs; close and reopen → identical layout.

### M2 — Loop hardening
- Guards 1–7 (§6). Background jobs + log view.
- Permission engine + rules.json + danger/warning modals (v2 contract).
- Modes ask/auto/plan. Options modal (session/project/global).
- Snapshots + session navigator (fork/truncate/drop group/drop outputs).
- Compact (manual + auto), clear, queue/steer.
- Modal system: all tiers + input/pick/progress + toasts.
- ✅ `rm -rf` blocked in auto mode; `npm run dev` becomes a job; repeat grep ×3 pauses; rewind restores a deleted file; queued message lands at next tool boundary.

### M3 — Context
- system.md (global template shipped in `packages/core/templates/system.md`), boot sequence, skills index, `list_skills/read_skill`.
- + picker with 4 tabs, mentions in prose, image attachments (vision), file-hash dedupe.
- Context inspector: `F4` alt view showing the assembled layers and token counts (read-only).
- ✅ Attach a skill twice in one session → second time is a reference, not content. Context inspector matches what's sent.

### M4 — Viewers & special tools
- Viewer registry + plugin loader (esbuild-wasm). Built-ins: video, table (csv/sqlite), pdf, cad (three.js + openscad CLI), circuit (kicad-cli svg + part click → mention).
- Special tools: sql (data.sqlite + sql view), comfyui, cad_render, circuit_export.
- Self-improve flow: brain writes a viewer, `viewer.install`, system.md updated.
- ✅ "Open the case in 3D, thicken the wall, re-render" works end to end; "make a viewer for .gcode" produces a working plugin.

### M5 — Desktop
- Tauri 2 shell, backend sidecar, one window per repo, `⌃O` open in new window, recents, desktop notifications, mac + linux builds (dmg, AppImage/deb).
- Bundle `rg`; detect `openscad`, `kicad-cli`, `git` and show an info modal if missing.
- ✅ Fresh machine: install, open folder, run a session, quit, reopen → restored.

---

## 13. Conventions for working on this repo

- **Commit per checklist item**, message `M2: repeat-call guard` style. Never batch a milestone into one commit.
- **Tests**: vitest in `packages/core` for context assembly, permission matching, tool-call repair, snapshot/rewind, output capping. A PR that touches the loop adds a test.
- **Anything reachable through `handleIntent` gets an integration test that drives the real intent, and the test is written first.** Unit tests on the pieces are not enough: a duplicate `case` label once made every rewind clear the session instead, and every unit test still passed. The test must go through `handleIntent` itself.
- UI is tested by `scripts/ui-check.ts` — CDP against a live backend, run after any UI change. Key probes use real `Input.dispatchKeyEvent`; synthetic events are untrusted and editors ignore them.
- **Keys live in `apps/web/src/keymap.ts`** — one table feeds the chords, the slash commands, the key bar, the ⌘/ help overlay and §11 of this file. Run `pnpm gen:keymap` after changing it; `--check` fails when the spec has drifted. ui-check asserts every entry is actually handled.
- **Types first**: change `packages/protocol` before core or web. Both sides import from it; no ad-hoc event shapes.
- **No component libraries, no Tailwind.** Tokens in `apps/web/src/tokens.css` copied from the mockups. If it doesn't look like `v1-commander.html`, it's wrong.
- **Never write outside the repo root** from any tool. Add a test that proves it.
- **`.aicommander/` in this repo** is the dogfood folder; commit it.
- Copy that lands in the UI follows the mockups' voice: sentence case, plain verbs, buttons say what happens ("allow once", not "OK").

---

## 14. CLAUDE.md (drop in repo root)

```md
# AI Commander
Read docs/BUILDME.md first. Mockups in docs/mockups/ are the UI spec — match them.
Current milestone: see docs/PROGRESS.md (update the checklist as you finish items).
Stack: pnpm workspaces · TS · React+Vite · Node 22 · ws · better-sqlite3 · CodeMirror 6 · three.js · Tauri 2.
Rules: types in packages/protocol first; commit per checklist item; tests for anything in the loop; no path escapes repo root; no UI libs.
Run: `pnpm dev` (backend on :7777 + vite), `pnpm test`, `pnpm tauri dev` (M5+).
```

---

## 15. Open (decide while building, not before)

- Native `.kicad_sch` parser vs svg export — start with svg; parser only if part-click UX needs nets.
- Parallel read-only tool calls — cheap win once the loop is stable (M2+), not in v1 spec.
- Sub-agents / sessions spawning sessions — not before M5.
