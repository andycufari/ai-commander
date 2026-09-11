import { useEffect, useMemo, useRef, useState } from "react";
import type { Config, OptionsScope } from "@aicommander/protocol";
import { useModalLock } from "./modal-stack.js";

/**
 * §10 options modal — the v2 form.
 *
 * Every value says where it came from (session, project, global, or a built-in
 * default), because the question you actually have in front of a settings screen is
 * "why is it this?" — and with three overlapping scopes that is unanswerable unless
 * the screen tells you.
 *
 * Danger rules are shown but not editable. §0 principle 3 is not a setting.
 */

export type Origin = "session" | "project" | "global" | "default";

export interface OptionRow {
  key: string;
  label: string;
  value: string;
  /** Choices, for a row that toggles through values. */
  choices?: string[];
  origin: Origin;
  hint?: string;
  /** Rows that explain rather than configure. */
  readOnly?: boolean;
  section: string;
}

export interface OptionsProps {
  config: Config;
  /** Which scope an edit writes to. */
  scope: OptionsScope;
  onScope: (scope: OptionsScope) => void;
  onChange: (key: string, value: string) => void;
  onClose: () => void;
}

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function optionRows(config: Config, sessionOverrides: Set<string>): OptionRow[] {
  const origin = (key: string, fallback: Origin = "default"): Origin =>
    sessionOverrides.has(key) ? "session" : fallback;

  return [
    {
      section: "mode", key: "mode", label: "mode", value: config.mode,
      choices: ["ask", "auto", "plan"], origin: origin("mode", "project"),
      hint: "ask = every write asks · auto = only rules ask · plan = read-only",
    },
    {
      section: "mode", key: "danger", label: "danger rules", value: "always block",
      origin: "default", readOnly: true, hint: "not configurable",
    },
    {
      section: "loop", key: "loop.maxToolCallsPerTurn", label: "max tool calls / turn",
      value: String(config.loop.maxToolCallsPerTurn), origin: origin("loop.maxToolCallsPerTurn"),
    },
    {
      section: "loop", key: "loop.maxTurnsPerPrompt", label: "max turns / prompt",
      value: String(config.loop.maxTurnsPerPrompt), origin: origin("loop.maxTurnsPerPrompt"),
    },
    {
      section: "loop", key: "loop.shellTimeoutSec", label: "shell timeout",
      value: `${config.loop.shellTimeoutSec}s`, origin: origin("loop.shellTimeoutSec"),
      hint: "longer = background job",
    },
    {
      section: "loop", key: "loop.toolOutputCap", label: "tool output cap",
      value: `${k(config.loop.toolOutputCap)} chars`, origin: origin("loop.toolOutputCap"),
      hint: "full output saved to .aicommander/out/",
    },
    {
      section: "loop", key: "loop.repeatGuard", label: "repeat-call guard",
      value: String(config.loop.repeatGuard), origin: origin("loop.repeatGuard"),
      hint: "same tool+args → pause and ask",
    },
    {
      section: "loop", key: "loop.errorGuard", label: "consecutive errors",
      value: String(config.loop.errorGuard), origin: origin("loop.errorGuard"),
      hint: "→ pause and ask",
    },
    {
      section: "budget", key: "context.autoCompactAt", label: "auto-compact at",
      value: `${Math.round(config.context.autoCompactAt * 100)}% ctx`,
      origin: origin("context.autoCompactAt"),
    },
    {
      section: "budget", key: "context.keepLastGroups", label: "keep last turns",
      value: String(config.context.keepLastGroups), origin: origin("context.keepLastGroups"),
      hint: "never summarised",
    },
    {
      section: "budget", key: "notify", label: "notify when loop ends",
      value: config.notify ? "on" : "off", choices: ["on", "off"], origin: origin("notify"),
    },
    {
      section: "brain", key: "brain.model", label: "model", value: config.brain.model,
      origin: origin("brain.model", "project"),
    },
    {
      section: "brain", key: "brain.endpoint", label: "endpoint", value: config.brain.endpoint,
      origin: origin("brain.endpoint", "project"),
    },
    {
      section: "brain", key: "brain.temperature", label: "temperature",
      value: String(config.brain.temperature), origin: origin("brain.temperature"),
    },
    {
      section: "brain", key: "brain.ctx", label: "context window",
      value: k(config.brain.ctx), origin: origin("brain.ctx"),
      hint: "adopted from the endpoint when it says",
    },
  ];
}

const SCOPES: OptionsScope[] = ["session", "project", "global"];

export function Options({ config, scope, onScope, onChange, onClose }: OptionsProps): JSX.Element {
  useModalLock();
  const rows = useMemo(() => optionRows(config, new Set()), [config]);
  const editable = rows.filter((r) => !r.readOnly);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const current = editable[cursor];

  const cycle = (delta: number): void => {
    if (!current?.choices) return;
    const i = current.choices.indexOf(current.value);
    const next = current.choices[(i + delta + current.choices.length) % current.choices.length]!;
    onChange(current.key, next);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setCursor((c) => Math.min(editable.length - 1, c + 1)); return;
      case "ArrowUp": e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return;
      case "ArrowRight": case " ": e.preventDefault(); cycle(1); return;
      case "ArrowLeft": e.preventDefault(); cycle(-1); return;
      case "Tab": {
        e.preventDefault();
        const i = SCOPES.indexOf(scope);
        onScope(SCOPES[(i + (e.shiftKey ? -1 : 1) + SCOPES.length) % SCOPES.length]!);
        return;
      }
      case "Escape": e.preventDefault(); e.stopPropagation(); onClose(); return;
      default: return;
    }
  };

  let lastSection = "";
  let editableIndex = -1;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal info options"
        role="dialog"
        aria-label="options"
        tabIndex={-1}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="t">options · writing to {scope}</span>
        <div className="opt-scopes">
          {SCOPES.map((s) => (
            <span
              key={s}
              className={s === scope ? "opt-scope on" : "opt-scope"}
              onMouseDown={(e) => { e.preventDefault(); onScope(s); }}
            >{s}</span>
          ))}
        </div>
        <div className="opt-list">
          {rows.map((row) => {
            const header = row.section !== lastSection ? row.section : undefined;
            lastSection = row.section;
            if (!row.readOnly) editableIndex += 1;
            const selected = !row.readOnly && editableIndex === cursor;
            return (
              <div key={row.key}>
                {header && <div className="opt-section">{header}</div>}
                <div
                  className={`opt-row${selected ? " sel" : ""}${row.readOnly ? " ro" : ""}`}
                  onMouseMove={() => { if (!row.readOnly) setCursor(rows.filter((r) => !r.readOnly).indexOf(row)); }}
                >
                  <span className="opt-label">{row.label}</span>
                  <span className="opt-value">
                    {row.choices
                      ? row.choices.map((c) => (
                          <span key={c} className={c === row.value ? "on" : "off"}>
                            {c === row.value ? `[${c}]` : c}
                          </span>
                        ))
                      : row.value}
                  </span>
                  <span className="opt-origin">{row.origin === "default" ? "" : row.origin}</span>
                  <span className="opt-hint">{row.hint}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="k">↑↓ move · ←→ change · ⇥ scope · Esc close</div>
      </div>
    </div>
  );
}
