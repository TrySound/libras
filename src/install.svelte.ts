export type InstallState =
  | "unavailable"
  | "available"
  | "pending"
  | "accepted"
  | "dismissed"
  | "failed"
  | "installed"
  | "standalone";

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Document-lifetime installation evidence, independent of service-worker updates. */
export class InstallController {
  state = $state<InstallState>("unavailable");
  private offer: InstallPromptEvent | undefined;
  private consumed = false;
  private disposed = false;
  private installed = false;
  private media: MediaQueryList;

  constructor(private browser: Window = window) {
    this.media = browser.matchMedia("(display-mode: standalone)");
    browser.addEventListener("beforeinstallprompt", this.capture);
    browser.addEventListener("appinstalled", this.onInstalled);
    this.media.addEventListener("change", this.onDisplayChange);
    this.onDisplayChange();
  }

  private isStandalone = () =>
    this.media.matches ||
    (this.browser.navigator as Navigator & { standalone?: boolean }).standalone === true;

  private onDisplayChange = () => {
    if (this.isStandalone()) {
      this.offer = undefined;
      this.state = "standalone";
    } else if (this.state === "standalone") {
      this.state = this.installed ? "installed" : "unavailable";
    }
  };

  private capture = (event: Event) => {
    const offer = event as InstallPromptEvent;
    if (typeof offer.prompt !== "function" || !offer.userChoice) return;
    event.preventDefault();
    if (this.disposed || this.consumed || this.installed || this.isStandalone()) return;
    this.offer = offer;
    this.state = "available";
  };

  private onInstalled = () => {
    this.installed = true;
    this.offer = undefined;
    this.state = this.isStandalone() ? "standalone" : "installed";
  };

  // Called directly by the button handler: prompt must run before any await.
  install = async () => {
    const offer = this.offer;
    if (!offer || this.disposed || this.state !== "available") return;
    this.offer = undefined;
    this.consumed = true;
    this.state = "pending";
    try {
      const prompt = offer.prompt();
      const [, choice] = await Promise.all([prompt, offer.userChoice]);
      if (this.canSettle()) this.state = choice.outcome;
    } catch {
      if (this.canSettle()) this.state = "failed";
    }
  };

  private canSettle() {
    return !this.disposed && this.state === "pending" && !this.installed && !this.isStandalone();
  }

  destroy() {
    this.disposed = true;
    this.offer = undefined;
    this.browser.removeEventListener("beforeinstallprompt", this.capture);
    this.browser.removeEventListener("appinstalled", this.onInstalled);
    this.media.removeEventListener("change", this.onDisplayChange);
  }
}
