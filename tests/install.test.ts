// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { InstallController } from "../src/install.svelte";
import InstallCard from "../src/install-card.svelte";

const cleanups: (() => void | Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(standalone = false, safari = false) {
  const media = Object.assign(new EventTarget(), { matches: standalone });
  const browser = Object.assign(new EventTarget(), {
    matchMedia: () => media,
    navigator: { standalone: safari },
  });
  const controller = new InstallController(browser as unknown as Window);
  cleanups.push(() => controller.destroy());
  function offer() {
    const choice = deferred<{ outcome: "accepted" | "dismissed" }>();
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: choice.promise,
    });
    browser.dispatchEvent(event);
    return { event, prompt, choice };
  }
  return { controller, browser, media, offer };
}
function render(controller: InstallController) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(InstallCard, { target, props: { installation: controller } });
  flushSync();
  const destroy = async () => {
    await unmount(component);
    target.remove();
  };
  cleanups.push(destroy);
  return { target, destroy };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("player installation", () => {
  it("retains an early offer before Settings mounts and across route-like unmounts", async () => {
    const { controller, offer } = setup();
    const { event, prompt, choice } = offer();
    expect(event.defaultPrevented).toBe(true);
    const first = render(controller);
    expect(first.target.querySelector("button")).not.toBeNull();
    await first.destroy();
    const second = render(controller);
    second.target.querySelector("button")!.click();
    // No microtask or timer is needed for the user-activation-sensitive call.
    expect(prompt).toHaveBeenCalledTimes(1);
    second.target.querySelector("button")!.click();
    expect(prompt).toHaveBeenCalledTimes(1);
    choice.resolve({ outcome: "accepted" });
    await vi.waitFor(() => expect(controller.state).toBe("accepted"));
    flushSync();
    expect(second.target.textContent).toContain("Installation accepted in your browser.");
    expect(second.target.querySelector("button")).toBeNull();
    expect(second.target.textContent).not.toContain("was installed");
  });

  it("has no fake control without an event and always offers manual iPhone help", () => {
    const { controller } = setup();
    const { target } = render(controller);
    expect(target.querySelector("button")).toBeNull();
    expect(target.querySelector("details > summary")?.textContent).toBe(
      "Installation instructions",
    );
    expect(target.textContent).toContain("Share → Add to Home Screen");
    expect(target.textContent).toContain("Open as Web App");
    expect(target.textContent).toContain("device is locked");
    expect(target.textContent).toContain("removed by the browser or operating system");
  });

  it("suppresses reoffers after dismissal for this document", async () => {
    const { controller, offer } = setup();
    const first = offer();
    const result = controller.install();
    first.choice.resolve({ outcome: "dismissed" });
    await result;
    const next = offer();
    await controller.install();
    expect(controller.state).toBe("dismissed");
    expect(next.prompt).not.toHaveBeenCalled();
  });

  it.each(["throw", "prompt rejection", "choice rejection"])(
    "handles %s honestly",
    async (failure) => {
      const { controller, offer } = setup();
      const { prompt, choice } = offer();
      if (failure === "throw")
        prompt.mockImplementation(() => {
          throw new Error("unavailable");
        });
      if (failure === "prompt rejection") prompt.mockRejectedValue(new Error("unavailable"));
      const result = controller.install();
      if (failure === "choice rejection") choice.reject(new Error("unavailable"));
      else choice.resolve({ outcome: "accepted" });
      await result;
      expect(controller.state).toBe("failed");
      offer();
      expect(controller.state).toBe("failed");
    },
  );

  it.each(["installed", "standalone"])(
    "preserves %s evidence over late results",
    async (evidence) => {
      const { controller, browser, media, offer } = setup();
      const { choice } = offer();
      const result = controller.install();
      if (evidence === "installed") browser.dispatchEvent(new Event("appinstalled"));
      else {
        media.matches = true;
        media.dispatchEvent(new Event("change"));
      }
      choice.resolve({ outcome: "dismissed" });
      await result;
      expect(controller.state).toBe(evidence);
      offer();
      expect(controller.state).toBe(evidence);
    },
  );

  it.each([
    [true, false],
    [false, true],
  ])("recognizes standalone signals (%s, %s)", (media, safari) => {
    const { controller, offer } = setup(media, safari);
    offer();
    expect(controller.state).toBe("standalone");
  });

  it("removes listeners and ignores late promises after cleanup", async () => {
    const { controller, browser, media, offer } = setup();
    const { choice } = offer();
    const result = controller.install();
    controller.destroy();
    choice.resolve({ outcome: "accepted" });
    await result;
    browser.dispatchEvent(new Event("appinstalled"));
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    offer();
    expect(controller.state).toBe("pending");
  });

  it("recovers disappearing action focus without moving focus on eligibility", async () => {
    const { controller, offer } = setup();
    const { target } = render(controller);
    const summary = target.querySelector("summary")!;
    summary.focus();
    const { choice } = offer();
    flushSync();
    expect(document.activeElement).toBe(summary);
    const button = target.querySelector("button")!;
    button.focus();
    button.click();
    flushSync();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    choice.resolve({ outcome: "dismissed" });
    await vi.waitFor(() => expect(controller.state).toBe("dismissed"));
    flushSync();
    expect(document.activeElement).toBe(summary);
  });
});
