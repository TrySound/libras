export function swipeToDismiss(dialog: HTMLDialogElement) {
  let touchId: number | undefined;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let threshold = 96;
  let suppressClickUntil = 0;

  const reset = () => {
    touchId = undefined;
    dragging = false;
    dialog.removeAttribute("data-dragging");
    dialog.style.removeProperty("--swipe-offset");
  };

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    if (!dialog.open || !(event.target instanceof Element) || !dialog.contains(event.target))
      return;
    // Inputs keep their native gestures, including the playback seek slider.
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;

    // Do not steal a gesture from content that can still scroll upward.
    for (let node: Element | null = event.target; node; node = node.parentElement) {
      if (node.scrollTop > 0) return;
      if (node === dialog) break;
    }

    const touch = event.touches[0];
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    threshold = Math.max(72, Math.min(160, dialog.getBoundingClientRect().height * 0.2));
  };

  const move = (event: TouchEvent) => {
    if (touchId === undefined) return;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === touchId);
    if (!touch) return;
    const dy = touch.clientY - startY;
    const dx = touch.clientX - startX;
    if (!dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      // Once scrolling or a horizontal gesture wins, leave the rest of it native.
      if (dy <= 0 || Math.abs(dx) >= dy) {
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
    suppressClickUntil = Date.now() + 750;
    dialog.setAttribute("data-dragging", "");
    dialog.style.setProperty("--swipe-offset", `${Math.max(0, dy)}px`);
  };

  const end = (event: TouchEvent) => {
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === touchId);
    if (!touch) return;
    const dismiss = dragging && touch.clientY - startY >= threshold;
    if (dragging) {
      if (event.cancelable) event.preventDefault();
      suppressClickUntil = Date.now() + 750;
    }
    reset();
    if (dismiss) dialog.close();
  };

  const cancel = () => reset();
  const click = (event: MouseEvent) => {
    // Prevent a drag starting on a button/link from also activating that control.
    if (event.detail !== 0 && Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppressClickUntil = 0;
  };

  dialog.addEventListener("touchstart", start, { passive: true });
  dialog.addEventListener("touchmove", move, { passive: false });
  dialog.addEventListener("touchend", end, { passive: false });
  dialog.addEventListener("touchcancel", cancel);
  dialog.addEventListener("click", click, true);
  dialog.addEventListener("close", reset);

  return {
    destroy() {
      dialog.removeEventListener("touchstart", start);
      dialog.removeEventListener("touchmove", move);
      dialog.removeEventListener("touchend", end);
      dialog.removeEventListener("touchcancel", cancel);
      dialog.removeEventListener("click", click, true);
      dialog.removeEventListener("close", reset);
      reset();
    },
  };
}
