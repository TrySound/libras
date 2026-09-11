import { afterEach, describe, expect, it, vi } from "vitest";
import { swipeToDismiss } from "../src/swipe-to-dismiss";

class TestElement extends EventTarget {
  open = true;
  scrollTop = 0;
  parentElement = null;
  input = false;
  attributes = new Set<string>();
  values = new Map<string, string>();
  style = {
    setProperty: (key: string, value: string) => this.values.set(key, value),
    removeProperty: (key: string) => this.values.delete(key),
  };
  closest() {
    return this.input ? this : null;
  }
  contains(target: unknown) {
    return target === this;
  }
  getBoundingClientRect() {
    return { height: 500 };
  }
  setAttribute(name: string) {
    this.attributes.add(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  close = vi.fn(() => {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
}

function setup() {
  vi.stubGlobal("Element", TestElement);
  const dialog = new TestElement();
  const action = swipeToDismiss(dialog as unknown as HTMLDialogElement);
  const touch = (type: string, y: number, x = 0) => {
    const event = new Event(type, { cancelable: true });
    const point = { clientY: y, clientX: x, identifier: 1 };
    Object.assign(event, { touches: [point], changedTouches: [point] });
    dialog.dispatchEvent(event);
    return event;
  };
  return { dialog, action, touch };
}

afterEach(() => vi.unstubAllGlobals());

describe("swipe to dismiss", () => {
  it("only closes on release after the threshold", () => {
    const { dialog, touch } = setup();
    touch("touchstart", 10);
    expect(touch("touchmove", 150).defaultPrevented).toBe(true);
    expect(dialog.values.get("--swipe-offset")).toBe("140px");
    expect(dialog.close).not.toHaveBeenCalled();
    touch("touchend", 150);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(dialog.values.has("--swipe-offset")).toBe(false);
  });

  it("snaps back if the finger returns below the threshold", () => {
    const { dialog, touch } = setup();
    touch("touchstart", 10);
    touch("touchmove", 150);
    touch("touchend", 40);
    expect(dialog.close).not.toHaveBeenCalled();
    expect(dialog.attributes.has("data-dragging")).toBe(false);
    expect(dialog.values.has("--swipe-offset")).toBe(false);
  });

  it("cancels without closing even beyond the threshold", () => {
    const { dialog, touch } = setup();
    touch("touchstart", 0);
    touch("touchmove", 200);
    touch("touchcancel", 200);
    expect(dialog.close).not.toHaveBeenCalled();
    expect(dialog.values.has("--swipe-offset")).toBe(false);
  });

  it("preserves scrolling when not at the top", () => {
    const { dialog, touch } = setup();
    dialog.scrollTop = 100;
    touch("touchstart", 0);
    expect(touch("touchmove", 200).defaultPrevented).toBe(false);
    touch("touchend", 200);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("preserves input gestures", () => {
    const { dialog, touch } = setup();
    dialog.input = true;
    touch("touchstart", 0);
    expect(touch("touchmove", 200).defaultPrevented).toBe(false);
    touch("touchend", 200);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("does not claim upward or horizontal gestures", () => {
    const { dialog, touch } = setup();
    touch("touchstart", 100);
    expect(touch("touchmove", 50).defaultPrevented).toBe(false);
    touch("touchend", 300);
    touch("touchstart", 0);
    expect(touch("touchmove", 20, 80).defaultPrevented).toBe(false);
    touch("touchend", 300);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("suppresses control activation after a drag but not normal taps", () => {
    const { dialog, touch } = setup();
    touch("touchstart", 0);
    touch("touchmove", 40);
    touch("touchend", 40);
    const click = new Event("click", { cancelable: true });
    Object.assign(click, { detail: 1 });
    dialog.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const tap = new Event("click", { cancelable: true });
    Object.assign(tap, { detail: 1 });
    dialog.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
  });

  it("cleans up on destroy", () => {
    const { dialog, touch, action } = setup();
    touch("touchstart", 0);
    touch("touchmove", 200);
    action.destroy();
    touch("touchend", 200);
    expect(dialog.close).not.toHaveBeenCalled();
    expect(dialog.values.has("--swipe-offset")).toBe(false);
  });
});
