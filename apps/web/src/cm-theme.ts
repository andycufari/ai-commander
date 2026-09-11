import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror theme built from tokens.css — every colour is a var(), so the editor
 * cannot drift from the rest of the shell (§13: if it doesn't look like the mockups,
 * it's wrong).
 */

const theme = EditorView.theme({
  "&": {
    color: "var(--ink)",
    backgroundColor: "transparent",
    height: "100%",
    fontSize: "inherit",
  },
  ".cm-content": {
    fontFamily: "var(--mono)",
    padding: "0",
    caretColor: "var(--hi)",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--hi)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--sel)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--dim)",
    border: "none",
    paddingRight: "8px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--hi)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 3px 0 8px" },
  // Search panel, styled as a ratatui strip rather than CodeMirror's default chrome.
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "none" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--sel)", outline: "1px solid var(--line)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--sel)", outline: "1px solid var(--hi)" },
  ".cm-panel input, .cm-panel button": {
    fontFamily: "var(--mono)",
    fontSize: "inherit",
    background: "var(--bg)",
    color: "var(--ink)",
    border: "1px solid var(--line)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--sel)" },
  ".cm-foldPlaceholder": { background: "var(--sel)", color: "var(--dim)", border: "none" },
}, { dark: true });

/** Phosphor-and-amber highlighting: the brain speaks in amber, so code does too. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--hi)" },
  { tag: [t.string, t.special(t.string)], color: "var(--amber)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--dim)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--amber)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--ink)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--hi)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--ink)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--dim)" },
  { tag: [t.invalid], color: "var(--red)" },
  // markdown
  { tag: [t.heading], color: "var(--hi)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--amber)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600", color: "var(--ink)" },
  { tag: [t.monospace], color: "var(--amber)" },
  { tag: [t.quote], color: "var(--dim)" },
  { tag: [t.list], color: "var(--dim)" },
]);

export const commanderTheme: Extension = [theme, syntaxHighlighting(highlight)];
