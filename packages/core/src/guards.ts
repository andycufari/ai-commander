/**
 * §6 loop guards.
 *
 * These exist because a model in a loop fails by repeating itself, not by stopping.
 * Each guard notices a shape of stuck-ness and hands control back to the user rather
 * than burning the context window discovering the same thing forty times.
 */

/**
 * Guard 1: the repeat-call fingerprint.
 *
 * Normalised so that cosmetic differences do not read as progress — the same grep with
 * different whitespace, or the same object with its keys in another order, is still the
 * same call. Without the normalisation a model that reformats its own arguments looks
 * like it is trying something new every time.
 */
export function fingerprint(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Trimmed and whitespace-collapsed: "grep  foo" and "grep foo" are one call.
    return typeof value === "string"
      ? JSON.stringify(value.trim().replace(/\s+/g, " "))
      : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Guard 1 state: identical calls in a row, within one group. */
export class RepeatGuard {
  private last: string | undefined;
  private count = 0;

  constructor(private readonly limit: number) {}

  /** Returns true when this call has now repeated `limit` times and should pause. */
  record(name: string, args: Record<string, unknown>): boolean {
    const print = fingerprint(name, args);
    if (print === this.last) {
      this.count += 1;
    } else {
      // A different call means progress; the counter starts over.
      this.last = print;
      this.count = 1;
    }
    return this.count >= this.limit;
  }

  /** After the user says continue, the same call should not pause again immediately. */
  forgive(): void {
    this.count = 0;
  }

  get repeats(): number {
    return this.count;
  }
}

/** Guard 2 state: tool errors in a row. Any success clears it. */
export class ErrorGuard {
  private count = 0;

  constructor(private readonly limit: number) {}

  /** Returns true when the run of failures has reached the limit. */
  record(ok: boolean): boolean {
    if (ok) {
      this.count = 0;
      return false;
    }
    this.count += 1;
    return this.count >= this.limit;
  }

  forgive(): void {
    this.count = 0;
  }

  get errors(): number {
    return this.count;
  }
}

/**
 * Guard 3: cap tool output, head 60% / tail 40%, with the omission marked in the text
 * so neither the model nor the reader mistakes a truncated result for a complete one.
 */
export interface CappedOutput {
  content: string;
  outputPath?: string;
  truncated: boolean;
  omitted: number;
}

export function capText(text: string, cap: number, outPath: string): CappedOutput {
  if (text.length <= cap) return { content: text, truncated: false, omitted: 0 };
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  const omitted = text.length - head - tail;
  return {
    content:
      `${text.slice(0, head)}\n\n[… ${omitted} chars omitted → ${outPath}]\n\n${text.slice(-tail)}`,
    outputPath: outPath,
    truncated: true,
    omitted,
  };
}
