import { vi } from "vitest";

export class AudioStub extends EventTarget {
  preload = "";
  src = "";
  get currentSrc() {
    return this.src;
  }
  paused = true;
  currentTime = 0;
  duration = 120;
  playbackRate = 1;
  readyState = 1;
  error: { code: number; message: string } | null = null;
  buffered = { length: 0, start: () => 0, end: () => 120 };
  seekable = { length: 0, start: (_i: number) => 0, end: (_i: number) => 120 };
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn(() => {
    this.currentTime = 0;
  });
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}
