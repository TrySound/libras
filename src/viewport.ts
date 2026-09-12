import type { Attachment } from "svelte/attachments";

interface Registration {
  notify: (visible: boolean) => void;
  visible?: boolean;
}

const registrations = new Map<Element, Registration>();
let observer: IntersectionObserver | undefined;

/** Hide a stable outer box's contents and acquire resources at the same boundary. */
export function viewportContent(onVisible: () => void): Attachment {
  return (node) => {
    let nearby = false;
    let visible = false;
    let disposed = false;
    const update = () => {
      if (disposed) return;
      const next = nearby || node.contains(node.ownerDocument.activeElement);
      node.toggleAttribute("data-viewport-hidden", !next);
      if (next && !visible) {
        visible = true;
        onVisible();
      } else visible = next;
    };
    const onFocusOut = () => queueMicrotask(update);
    node.addEventListener("focusin", update);
    node.addEventListener("focusout", onFocusOut);
    update();
    const stop = nearViewport((value) => {
      nearby = value;
      update();
    })(node);
    return () => {
      disposed = true;
      stop?.();
      node.removeEventListener("focusin", update);
      node.removeEventListener("focusout", onFocusOut);
      node.removeAttribute("data-viewport-hidden");
    };
  };
}

/** Share one preload boundary for rendering and resource acquisition. */
export function nearViewport(notify: (visible: boolean) => void): Attachment {
  return (node) => {
    if (typeof IntersectionObserver === "undefined") {
      notify(true);
      return;
    }
    const registration: Registration = { notify };
    registrations.set(node, registration);
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const current = registrations.get(entry.target);
          if (!current || current.visible === entry.isIntersecting) continue;
          current.visible = entry.isIntersecting;
          current.notify(entry.isIntersecting);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => {
      if (registrations.get(node) !== registration) return;
      registrations.delete(node);
      observer?.unobserve(node);
      if (registrations.size === 0) {
        observer?.disconnect();
        observer = undefined;
      }
    };
  };
}
