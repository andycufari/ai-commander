import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetModalStack, modalOpen, onModalChange, pushModal, unlessModal,
} from "../src/modal-stack.js";

/** While a modal is up, only the modal stack receives keys. */

beforeEach(() => __resetModalStack());

describe("modal stack", () => {
  it("is closed to begin with", () => {
    expect(modalOpen()).toBe(false);
  });

  it("opens and closes", () => {
    const release = pushModal();
    expect(modalOpen()).toBe(true);
    release();
    expect(modalOpen()).toBe(false);
  });

  it("nests: an inner modal closing does not unblock the outer one", () => {
    // A pick opened from a modal must not hand the keyboard back on its own close.
    const outer = pushModal();
    const inner = pushModal();
    inner();
    expect(modalOpen()).toBe(true);
    outer();
    expect(modalOpen()).toBe(false);
  });

  it("releasing twice is harmless", () => {
    const release = pushModal();
    release();
    release();
    expect(modalOpen()).toBe(false);
  });

  it("never goes negative", () => {
    const stray = pushModal();
    stray();
    stray();
    const real = pushModal();
    expect(modalOpen()).toBe(true);
    real();
    expect(modalOpen()).toBe(false);
  });

  it("notifies listeners on change", () => {
    const seen: boolean[] = [];
    const off = onModalChange((open) => seen.push(open));
    const release = pushModal();
    release();
    off();
    expect(seen).toEqual([true, false]);
  });
});

describe("unlessModal", () => {
  it("passes events through when nothing is open", () => {
    const handler = vi.fn();
    unlessModal(handler)("key");
    expect(handler).toHaveBeenCalledWith("key");
  });

  it("swallows events while a modal is up", () => {
    const handler = vi.fn();
    const wrapped = unlessModal(handler);
    const release = pushModal();
    wrapped("key");
    expect(handler).not.toHaveBeenCalled();
    release();
    wrapped("key");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("stays blocked while any modal remains", () => {
    const handler = vi.fn();
    const wrapped = unlessModal(handler);
    const outer = pushModal();
    const inner = pushModal();
    inner();
    wrapped("key");
    expect(handler).not.toHaveBeenCalled();
    outer();
    wrapped("key");
    expect(handler).toHaveBeenCalledOnce();
  });
});
