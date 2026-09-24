import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";

const dialog = document.querySelector<HTMLDialogElement>("#live-demo-dialog");
const target = document.getElementById("demo");
if (!dialog || !target) throw new Error("Demo target was not found.");

const viewport = window.matchMedia("(width < 800px)");
let mobile: boolean | undefined;
let session: { key: string | undefined; busy: boolean } | undefined;

function isDemoEntry(entry: NavigationHistoryEntry) {
  if (!entry.sameDocument || !entry.url) return false;
  const url = new URL(entry.url);
  return (
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search &&
    url.hash.startsWith("#/")
  );
}

const onToggle = async (event: ToggleEvent) => {
  if (event.target !== dialog) return;
  session = undefined;
  const current = window.navigation.currentEntry;
  if (event.newState !== "open" || !mobile || !current) return;
  // Async work keeps its own opening object, so it cannot alter a later session.
  const opening = { key: isDemoEntry(current) ? current.key : undefined, busy: false };
  session = opening;
  if (opening.key) return;
  // Give the demo a real root entry. Returning to a website anchor would not
  // update the embedded router, and must not count as an in-app Back step.
  opening.busy = true;
  try {
    const entry = await window.navigation.navigate("#/library", { history: "push" }).finished;
    opening.key = entry?.key;
  } catch {
    // If initialization is interrupted, allow closing rather than trapping Back.
  } finally {
    opening.busy = false;
  }
};

const onCancel = async (event: Event) => {
  // Nested dialogs own their close requests. Never override a non-cancelable
  // browser request (CloseWatcher anti-trapping safeguards).
  const opening = session;
  if (event.target !== dialog || !opening || !event.cancelable) return;
  if (opening.busy) {
    event.preventDefault();
    return;
  }
  const entries = window.navigation.entries();
  const boundary = entries.findIndex((entry) => entry.key === opening.key);
  const current = entries.findIndex((entry) => entry.key === window.navigation.currentEntry?.key);
  if (
    boundary < 0 ||
    current <= boundary ||
    !entries.slice(boundary, current + 1).every(isDemoEntry)
  )
    return;

  event.preventDefault();
  opening.busy = true;
  try {
    await window.navigation.back().finished;
  } catch {
    // An interrupted traversal leaves the explicit close button available.
  } finally {
    opening.busy = false;
  }
};
dialog.addEventListener("beforetoggle", onToggle);
dialog.addEventListener("cancel", onCancel);

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

export const cleanup = () => {
  viewport.removeEventListener("change", syncViewport);
  dialog.removeEventListener("beforetoggle", onToggle);
  dialog.removeEventListener("cancel", onCancel);
  session = undefined;
  return unmount(component);
};

if (import.meta.hot) import.meta.hot.dispose(cleanup);
