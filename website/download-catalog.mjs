import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { unpackTar } from "modern-tar/fs";

const MAX_BYTES = 2 * 1024 ** 3;
const METADATA = new Set([
  "search3.json",
  "assets.json",
  "credits.json",
  "credits.html",
  "dates.json",
  "sources.json",
  "summary.json",
]);
const FOLDERS = new Set(["audio", "covers", "albums", "artists", "evidence"]);
const checksum = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
class ExportError extends Error {}
function requireValid(condition, message) {
  if (!condition) throw new ExportError(message);
}

// Bound streams, verify bytes and scan across chunk boundaries without buffering audio files.
function verifyBytes(limit, expectedHash, forbidden = []) {
  let size = 0;
  const digest = createHash("sha256");
  const overlapSize = Math.max(0, ...forbidden.map((value) => value.length - 1));
  let overlap = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) return callback(new ExportError("Export exceeds declared size."));
      const scanned = Buffer.concat([overlap, chunk]);
      if (forbidden.some((value) => scanned.includes(value))) {
        return callback(
          new ExportError("Export contains a private source identifier or credential."),
        );
      }
      overlap = overlapSize ? Buffer.from(scanned.subarray(-overlapSize)) : Buffer.alloc(0);
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (expectedHash && (size !== limit || digest.digest("hex") !== expectedHash)) {
        return callback(new ExportError("Export checksum or size mismatch."));
      }
      callback();
    },
  });
}

async function download(output) {
  const { DEMO_EXPORT_URL, DEMO_MEDIA_PASSWORD, DEMO_MEDIA_USERNAME = "demo" } = process.env;
  requireValid(
    DEMO_EXPORT_URL && DEMO_MEDIA_PASSWORD && DEMO_MEDIA_USERNAME,
    "Set DEMO_EXPORT_URL and DEMO_MEDIA_PASSWORD in Actions secrets.",
  );
  let base;
  try {
    base = new URL(DEMO_EXPORT_URL);
  } catch {
    throw new ExportError("Invalid DEMO_EXPORT_URL.");
  }
  requireValid(
    base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash,
    "DEMO_EXPORT_URL must be an HTTPS directory without credentials, query or fragment.",
  );
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const authorization =
    "Basic " + Buffer.from(`${DEMO_MEDIA_USERNAME}:${DEMO_MEDIA_PASSWORD}`).toString("base64");
  const forbidden = [base.href, base.hostname, DEMO_MEDIA_PASSWORD, authorization].map((value) =>
    Buffer.from(value),
  );
  const existing = await lstat(output).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  requireValid(!existing, "Catalog destination already exists; refusing to mix releases.");

  async function get(path) {
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: authorization },
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ExportError(
        `Export download failed (HTTP ${response.status}); check the source secrets.`,
      );
    }
    return response.body;
  }
  async function metadata(path) {
    const chunks = [];
    let size = 0;
    for await (const chunk of await get(path)) {
      size += chunk.length;
      requireValid(size <= 8 * 1024 ** 2, "Export metadata exceeds size limit.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  // Resolve latest once; every subsequent request uses that immutable release.
  const { release } = await metadata("latest.json");
  requireValid(checksum(release), "Invalid export release.");
  const manifest = await metadata(`${release}/manifest.json`);
  requireValid(
    Array.isArray(manifest.files) && manifest.files.length <= 10000,
    "Invalid export inventory.",
  );
  // Match the exporter's sorted-key, ASCII-escaped canonical JSON fingerprint.
  const canonical = JSON.stringify(
    manifest.files.map((entry) =>
      Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ),
  ).replace(/[\u007f-\uffff]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  requireValid(
    manifest.schemaVersion === 1 && manifest.release === release && hash(canonical) === release,
    "Invalid export manifest fingerprint.",
  );
  const files = new Map();
  let total = 0;
  for (const entry of manifest.files) {
    const { path, size, sha256 } = entry;
    requireValid(typeof path === "string" && path.length > 0, "Invalid export path.");
    const parts = path.split("/");
    requireValid(
      !/[\\\x00-\x1f]/.test(path) &&
        parts.every((part) => part && part !== "." && part !== "..") &&
        (FOLDERS.has(parts[0]) || METADATA.has(path)) &&
        !files.has(path) &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        checksum(sha256) &&
        !forbidden.some((value) => Buffer.from(path).includes(value)),
      "Unsafe or invalid export inventory.",
    );
    total += size;
    files.set(path, entry);
  }
  requireValid(
    total <= MAX_BYTES && [...METADATA].every((name) => files.has(name)),
    "Incomplete or oversized export inventory.",
  );
  const item = manifest.archives.full;
  requireValid(
    item.path === "catalog.tar.gz" &&
      Number.isSafeInteger(item.size) &&
      item.size > 0 &&
      item.size <= MAX_BYTES &&
      checksum(item.sha256),
    "Invalid archive metadata.",
  );

  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".demo-download-"));
  try {
    const seen = new Set();
    await pipeline(
      await get(`${release}/catalog.tar.gz`),
      verifyBytes(item.size, item.sha256),
      createGunzip(),
      verifyBytes(MAX_BYTES + 64 * 1024 ** 2),
      unpackTar(temporary, {
        strict: true,
        fmode: 0o644,
        dmode: 0o755,
        filter({ name, size, type }) {
          const entry = files.get(name);
          requireValid(
            type === "file" && entry && !seen.has(name) && size === entry.size,
            "Unexpected archive entry.",
          );
          seen.add(name);
          return true;
        },
      }),
    );
    requireValid(seen.size === files.size, "Archive is incomplete.");
    for (const { path, size, sha256 } of files.values()) {
      await pipeline(
        createReadStream(join(temporary, path)),
        verifyBytes(size, sha256, forbidden),
        new WritableStream(),
      );
    }
    await chmod(temporary, 0o755);
    await rename(temporary, output);
    console.log("Verified demo export:", release);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  requireValid(values.output, "Provide --output <catalog directory>.");
  await download(resolve(values.output));
} catch (error) {
  // Fetch/filesystem/library exceptions can contain private URLs. Never print them.
  console.error(
    "Demo export failed:",
    error instanceof ExportError ? error.message : "Invalid or unavailable catalog.",
  );
  process.exitCode = 1;
}
