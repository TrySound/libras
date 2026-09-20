import { mount } from "svelte";
import Demo from "./demo.svelte";
import "../src/app.css";

const target = document.getElementById("app");
if (!target) throw new Error("Demo target was not found.");
mount(Demo, { target });
