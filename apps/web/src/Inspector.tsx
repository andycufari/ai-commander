import type { Layer } from "./ws.js";

/**
 * §12 M3 — the context inspector.
 *
 * What was actually assembled and sent, layer by layer. Read-only on purpose: the point
 * is to answer "why does it think that?", and a screen you can edit invites you to fix
 * the symptom instead of the cause.
 *
 * Token counts come from the endpoint's own usage field. A local estimate would be a
 * different number from the one that matters, and being confidently wrong about the
 * context budget is worse than saying nothing.
 */

export interface InspectorProps {
  layers: readonly Layer[];
  /** From the endpoint's usage on the last turn. */
  promptTokens?: number;
  ctxMax: number;
  focused: boolean;
}

const bar = (fraction: number, width = 24): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"█".repeat(filled)}${"·".repeat(width - filled)}`;
};

export function Inspector({ layers, promptTokens, ctxMax, focused }: InspectorProps): JSX.Element {
  const totalChars = layers.reduce((n, l) => n + l.chars, 0);

  return (
    <>
      <div className="body inspector" tabIndex={0}>
        {layers.length === 0 ? (
          <div className="dim">nothing assembled yet — send a turn</div>
        ) : (
          <>
            <div className="insp-head">
              <span className="insp-name">layer</span>
              <span className="insp-bar" />
              <span className="insp-size">chars</span>
              <span className="insp-share">share</span>
            </div>
            {layers.map((layer) => {
              const share = totalChars > 0 ? layer.chars / totalChars : 0;
              return (
                <div key={layer.name} className="insp-row">
                  <span className="insp-name">{layer.name}</span>
                  <span className="insp-bar">{bar(share)}</span>
                  <span className="insp-size">{layer.chars.toLocaleString()}</span>
                  <span className="insp-share">{Math.round(share * 100)}%</span>
                  {layer.detail && <span className="insp-detail">{layer.detail}</span>}
                </div>
              );
            })}
            <div className="insp-total">
              <span className="insp-name">total</span>
              <span className="insp-bar" />
              <span className="insp-size">{totalChars.toLocaleString()}</span>
            </div>
            <div className="insp-tokens">
              {promptTokens === undefined ? (
                <span className="dim">
                  token counts arrive with the endpoint's usage on the next turn
                </span>
              ) : (
                <>
                  <span className="hi">{promptTokens.toLocaleString()}</span>
                  {" prompt tokens"}
                  <span className="dim">{" · reported by the endpoint, not estimated"}</span>
                  <div className="insp-ctx">
                    {bar(promptTokens / ctxMax, 32)} {Math.round((promptTokens / ctxMax) * 100)}%
                    {" of "}{Math.round(ctxMax / 1000)}k
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
      <div className="tb insp-tb">read-only · what the last turn sent</div>
    </>
  );
}
