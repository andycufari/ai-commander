import { BINDINGS, GROUPS, hint } from "./keymap.js";
import { useModalLock } from "./modal-stack.js";

/**
 * The help overlay (⌘/) — rendered straight from keymap.ts.
 *
 * Nothing here is written by hand, so a binding cannot be missing from the help or
 * described as something it no longer does. Adding a row to the keymap adds it here.
 */

export interface HelpProps {
  onRun: (id: string) => void;
  onClose: () => void;
}

export function Help({ onRun, onClose }: HelpProps): JSX.Element {
  useModalLock();

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal info help"
        role="dialog"
        aria-label="keys"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <span className="t">keys</span>
        <div className="help-cols">
          {GROUPS.map((group) => (
            <div key={group.id} className="help-group">
              <div className="help-head">{group.label}</div>
              {BINDINGS.filter((b) => b.group === group.id).map((b) => (
                <div
                  key={b.id}
                  className="help-row"
                  onMouseDown={(e) => { e.preventDefault(); onClose(); onRun(b.id); }}
                >
                  <span className="help-chord">{hint(b)}</span>
                  <span className="help-label">{b.label}</span>
                  <span className="help-describe">{b.describe}</span>
                  {b.command && <span className="help-command">/{b.command}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="k">click a row to run it · Esc close</div>
      </div>
    </div>
  );
}
