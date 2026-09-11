# AI Commander
Read docs/BUILDME.md first. Mockups in docs/mockups/ are the UI spec — match them.
Current milestone: see docs/PROGRESS.md (update the checklist as you finish items).
Stack: pnpm workspaces · TS · React+Vite · Node 22 · ws · better-sqlite3 · CodeMirror 6 · three.js · Tauri 2.
Rules: types in packages/protocol first; commit per checklist item; tests for anything in the loop; no path escapes repo root; no UI libs.
Run: `pnpm dev` (backend on :7777 + vite), `pnpm test`, `pnpm tauri dev` (M5+).
