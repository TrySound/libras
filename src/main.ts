import { mount, unmount } from "svelte";
import Webapp from "./webapp.svelte";
import { InstallController } from "./install.svelte";
import "./edgerunner.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App target was not found.");
}

// Capture eligibility before polyfills can yield; Settings routes do not own this lifetime.
const installation = new InstallController();

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

  const app = mount(Webapp, { target, props: { installation } });
  if (import.meta.hot) import.meta.hot.dispose(() => void unmount(app));
}

void start(target).catch((error: unknown) => {
  installation.destroy();
  throw error;
});
