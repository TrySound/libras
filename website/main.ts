import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";
import "../src/edgerunner.css";

const target = document.getElementById("app");
if (!target) throw new Error("App target was not found.");

async function start(target: HTMLElement) {
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    await import("dialog-closedby-polyfill");
  }
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    await import("invokers-polyfill");
  }
  if (typeof window.navigation === "undefined") {
    await import("@virtualstate/navigation/polyfill");
  }

  return mount(Demo, { target });
}

const component = start(target);
export const cleanup = () => component.then((instance) => unmount(instance));

if (import.meta.hot) import.meta.hot.dispose(cleanup);
