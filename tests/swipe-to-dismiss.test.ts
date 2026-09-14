// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSwipeToDismiss } from "../src/swipe-to-dismiss";

const cleanups: (() => void)[] = [];
function setup() {
  const destroy = installSwipeToDismiss();
  cleanups.push(destroy);
  // Dialogs mounted after installation need no per-element setup.
  const dialog = document.createElement("dialog");
  dialog.dataset.swipedown = "close";
  dialog.open = true;
  const button = document.createElement("button");
  dialog.append(button);
  document.body.append(dialog);
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ height: 500 } as DOMRect);
  const close = vi.spyOn(dialog, "close").mockImplementation(() => {
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
  });
  const touch = (
    type: string,
    y: number,
    x = 0,
    target: EventTarget = button,
    cancelable = true,
    count = 1,
  ) => {
    const event = new Event(type, { bubbles: true, cancelable });
    const point = { clientY: y, clientX: x, identifier: 1 };
    Object.assign(event, { touches: Array(count).fill(point), changedTouches: [point] });
    target.dispatchEvent(event);
    return event;
  };
  return { dialog, button, close, destroy, touch };
}

function click(target: EventTarget, detail = 1) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("global swipe down to dismiss", () => {
  it("delegates from descendants and only closes on release after the threshold", () => {
    const { dialog, touch, close } = setup();
    touch("touchstart", 10);
    expect(touch("touchmove", 150).defaultPrevented).toBe(true);
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("140px");
    expect(close).not.toHaveBeenCalled();
    touch("touchend", 150);
    expect(close).toHaveBeenCalledOnce();
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("");
  });

  it.each(["unmarked", "unsupported", "closed", "outside"])("ignores %s targets", (kind) => {
    const { dialog, button, touch, close } = setup();
    if (kind === "unmarked") delete dialog.dataset.swipedown;
    if (kind === "unsupported") dialog.dataset.swipedown = "show-modal";
    if (kind === "closed") dialog.open = false;
    const target = kind === "outside" ? document.body : button;
    touch("touchstart", 0, 0, target);
    expect(touch("touchmove", 200, 0, target).defaultPrevented).toBe(false);
    touch("touchend", 200, 0, target);
    expect(close).not.toHaveBeenCalled();
  });

  it("snaps back if the finger returns below the threshold", () => {
    const { dialog, touch, close } = setup();
    touch("touchstart", 10);
    touch("touchmove", 150);
    touch("touchend", 40);
    expect(close).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("data-dragging")).toBe(false);
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("");
  });

  it("cancels without closing even beyond the threshold", () => {
    const { dialog, touch, close } = setup();
    touch("touchstart", 0);
    touch("touchmove", 200);
    touch("touchcancel", 200);
    expect(close).not.toHaveBeenCalled();
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("");
  });

  it.each(["dialog", "child"])("preserves scrolling when %s is not at the top", (kind) => {
    const { dialog, button, touch, close } = setup();
    (kind === "dialog" ? dialog : button).scrollTop = 100;
    touch("touchstart", 0);
    expect(touch("touchmove", 200).defaultPrevented).toBe(false);
    touch("touchend", 200);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "select", "[contenteditable]"])("preserves %s gestures", (kind) => {
    const { dialog, touch, close } = setup();
    const input = document.createElement(kind === "[contenteditable]" ? "div" : kind);
    if (kind === "[contenteditable]") input.setAttribute("contenteditable", "true");
    dialog.append(input);
    touch("touchstart", 0, 0, input);
    expect(touch("touchmove", 200, 0, input).defaultPrevented).toBe(false);
    touch("touchend", 200, 0, input);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not claim upward or horizontal gestures", () => {
    const { touch, close } = setup();
    touch("touchstart", 100);
    expect(touch("touchmove", 50).defaultPrevented).toBe(false);
    touch("touchend", 300);
    touch("touchstart", 0);
    expect(touch("touchmove", 20, 80).defaultPrevented).toBe(false);
    touch("touchend", 300);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["multitouch", "native"])("cancels when %s takes over", (kind) => {
    const { button, dialog, touch, close } = setup();
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchmove", 200, 0, button, kind !== "native", kind === "multitouch" ? 2 : 1);
    touch("touchend", 200);
    expect(close).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("data-dragging")).toBe(false);
  });

  it("suppresses activation only in the dragged dialog, not keyboard clicks or normal taps", () => {
    const { button, touch } = setup();
    const other = document.createElement("dialog");
    const otherButton = document.createElement("button");
    other.append(otherButton);
    document.body.append(other);
    touch("touchstart", 0);
    touch("touchmove", 40);
    touch("touchend", 40);
    expect(click(otherButton).defaultPrevented).toBe(false);
    expect(click(button, 0).defaultPrevented).toBe(false);
    expect(click(button).defaultPrevented).toBe(true);
    expect(click(button).defaultPrevented).toBe(false);
  });

  it("expires click suppression", () => {
    const { button, touch } = setup();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    touch("touchstart", 0);
    touch("touchmove", 40);
    touch("touchend", 40);
    vi.mocked(Date.now).mockReturnValue(2000);
    expect(click(button).defaultPrevented).toBe(false);
  });

  it.each(["close", "remove", "hidden"])("resets an active gesture on %s", (kind) => {
    const { dialog, touch, close } = setup();
    touch("touchstart", 0);
    touch("touchmove", 200);
    if (kind === "close") dialog.close();
    if (kind === "remove") dialog.remove();
    if (kind === "hidden") document.dispatchEvent(new Event("visibilitychange"));
    close.mockClear();
    touch("touchend", 200, 0, document);
    expect(close).not.toHaveBeenCalled();
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("");
  });

  it("cleans up listeners, drag styling and click suppression", () => {
    const { dialog, button, touch, close, destroy } = setup();
    touch("touchstart", 0);
    touch("touchmove", 200);
    destroy();
    touch("touchend", 200);
    expect(close).not.toHaveBeenCalled();
    expect(dialog.style.getPropertyValue("--swipe-offset")).toBe("");
    expect(click(button).defaultPrevented).toBe(false);
    touch("touchstart", 0);
    expect(touch("touchmove", 200).defaultPrevented).toBe(false);
  });
});
