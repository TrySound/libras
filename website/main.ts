import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";

const dialog = document.querySelector<HTMLDialogElement>("#live-demo-dialog");
const target = document.getElementById("demo");
if (!dialog || !target) throw new Error("Demo target was not found.");

const viewport = window.matchMedia("(width < 800px)");
let mobile: boolean | undefined;
let boundaryKey: string | undefined;
let session = 0;
let navigating = false;

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
  const opening = ++session;
  boundaryKey = undefined;
  navigating = false;
  if (event.newState !== "open" || !mobile) return;
  const current = window.navigation.currentEntry;
  if (!current) return;
  if (isDemoEntry(current)) {
    boundaryKey = current.key;
    return;
  }
  // Give the demo a real root entry. Returning to a website anchor would not
  // update the embedded router, and must not count as an in-app Back step.
  navigating = true;
  try {
    const entry = await window.navigation.navigate("#/library", { history: "push" }).finished;
    if (session === opening) boundaryKey = entry?.key;
  } catch {
    // If initialization is interrupted, allow closing rather than trapping Back.
  } finally {
    if (session === opening) navigating = false;
  }
};

const onCancel = async (event: Event) => {
  // Nested dialogs own their close requests. Never override a non-cancelable
  // browser request (CloseWatcher anti-trapping safeguards).
  if (event.target !== dialog || !mobile || !event.cancelable) return;
  if (navigating) {
    event.preventDefault();
    return;
  }
  const entries = window.navigation.entries();
  const boundary = entries.findIndex((entry) => entry.key === boundaryKey);
  const current = entries.findIndex((entry) => entry.key === window.navigation.currentEntry?.key);
  if (
    boundary < 0 ||
    current <= boundary ||
    !entries.slice(boundary, current + 1).every(isDemoEntry)
  )
    return;

  event.preventDefault();
  const opening = session;
  navigating = true;
  try {
    await window.navigation.back().finished;
  } catch {
    // An interrupted traversal leaves the explicit close button available.
  } finally {
    if (session === opening) navigating = false;
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
  ++session;
  return unmount(component);
};

if (import.meta.hot) import.meta.hot.dispose(cleanup);
