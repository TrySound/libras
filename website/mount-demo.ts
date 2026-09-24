import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";

/** Only the demo island is client-rendered; the landing page is static HTML. */
export function mountDemo(dialog: HTMLDialogElement, target: HTMLElement) {
  const viewport = window.matchMedia("(width < 800px)");
  let mobile: boolean | undefined;
  const syncViewport = () => {
    if (mobile === viewport.matches) return;
    // Close transient overlays, but keep the same player and playback session.
    for (const nested of dialog.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
      nested.close();
    }
    dialog.close();
    mobile = viewport.matches;
    if (!mobile) dialog.show();
  };
  syncViewport();
  viewport.addEventListener("change", syncViewport);
  const component = mount(Demo, { target });

  return () => {
    viewport.removeEventListener("change", syncViewport);
    return unmount(component);
  };
}
