import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function redirect(file: string, hash: string, search = "") {
  const html = readFileSync(new URL(file, import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const replace = vi.fn();
  runInNewContext(script, { location: { hash, search, replace } });
  return replace;
}

describe("legacy app redirects", () => {
  it("redirects the legacy path and preserves query and route", () => {
    expect(
      redirect("./public/libras/index.html", "#/settings", "?source=old"),
    ).toHaveBeenCalledWith("/webapp/?source=old#/settings");
    expect(redirect("./public/libras/index.html", "")).toHaveBeenCalledWith("/webapp/");
  });

  it("forwards app routes arriving at the website root", () => {
    expect(redirect("./index.html", "#/library", "?source=old")).toHaveBeenCalledWith(
      "/webapp/?source=old#/library",
    );
  });

  it("preserves normal website visits and anchors", () => {
    for (const hash of ["", "#features", "#live-demo", "#main-content"]) {
      expect(redirect("./index.html", hash)).not.toHaveBeenCalled();
    }
  });
});
