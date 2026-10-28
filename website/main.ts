import "dialog-closedby-polyfill";
import { mount, unmount } from "svelte";
import Demo from "./demo.svelte";
import "../src/edgerunner.css";

const target = document.getElementById("app");
if (!target) throw new Error("App target was not found.");

const component = mount(Demo, { target });
export const cleanup = () => unmount(component);

if (import.meta.hot) import.meta.hot.dispose(cleanup);
