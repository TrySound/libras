import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

class ArtifactError extends Error {}

async function verify(root) {
  const files = new Map();
  async function walk(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const path = prefix + name;
      const info = await lstat(join(directory, name));
      if (info.isSymbolicLink())
        throw new ArtifactError("Pages artifact must not contain symlinks.");
      if (info.isDirectory()) await walk(join(directory, name), path + "/");
      else if (info.isFile()) files.set(path, info.size);
      else throw new ArtifactError("Unexpected Pages artifact entry.");
    }
  }
  await walk(root);
  for (const path of ["index.html", "sw.js", "demo/index.html"]) {
    if (!files.has(path))
      throw new ArtifactError("Regular application/PWA or demo build is missing.");
  }
  for (const path of files.keys()) {
    const name = path.split("/").at(-1);
    if (
      path.startsWith("demo/") &&
      (name === "sw.js" || name === "manifest.webmanifest" || name.startsWith("workbox-"))
    ) {
      throw new ArtifactError("Demo must not contain PWA artifacts.");
    }
  }
  const read = (path) => readFile(join(root, path), "utf8");
  if ((await read("demo/index.html")).includes('rel="manifest"')) {
    throw new ArtifactError("Demo HTML must not declare a PWA manifest.");
  }
  for (const name of [
    "search3.json",
    "assets.json",
    "credits.html",
    "credits.json",
    "dates.json",
    "sources.json",
  ]) {
    if (!files.has("demo/catalog/" + name))
      throw new ArtifactError("Demo catalog metadata is incomplete.");
  }
  const assets = JSON.parse(await read("demo/catalog/assets.json"));
  for (const { path } of Object.values(assets)) {
    if (
      typeof path !== "string" ||
      !/^(audio|covers)\/[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !files.has("demo/catalog/" + path)
    )
      throw new ArtifactError("Unsafe or missing demo asset.");
  }
  const search = JSON.parse(await read("demo/catalog/search3.json"))["subsonic-response"]
    .searchResult3;
  if (!search.song.length || search.song.some((song) => !Object.hasOwn(assets, song.id)))
    throw new ArtifactError("Missing demo tracks.");
  const size = [...files.values()].reduce((total, bytes) => total + bytes, 0);
  if (size > 1024 ** 3) throw new ArtifactError("Combined Pages site exceeds 1 GiB.");
  console.log(
    `Pages artifact verified: ${search.song.length} demo tracks; ${(size / 1024 ** 2).toFixed(1)} MiB total`,
  );
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
