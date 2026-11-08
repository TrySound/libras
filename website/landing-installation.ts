interface InstallOffer extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type State =
  | "unavailable"
  | "available"
  | "pending"
  | "accepted"
  | "dismissed"
  | "failed"
  | "installed"
  | "standalone";

/** Landing-only progressive enhancement; no worker, application, or storage ownership. */
export function installLanding(browser: Window = window) {
  const document = browser.document;
  let controls = [...document.querySelectorAll<HTMLElement>("[data-install]")];
  const destination = controls[0]?.getAttribute("href");
  if (!destination || controls.length === 0) return () => {};
  const statuses = document.querySelectorAll<HTMLElement>("[data-install-status]");
  const media = browser.matchMedia("(display-mode: standalone)");
  let state: State = "unavailable";
  let offer: InstallOffer | undefined;
  let consumed = false;
  let installed = false;
  let disposed = false;
  const standalone = () =>
    media.matches ||
    (browser.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const messages: Record<State, string> = {
    unavailable: "",
    available: "",
    pending: "Opening installation prompt…",
    accepted: "Installation accepted in your browser.",
    dismissed: "Installation dismissed.",
    failed: "The installation prompt couldn’t be opened.",
    installed: "Your browser reported that Libras was installed.",
    standalone: "Running as an app.",
  };

  function render() {
    const native = state === "available" || state === "pending";
    controls = controls.map((control) => {
      if ((control.tagName === "BUTTON") !== native) {
        const replacement = document.createElement(native ? "button" : "a");
        replacement.className = control.className;
        for (const attribute of control.attributes) {
          if (attribute.name.startsWith("data-"))
            replacement.setAttribute(attribute.name, attribute.value);
        }
        if (replacement instanceof HTMLButtonElement) {
          replacement.type = "button";
          replacement.addEventListener("click", prompt);
        } else replacement.setAttribute("href", destination!);
        const focused = document.activeElement === control;
        control.replaceWith(replacement);
        if (focused) replacement.focus({ preventScroll: true });
        control = replacement;
      }
      control.textContent =
        native || state === "unavailable" ? "Install" : "Installation instructions";
      if (native) control.setAttribute("aria-disabled", String(state === "pending"));
      return control;
    });
    for (const status of statuses) status.textContent = messages[state];
  }

  function capture(event: Event) {
    const candidate = event as InstallOffer;
    if (typeof candidate.prompt !== "function" || !candidate.userChoice) return;
    event.preventDefault();
    if (disposed || consumed || installed || standalone()) return;
    offer = candidate;
    state = "available";
    render();
  }
  async function prompt() {
    const retained = offer;
    if (!retained || disposed || state !== "available") return;
    offer = undefined;
    consumed = true;
    state = "pending";
    render();
    try {
      // Call synchronously in the activating handler, before yielding.
      const result = retained.prompt();
      const [, choice] = await Promise.all([result, retained.userChoice]);
      if (canSettle()) {
        state = choice.outcome;
        render();
      }
    } catch {
      if (canSettle()) {
        state = "failed";
        render();
      }
    }
  }
  function canSettle() {
    return !disposed && state === "pending" && !installed && !standalone();
  }
  function onInstalled() {
    installed = true;
    offer = undefined;
    state = standalone() ? "standalone" : "installed";
    render();
  }
  function onDisplayChange() {
    if (standalone()) {
      offer = undefined;
      state = "standalone";
      render();
    } else if (state === "standalone") {
      state = installed ? "installed" : "unavailable";
      render();
    }
  }
  browser.addEventListener("beforeinstallprompt", capture);
  browser.addEventListener("appinstalled", onInstalled);
  media.addEventListener("change", onDisplayChange);
  onDisplayChange();
  return () => {
    disposed = true;
    offer = undefined;
    browser.removeEventListener("beforeinstallprompt", capture);
    browser.removeEventListener("appinstalled", onInstalled);
    media.removeEventListener("change", onDisplayChange);
    state = "unavailable";
    render();
  };
}
