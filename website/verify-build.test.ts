import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let root: string;
const script = fileURLToPath(new URL("./verify-build.mjs", import.meta.url));
const manifest = { id: "/webapp/", start_url: "/webapp/", scope: "/webapp/" };

async function put(path: string, content: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
function verify() {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "libras-pages-"));
  await put("index.html", "<!doctype html><title>Libras</title>");
  await put(
    "demo/index.html",
    '<!doctype html><script type="module" src="/assets/demo.js"></script>',
  );
  await put("webapp/index.html", '<link rel="manifest" href="/webapp/manifest.webmanifest">');
  await put("webapp/manifest.webmanifest", JSON.stringify(manifest));
  await put("webapp/sw.js", "// scoped app service worker");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("verifies a code-only Pages artifact without an exported catalog", () => {
  const result = verify();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Pages artifact verified");
});

it("rejects leftover legacy catalog exports", async () => {
  await put("catalog/search3.json", "{}");
  const result = verify();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Legacy static catalog must not be published");
});

it("still rejects a demo service worker", async () => {
  await put("demo/sw.js", "// unexpected service worker");
  const result = verify();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Demo must not contain PWA artifacts");
});

it("still requires the app PWA to stay scoped to /webapp/", async () => {
  await put("webapp/manifest.webmanifest", JSON.stringify({ ...manifest, scope: "/" }));
  const result = verify();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("PWA must launch and stay scoped to /webapp/");
});

it("deploys both builds without the private export downloader or its secrets", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain("pnpm --filter @libras/website build");
  expect(workflow).toContain("node website/verify-build.mjs --root pages");
  expect(workflow).not.toContain("download-catalog.mjs");
  expect(workflow).not.toMatch(/DEMO_(?:EXPORT|MEDIA)_/);
});
