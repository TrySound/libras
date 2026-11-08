// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { installLanding } from "./landing-installation";

let cleanup: (() => void) | undefined;
function setup(standalone = false, safari = false) {
  const html = readFileSync("website/index.html", "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  const media = Object.assign(new EventTarget(), { matches: standalone });
  vi.spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList);
  Object.defineProperty(navigator, "standalone", { configurable: true, value: safari });
  cleanup = installLanding();
  return media;
}
function offer(prompt = vi.fn(async () => {})) {
  let resolve!: (choice: { outcome: "accepted" | "dismissed" }) => void;
  let reject!: (error: Error) => void;
  const userChoice = new Promise<{ outcome: "accepted" | "dismissed" }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice,
  });
  window.dispatchEvent(event);
  return { event, prompt, resolve, reject };
}
const controls = () => [...document.querySelectorAll<HTMLElement>("[data-install]")];
const status = () => document.querySelector('[role="status"]')!.textContent;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
  vi.restoreAllMocks();
});

it("keeps both honest navigation fallbacks without an event and always exposes help", () => {
  setup();
  expect(controls().map((c) => c.tagName)).toEqual(["A", "A"]);
  expect(
    controls().every((c) => c.getAttribute("href") === "/webapp/?/settings#install-title"),
  ).toBe(true);
  expect(document.querySelectorAll(".site-install-help a")).toHaveLength(2);
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
});

it.each([0, 1])(
  "invokes synchronously from CTA %s, guards both buttons, and restores same-position focus",
  async (index) => {
    setup();
    controls()[index].focus();
    const { event, prompt, resolve } = offer();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls()[index]);
    const button = controls()[index];
    button.click();
    expect(prompt).toHaveBeenCalledOnce();
    expect(controls()[index]).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(controls().every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
    controls()[1 - index].click();
    expect(prompt).toHaveBeenCalledOnce();
    resolve({ outcome: "dismissed" });
    await vi.waitFor(() => expect(status()).toBe("Installation dismissed."));
    expect(document.activeElement).toBe(controls()[index]);
    expect(
      controls().every((c) => c.tagName === "A" && c.textContent === "Installation instructions"),
    ).toBe(true);
    offer();
    expect(controls().every((c) => c.tagName === "A")).toBe(true);
  },
);

it("does not steal unrelated focus on eligibility or completion", async () => {
  setup();
  const help = document.querySelector<HTMLElement>(".site-install-help a")!;
  help.focus();
  const { resolve } = offer();
  expect(document.activeElement).toBe(help);
  controls()[0].click();
  resolve({ outcome: "accepted" });
  await vi.waitFor(() => expect(status()).toBe("Installation accepted in your browser."));
  expect(document.activeElement).toBe(help);
  expect(status()).not.toContain("was installed");
});

it.each(["throw", "prompt rejection", "choice rejection"])(
  "handles %s with instructions, not native retry",
  async (failure) => {
    setup();
    const prompt = vi.fn(async () => {});
    if (failure === "throw")
      prompt.mockImplementation(() => {
        throw new Error("unavailable");
      });
    if (failure === "prompt rejection") prompt.mockRejectedValue(new Error("unavailable"));
    const held = offer(prompt);
    controls()[1].click();
    if (failure === "choice rejection") held.reject(new Error("unavailable"));
    else held.resolve({ outcome: "accepted" });
    await vi.waitFor(() => expect(status()).toBe("The installation prompt couldn’t be opened."));
    offer();
    expect(controls().every((c) => c.tagName === "A")).toBe(true);
  },
);

it.each(["installed", "standalone"])(
  "gives %s evidence precedence over late choices",
  async (evidence) => {
    const media = setup();
    const { resolve } = offer();
    controls()[0].click();
    if (evidence === "installed") window.dispatchEvent(new Event("appinstalled"));
    else {
      media.matches = true;
      media.dispatchEvent(new Event("change"));
    }
    resolve({ outcome: "dismissed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(status()).toBe(
      evidence === "installed"
        ? "Your browser reported that Libras was installed."
        : "Running as an app.",
    );
    expect(controls().every((c) => c.tagName === "A")).toBe(true);
  },
);

it.each([
  [true, false],
  [false, true],
])("recognizes standalone signals %s/%s", (media, safari) => {
  setup(media, safari);
  offer();
  expect(status()).toBe("Running as an app.");
  expect(controls().every((c) => c.tagName === "A")).toBe(true);
});

it("cleans up events and ignores late outcomes", async () => {
  setup();
  const { resolve } = offer();
  controls()[0].click();
  cleanup!();
  cleanup = undefined;
  resolve({ outcome: "accepted" });
  window.dispatchEvent(new Event("appinstalled"));
  offer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(status()).toBe("");
  expect(controls().every((c) => c.tagName === "A")).toBe(true);
});
