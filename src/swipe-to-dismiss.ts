export function installSwipeToDismiss(root: Document = document) {
  let dialog: HTMLDialogElement | undefined;
  let touchId: number | undefined;
  let startX = 0;
  let startY = 0;
  let horizontal = false;
  let dragging = false;
  let threshold = 96;
  let suppressed: HTMLDialogElement | undefined;
  let suppressClickUntil = 0;

  const reset = () => {
    touchId = undefined;
    dragging = false;
    dialog?.removeAttribute("data-dragging");
    dialog?.style.removeProperty("--swipe-offset");
    dialog = undefined;
  };

  const start = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const target = event.target.closest("dialog");
    if (!(target instanceof HTMLDialogElement) || !target.open) return;
    const down = target.dataset.swipedown === "close";
    const right = target.dataset.swiperight === "close";
    // Each dialog opts into exactly one dismissal direction.
    if (down === right) return;
    horizontal = right;
    // Inputs keep their native gestures, including the playback seek slider.
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;

    // Do not steal a gesture from content that can still scroll toward its start.
    for (let node: Element | null = event.target; node; node = node.parentElement) {
      if ((horizontal ? node.scrollLeft : node.scrollTop) > 0) return;
      if (node === target) break;
    }

    const touch = event.touches[0];
    dialog = target;
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    const bounds = dialog.getBoundingClientRect();
    threshold = Math.max(72, Math.min(160, (horizontal ? bounds.width : bounds.height) * 0.2));
  };

  const move = (event: TouchEvent) => {
    if (touchId === undefined || !dialog) return;
    if (!dialog.isConnected || !dialog.open || event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = Array.from(event.touches).find((touch) => touch.identifier === touchId);
    if (!touch) return;
    const dy = touch.clientY - startY;
    const dx = touch.clientX - startX;
    const distance = horizontal ? dx : dy;
    const perpendicular = horizontal ? dy : dx;
    if (!dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      // Once scrolling or a different direction wins, leave the rest of it native.
      if (distance <= 0 || Math.abs(perpendicular) >= distance) {
        reset();
        return;
      }
    }
    if (!event.cancelable) {
      reset();
      return;
    }
    event.preventDefault();
    dragging = true;
    suppressed = dialog;
    suppressClickUntil = Date.now() + 750;
    dialog.setAttribute("data-dragging", "");
    dialog.style.setProperty("--swipe-offset", `${Math.max(0, distance)}px`);
  };

  const end = (event: TouchEvent) => {
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === touchId);
    if (!touch || !dialog) return;
    const target = dialog;
    const distance = horizontal ? touch.clientX - startX : touch.clientY - startY;
    const dismiss = target.isConnected && target.open && dragging && distance >= threshold;
    if (dragging) {
      if (event.cancelable) event.preventDefault();
      suppressClickUntil = Date.now() + 750;
    }
    reset();
    if (dismiss) target.close();
  };

  const cancel = () => reset();
  const close = (event: Event) => {
    if (event.target === dialog) reset();
  };
  const click = (event: MouseEvent) => {
    // Prevent a drag starting on a button/link from also activating that control.
    if (Date.now() >= suppressClickUntil) suppressed = undefined;
    if (event.detail !== 0 && event.target instanceof Node && suppressed?.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressed = undefined;
    }
  };

  root.addEventListener("touchstart", start, { passive: true });
  root.addEventListener("touchmove", move, { passive: false });
  root.addEventListener("touchend", end, { passive: false });
  root.addEventListener("touchcancel", cancel);
  root.addEventListener("click", click, true);
  // Dialog close events do not bubble.
  root.addEventListener("close", close, true);
  root.addEventListener("visibilitychange", cancel);

  return () => {
    root.removeEventListener("touchstart", start);
    root.removeEventListener("touchmove", move);
    root.removeEventListener("touchend", end);
    root.removeEventListener("touchcancel", cancel);
    root.removeEventListener("click", click, true);
    root.removeEventListener("close", close, true);
    root.removeEventListener("visibilitychange", cancel);
    reset();
    suppressed = undefined;
  };
}
