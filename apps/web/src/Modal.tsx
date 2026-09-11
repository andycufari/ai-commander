import { useEffect, useRef, useState } from "react";

/**
 * The three modal tiers from v2 §1.
 *
 *   info    single line, dim title, no shadow.  ⏎ = the action.      Esc closes.
 *   warning single line amber, amber title.     ⏎ = the SAFE option. Esc cancels.
 *   danger  double red border, shadow, dims the screen. No ⏎ default. Esc denies.
 *
 * The rules that make the tiers legible without reading (v2): the safe button is
 * always the one Esc maps to, letter shortcuts are always shown, and a double border
 * only ever means someone can lose something.
 */

export type Tier = "info" | "warning" | "danger";

export interface ModalButton {
  id: string;
  label: string;
  /** The letter that picks it, shown on the button. */
  letter: string;
  /** The one Enter takes. Never set on a danger modal. */
  isDefault?: boolean;
  /** The one Esc takes — the safe option. */
  isSafe?: boolean;
}

export interface ModalProps {
  tier: Tier;
  title: string;
  /** The body. Pre-wrapped, so a command keeps its shape. */
  children: React.ReactNode;
  buttons: ModalButton[];
  onChoose: (id: string, edited?: string) => void;
  /** Offer an editable copy of `editable` before choosing (danger: "edit"). */
  editable?: string;
}

export function Modal({ tier, title, children, buttons, onChoose, editable }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | undefined>();
  const editRef = useRef<HTMLTextAreaElement>(null);

  const safe = buttons.find((b) => b.isSafe) ?? buttons.find((b) => b.id === "deny") ?? buttons[buttons.length - 1];
  // v2: danger modals have no Enter default. Someone must choose deliberately.
  const fallback = tier === "danger" ? undefined : buttons.find((b) => b.isDefault);

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { if (editing !== undefined) editRef.current?.focus(); }, [editing]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editing !== undefined) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onChoose("once", editing);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setEditing(undefined);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Esc here denies the ask; it must not also reach the window handler and cancel
      // the whole turn, which would throw away the loop along with the one command.
      e.stopPropagation();
      if (safe) onChoose(safe.id);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (fallback) onChoose(fallback.id);
      return;
    }
    if (editable !== undefined && e.key.toLowerCase() === "e") {
      e.preventDefault();
      setEditing(editable);
      return;
    }
    const hit = buttons.find((b) => b.letter.toLowerCase() === e.key.toLowerCase());
    if (hit) {
      e.preventDefault();
      onChoose(hit.id);
    }
  };

  return (
    <div className={`modal-scrim ${tier === "danger" ? "dim" : ""}`}>
      <div
        className={`modal ${tier}`}
        role="alertdialog"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onKeyDown={onKeyDown}
      >
        <span className="t">{title}</span>
        <div className="modal-body">{children}</div>

        {editing !== undefined ? (
          <textarea
            ref={editRef}
            className="modal-edit"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={2}
            spellCheck={false}
            aria-label="edit the command"
          />
        ) : null}

        <div className="modal-buttons">
          {buttons.map((b) => (
            <span
              key={b.id}
              className={`btn${b.isDefault && tier !== "danger" ? " on" : ""}`}
              onClick={() => onChoose(b.id)}
            >
              <b>{b.letter}</b>{b.label}
            </span>
          ))}
          {editable !== undefined && editing === undefined && (
            <span className="btn" onClick={() => setEditing(editable)}><b>e</b>edit</span>
          )}
        </div>
        <div className="k">
          {editing !== undefined
            ? "⏎ run edited · Esc back"
            : tier === "danger"
              ? `Esc ${safe?.label ?? "deny"} · no default`
              : `⏎ ${fallback?.label ?? "ok"} · Esc ${safe?.label ?? "close"}`}
        </div>
      </div>
    </div>
  );
}
