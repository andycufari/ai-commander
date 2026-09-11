/**
 * Ask an OpenAI-compatible endpoint what it serves.
 *
 * Used when `--brain` is given without `--model`: if the box offers exactly one model
 * we adopt it, which is the common case for a single llama.cpp or vLLM process. Anything
 * else (zero, several, or an unreachable endpoint) leaves the configured model alone —
 * guessing between several would be worse than using what the config already says.
 */
export interface Discovery {
  ids: string[];
  /** Context length the endpoint reports for a model, when it says (llama.cpp does). */
  ctx?: number;
  /** Set when the endpoint could not be asked; not an error, just unknown. */
  error?: string;
}

export async function listModels(endpoint: string, apiKey = "", timeoutMs = 4000): Promise<Discovery> {
  const url = `${endpoint.replace(/\/+$/, "")}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) return { ids: [], error: `${res.status} ${res.statusText}` };
    const body = (await res.json()) as Record<string, unknown>;

    // OpenAI shape is { data: [{ id }] }; llama.cpp also sends { models: [{ name }] }.
    const rows = [
      ...((body.data as Record<string, unknown>[] | undefined) ?? []),
      ...((body.models as Record<string, unknown>[] | undefined) ?? []),
    ];
    const ids: string[] = [];
    for (const row of rows) {
      const id = row.id ?? row.name ?? row.model;
      if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
    }
    // llama.cpp reports the loaded context in meta.n_ctx; adopting it means the ctx
    // gauge is right without hand-editing config for every box.
    let ctx: number | undefined;
    for (const row of rows) {
      const meta = row.meta as Record<string, unknown> | undefined;
      const n = meta?.n_ctx ?? (row as Record<string, unknown>).n_ctx;
      if (typeof n === "number" && n > 0) {
        ctx = n;
        break;
      }
    }
    return { ids, ctx };
  } catch (err) {
    return { ids: [], error: (err as Error).name === "AbortError" ? "timed out" : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
