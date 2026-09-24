import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";

const dialog = document.querySelector<HTMLDialogElement>("#live-demo-dialog");
const target = document.getElementById("demo");
if (!dialog || !target) throw new Error("Demo target was not found.");

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

export function cleanup() {
  viewport.removeEventListener("change", syncViewport);
  return unmount(component);
}

if (import.meta.hot) import.meta.hot.dispose(cleanup);
