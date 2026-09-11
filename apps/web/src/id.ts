/** crypto.randomUUID needs a secure context; a short random id is enough for intent ids. */
export const randomUUID = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);
