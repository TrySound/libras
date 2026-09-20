import { mount } from "svelte";
import App from "./app.svelte";
import WebappUpdater from "./webapp-updater.svelte";
import "./app.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App target was not found.");
}

mount(App, { target, props: { updaterComponent: WebappUpdater } });
