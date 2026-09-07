import { afterEach, describe, expect, it, vi } from "vitest";
import { installLongPress } from "./long-press";

class TestElement {
  isConnected = true;
  dataset = { longpressfor: "menu", longpress: "show-modal" };
  closest() {
    return this;
  }
  contains(target: unknown) {
    return target === this;
  }
  focus = vi.fn();
}
class TestDialog extends TestElement {
  open = false;
  showModal = vi.fn(() => {
    this.open = true;
  });
}

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("Node", TestElement);
  vi.stubGlobal("HTMLDialogElement", TestDialog);
  const root = new EventTarget();
  const tile = new TestElement();
  const dialog = new TestDialog();
  Object.assign(root, { getElementById: (id: string) => (id === "menu" ? dialog : null) });
  const destroy = installLongPress(root as unknown as Document);
  const dispatch = (type: string, options = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "target", { value: tile });
    Object.assign(
      event,
      { pointerId: 1, clientX: 0, clientY: 0, button: 0, isPrimary: true, detail: 1 },
      options,
    );
    root.dispatchEvent(event);
    return event;
  };
  return { tile, dialog, dispatch, destroy };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("delegated long press", () => {
  it("opens after a hold and suppresses the following navigation click", () => {
    const { dialog, dispatch } = setup();
    dispatch("pointerdown");
    vi.advanceTimersByTime(549);
    expect(dialog.showModal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dialog.showModal).toHaveBeenCalledOnce();
    dispatch("pointerup");
    expect(dispatch("click").defaultPrevented).toBe(true);
  });

  it("leaves short taps alone", () => {
    const { dialog, dispatch } = setup();
    dispatch("pointerdown");
    vi.advanceTimersByTime(100);
    dispatch("pointerup");
    vi.advanceTimersByTime(600);
    expect(dialog.showModal).not.toHaveBeenCalled();
    expect(dispatch("click").defaultPrevented).toBe(false);
  });

  it.each(["pointermove", "pointercancel", "scroll", "visibilitychange"])(
    "cancels on %s",
    (type) => {
      const { dialog, dispatch } = setup();
      dispatch("pointerdown");
      dispatch(type, { clientY: 20 });
      vi.advanceTimersByTime(600);
      expect(dialog.showModal).not.toHaveBeenCalled();
    },
  );

  it("does not intercept keyboard events or open menus through shortcuts", () => {
    const { dialog, dispatch } = setup();
    expect(dispatch("keydown", { key: "Enter" }).defaultPrevented).toBe(false);
    expect(dispatch("keydown", { key: "F10", shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatch("keydown", { key: "ContextMenu" }).defaultPrevented).toBe(false);
    expect(dialog.showModal).not.toHaveBeenCalled();
  });

  it("ignores missing targets and detached triggers", () => {
    const { tile, dialog, dispatch } = setup();
    tile.dataset.longpressfor = "missing";
    dispatch("pointerdown");
    vi.advanceTimersByTime(600);
    tile.dataset.longpressfor = "menu";
    tile.isConnected = false;
    dispatch("pointerdown");
    vi.advanceTimersByTime(600);
    expect(dialog.showModal).not.toHaveBeenCalled();
  });

  it("cleans up pending holds", () => {
    const { dialog, dispatch, destroy } = setup();
    dispatch("pointerdown");
    destroy();
    vi.advanceTimersByTime(600);
    dispatch("pointerdown");
    vi.advanceTimersByTime(600);
    expect(dialog.showModal).not.toHaveBeenCalled();
  });
});
