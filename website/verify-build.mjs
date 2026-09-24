import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

class ArtifactError extends Error {}

async function verify(root) {
  const files = new Set();
  let size = 0;
  async function walk(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const path = prefix + name;
      const info = await lstat(join(directory, name));
      if (info.isSymbolicLink())
        throw new ArtifactError("Pages artifact must not contain symlinks.");
      if (info.isDirectory()) await walk(join(directory, name), path + "/");
      else if (info.isFile()) {
        files.add(path);
        size += info.size;
      } else throw new ArtifactError("Unexpected Pages artifact entry.");
    }
  }
  await walk(root);
  for (const path of ["index.html", "webapp/index.html", "webapp/sw.js", "webapp/manifest.webmanifest"]) {
    if (!files.has(path))
      throw new ArtifactError("Regular application/PWA or demo build is missing.");
  }
  for (const path of files) {
    const name = path.split("/").at(-1);
    if (
      !path.startsWith("webapp/") &&
      (name === "sw.js" || name === "manifest.webmanifest" || name.startsWith("workbox-"))
    ) {
      throw new ArtifactError("Demo must not contain PWA artifacts.");
    }
  }
  const read = (path) => readFile(join(root, path), "utf8");
  if ((await read("index.html")).includes('rel="manifest"')) {
    throw new ArtifactError("Demo HTML must not declare a PWA manifest.");
  }
  const manifest = JSON.parse(await read("webapp/manifest.webmanifest"));
  if ([manifest.id, manifest.start_url, manifest.scope].some((path) => path !== "/webapp/")) {
    throw new ArtifactError("PWA must launch and stay scoped to /webapp/.");
  }
  if (!(await read("webapp/index.html")).includes('href="/webapp/manifest.webmanifest"')) {
    throw new ArtifactError("App HTML must declare its scoped PWA manifest.");
  }
  for (const name of [
    "search3.json",
    "assets.json",
    "credits.html",
    "credits.json",
    "dates.json",
    "sources.json",
  ]) {
    if (!files.has("catalog/" + name))
      throw new ArtifactError("Demo catalog metadata is incomplete.");
  }
  if (size > 1024 ** 3) throw new ArtifactError("Combined Pages site exceeds 1 GiB.");
  console.log(`Pages artifact verified: ${(size / 1024 ** 2).toFixed(1)} MiB total`);
}

try {
  const { values } = parseArgs({ options: { root: { type: "string", default: "dist" } } });
  await verify(resolve(values.root));
} catch (error) {
  console.error(
    "Pages artifact verification failed:",
    error instanceof ArtifactError ? error.message : "Missing, unsafe or invalid build output.",
  );
  process.exitCode = 1;
}
