import { mount } from "svelte";
import Website from "./website.svelte";
import "../src/app.css";
import "./website.css";

const target = document.getElementById("app");
if (!target) throw new Error("Demo target was not found.");
mount(Website, { target });
