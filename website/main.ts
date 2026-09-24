import { mountDemo } from "./mount-demo";

const dialog = document.querySelector<HTMLDialogElement>("#live-demo-dialog");
const target = document.getElementById("demo");
if (!dialog || !target) throw new Error("Demo target was not found.");
const cleanup = mountDemo(dialog, target);

if (import.meta.hot) import.meta.hot.dispose(cleanup);
