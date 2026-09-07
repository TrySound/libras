export function installLongPress(root: Document = document) {
  const selector = "[data-longpressfor][data-longpress]";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trigger: HTMLElement | undefined;
  let pointerId: number | undefined;
  let x = 0;
  let y = 0;
  let suppressed: HTMLElement | undefined;
  let suppressUntil = 0;

  const find = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>(selector) : null;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    trigger = undefined;
    pointerId = undefined;
  };

  const invoke = (element: HTMLElement) => {
    if (!element.isConnected) return false;
    const target = root.getElementById(element.dataset.longpressfor ?? "");
    if (!(target instanceof HTMLDialogElement) || element.dataset.longpress !== "show-modal")
      return false;
    if (!target.open) {
      element.focus({ preventScroll: true });
      target.showModal();
    }
    return true;
  };

  const down = (event: PointerEvent) => {
    if (pointerId !== undefined) {
      cancel();
      return;
    }
    if (!event.isPrimary || event.button !== 0) return;
    const element = find(event.target);
    if (!element) return;
    trigger = element;
    pointerId = event.pointerId;
    x = event.clientX;
    y = event.clientY;
    timer = setTimeout(() => {
      const element = trigger;
      cancel();
      if (element && invoke(element)) {
        suppressed = element;
        suppressUntil = Date.now() + 1500;
      }
    }, 550);
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId === pointerId && Math.hypot(event.clientX - x, event.clientY - y) > 10)
      cancel();
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel();
    if (suppressed) suppressUntil = Date.now() + 750;
  };
  const click = (event: MouseEvent) => {
    if (
      event.detail !== 0 &&
      Date.now() < suppressUntil &&
      event.target instanceof Node &&
      suppressed?.contains(event.target)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressed = undefined;
    }
  };
  const context = (event: MouseEvent) => {
    const element = find(event.target);
    if (element) event.preventDefault();
  };

  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  root.addEventListener("click", click, true);
  root.addEventListener("contextmenu", context);
  root.addEventListener("scroll", cancel, true);
  root.addEventListener("visibilitychange", cancel);

  return () => {
    cancel();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", end);
    root.removeEventListener("pointercancel", end);
    root.removeEventListener("click", click, true);
    root.removeEventListener("contextmenu", context);
    root.removeEventListener("scroll", cancel, true);
    root.removeEventListener("visibilitychange", cancel);
  };
}
