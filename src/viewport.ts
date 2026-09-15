import type { Attachment } from "svelte/attachments";

interface Registration {
  notify: (visible: boolean) => void;
  visible?: boolean;
}

const registrations = new Map<Element, Registration>();
let observer: IntersectionObserver | undefined;

/** Run on entry and re-entry into the shared preload boundary. */
export function onVisible(callback: () => void): Attachment {
  return nearViewport((visible) => {
    if (visible) callback();
  });
}

/** Share one preload boundary for resource acquisition. */
function nearViewport(notify: (visible: boolean) => void): Attachment {
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
