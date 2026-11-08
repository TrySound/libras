import { mount } from "svelte";
import App from "./app.svelte";
import WebappUpdater from "./webapp-updater.svelte";
import { Network } from "./network.svelte";
import { AuthStore } from "./auth";
import "./edgerunner.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App target was not found.");
}

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

  mount(App, {
    target,
    props: {
      network: new Network(),
      auth: new AuthStore(),
      updaterComponent: WebappUpdater,
    },
  });
}

void start(target);
