// Real production workers; Playwright stays external. See CONTRIBUTING.md.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const http = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: pollDelay } = require("node:timers/promises");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const route = "/webapp/?/settings#settings-heading";
const action = (page) =>
  page.locator(".app-sidebar").getByRole("button", { name: "Update Libras", exact: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function artifact(directory, name) {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const worker = await readFile(path.join(directory, "sw.js"), "utf8");
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
  assert(entry?.startsWith("/webapp/assets/"), `${name}: expected a /webapp/ entry script`);
  const revision = worker.match(/url:[`"']index\.html[`"'],revision:[`"']([^`"']+)[`"']/)?.[1];
  assert(revision, `${name}: index.html must be precached`);
  // Build-artifact guard, separate from the real browser installation proof.
  const workerURL = "https://pwa.test/webapp/sw.js";
  const precached = [...worker.matchAll(/url:[`"']([^`"']+)[`"']/g)].map(
    (match) => new URL(match[1], workerURL).href,
  );
  assert.equal(
    new Set(precached).size,
    precached.length,
    `${name}: duplicate resolved precache URL`,
  );
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) {
    assert(
      precached.includes(new URL(icon.src, workerURL).href),
      `${name}: manifest icon must remain precached: ${icon.src}`,
    );
  }
  return { directory, name, entry, revision, hash: sha256(worker), html };
}

async function serve(timeline) {
  let selected;
  let fault = false;
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
  };
  const server = http.createServer(async (request, response) => {
    // Snapshot the immutable root for this request, even if an install switches versions.
    const build = selected;
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname.slice("/webapp/".length) || "index.html";
      if (!pathname.startsWith("/webapp/") || relative.split(/[\\/]/).includes("..")) {
        response.writeHead(404).end();
        return;
      }
      if (fault && relative === "index.html") {
        timeline.push(
          `HTTP ${build.name} 503 ${url.pathname}${url.search} (deliberate precache failure)`,
        );
        response.writeHead(503, { "Cache-Control": "no-store" }).end("Deliberate precache failure");
        return;
      }
      const file = path.join(build.directory, relative);
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      const bytes = await readFile(file);
      timeline.push(`HTTP ${build.name} 200 ${url.pathname}${url.search}`);
      response.writeHead(200, {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Length": bytes.length,
      });
      response.end(bytes);
    } catch {
      timeline.push(`HTTP ${build?.name} 404 ${request.url}`);
      response.writeHead(404, { "Cache-Control": "no-store" }).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    select(build, failPrecache = false) {
      selected = build;
      fault = failPrecache;
      timeline.push(
        `SELECT ${build.name} worker=${build.hash} index-revision=${build.revision} fault=${fault}`,
      );
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function newPage(context) {
  const page = await context.newPage();
  const log = { errors: [], navigations: [], responses: [] };
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => log.errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) log.navigations.push(frame.url());
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest()) {
      log.responses.push({
        url: response.url(),
        status: response.status(),
        serviceWorker: response.fromServiceWorker(),
      });
    }
  });
  await page.addInitScript(() => {
    // Diagnostic document token and native observation only: no API replacement.
    const events = [];
    const workers = new WeakMap();
    const registrations = new WeakSet();
    let sequence = 0;
    const record = (type, worker) =>
      events.push({ type, worker: workers.get(worker), state: worker?.state });
    const observeWorker = (worker) => {
      if (!worker || workers.has(worker)) return;
      workers.set(worker, ++sequence);
      record("observed", worker);
      worker.addEventListener("statechange", () => record("statechange", worker));
    };
    window.pwaTest = {
      token: crypto.randomUUID(),
      events,
      observe(registration) {
        this.registration = registration;
        if (!registrations.has(registration)) {
          registrations.add(registration);
          registration.addEventListener("updatefound", () => {
            observeWorker(registration.installing);
            record("updatefound", registration.installing);
          });
        }
        [registration.installing, registration.waiting, registration.active].forEach(observeWorker);
      },
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      observeWorker(navigator.serviceWorker.controller);
      record("controllerchange", navigator.serviceWorker.controller);
    });
  });
  return { page, log };
}

async function registration(page) {
  const deadline = Date.now() + 30_000;
  // Resolve the native async lookup in evaluate; keep waitForFunction predicates
  // synchronous (some external Playwright versions treat a Promise as truthy).
  while (
    !(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return false;
      window.pwaTest.observe(registration);
      return true;
    }))
  ) {
    assert(Date.now() < deadline, "native registration must appear within 30s");
    await pollDelay(25);
  }
}

async function controlled(page) {
  await registration(page);
  await page.waitForFunction(
    () =>
      window.pwaTest.registration.active?.state === "activated" &&
      !!navigator.serviceWorker.controller,
  );
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration()).scope,
  );
  assert.equal(new URL(scope).pathname, "/webapp/");
}

async function loaded(page, marker) {
  await page.waitForFunction(
    (expected) => document.querySelector('meta[name="pwa-test-build"]')?.content === expected,
    marker,
  );
  await page.locator("#settings-heading").waitFor();
}

async function identity(page) {
  return page.evaluate(() => ({
    marker: document.querySelector('meta[name="pwa-test-build"]')?.content ?? null,
    entry: document.querySelector('script[type="module"][src]')?.getAttribute("src"),
    token: window.pwaTest.token,
    url: location.href,
    controller: navigator.serviceWorker.controller?.state ?? null,
  }));
}

async function checkForUpdate(page) {
  await registration(page);
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
}

async function waiting(page) {
  await page.waitForFunction(() => window.pwaTest.registration.waiting?.state === "installed");
  await action(page).waitFor();
}

async function approve(harness, marker, t) {
  const { page, log } = harness;
  const before = await identity(page);
  const navigations = log.navigations.length;
  await action(page).click();
  await loaded(page, marker);
  const after = await identity(page);
  assert.equal(after.url, before.url);
  assert.notEqual(after.token, before.token);
  assert.equal(log.navigations.length, navigations + 1, "exactly one approved document navigation");
  t.diagnostic(
    `approval ${JSON.stringify({ before, after, navigations: log.navigations.length })}`,
  );
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      events: window.pwaTest.events,
      token: window.pwaTest.token,
      installing: registration?.installing?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
      active: registration?.active?.state ?? null,
      controller: navigator.serviceWorker.controller?.state ?? null,
    };
  });
}

test("production PWA updates on one origin", { timeout: 240_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "libras-pwa-"));
  let browser;
  let server;
  const timeline = [];
  const builds = {};
  try {
    t.diagnostic(
      `source=${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`,
    );
    await t.test(
      "build distinct pre-hashed B/C/D production documents",
      { timeout: 60_000 },
      async (t) => {
        const previousBase = process.env.BASE_PATH;
        process.env.BASE_PATH = "/webapp/";
        try {
          const { build } = await import("vite");
          for (const name of ["B", "C", "D"]) {
            const directory = path.join(temporary, name);
            await build({
              root,
              configFile: path.join(root, "vite.config.ts"),
              logLevel: "warn",
              build: { outDir: directory, emptyOutDir: true },
              plugins: [
                {
                  name: "test-document-identity",
                  transformIndexHtml: {
                    order: "post",
                    handler: () => [
                      {
                        tag: "meta",
                        attrs: { name: "pwa-test-build", content: name },
                        injectTo: "head",
                      },
                    ],
                  },
                },
              ],
            });
            builds[name] = await artifact(directory, name);
            assert(builds[name].html.includes(`name="pwa-test-build" content="${name}"`));
            t.diagnostic(
              `${name} worker=${builds[name].hash} index-revision=${builds[name].revision}`,
            );
          }
        } finally {
          if (previousBase === undefined) delete process.env.BASE_PATH;
          else process.env.BASE_PATH = previousBase;
        }
        assert.equal(new Set(Object.values(builds).map((build) => build.hash)).size, 3);
        assert.equal(new Set(Object.values(builds).map((build) => build.revision)).size, 3);
      },
    );
    assert.equal(Object.keys(builds).length, 3, "all fixtures must build before browser scenarios");
    if (process.env.PWA_OLD_DIST) {
      builds.A = await artifact(
        path.resolve(process.env.PWA_OLD_DIST),
        "A (provided old-plugin artifact)",
      );
      assert(
        !builds.A.html.includes('name="pwa-test-build"'),
        "old artifact must not have a retrofitted marker",
      );
      t.diagnostic(
        `old-artifact=${builds.A.directory} entry=${builds.A.entry} worker=${builds.A.hash}`,
      );
    }
    server = await serve(timeline);
    browser = await chromium.launch({ headless: true });
    // Each independent scenario gets a fresh context, never between versions.
    async function scenario(name, run, options = {}) {
      await t.test(name, { timeout: 60_000, ...options }, async (t) => {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          reducedMotion: "reduce",
        });
        const pages = [];
        timeline.length = 0;
        const open = async (build = builds.B) => {
          server.select(build);
          const harness = await newPage(context);
          pages.push(harness);
          await harness.page.goto(server.origin + route);
          await harness.page.locator("#settings-heading").waitFor();
          await controlled(harness.page);
          return harness;
        };
        try {
          await run({ t, context, open, pages });
          for (const { page, log } of pages) {
            assert.deepEqual(log.errors, [], "no unexpected page errors");
            t.diagnostic(
              `document ${JSON.stringify({ identity: await identity(page), ...log, native: await snapshot(page) })}`,
            );
          }
          t.diagnostic(
            timeline
              .filter(
                (entry) =>
                  entry.startsWith("SELECT") || entry.includes("sw.js") || entry.includes("503"),
              )
              .join("\n"),
          );
        } catch (error) {
          t.diagnostic(`HTTP timeline:\n${timeline.join("\n")}`);
          for (const { page, log } of pages) {
            t.diagnostic(
              `failure document ${JSON.stringify({ log, native: await snapshot(page).catch(() => null) })}`,
            );
          }
          throw error;
        } finally {
          await context.setOffline(false);
          await context.close();
        }
      });
    }

    await scenario("fresh B installation stays idle", async ({ open }) => {
      const { page, log } = await open();
      await loaded(page, "B");
      assert.equal(await action(page).count(), 0);
      assert.equal(log.navigations.length, 1);
    });

    await scenario(
      "old-plugin A upgrades to native B without storage clearing",
      async ({ open, t }) => {
        const h = await open(builds.A);
        const before = await identity(h.page);
        assert.equal(before.marker, null);
        assert.equal(before.entry, builds.A.entry);
        assert(
          await h.page.evaluate(
            (entry) => performance.getEntriesByName(new URL(entry, location.href).href).length > 0,
            builds.A.entry,
          ),
        );
        server.select(builds.B);
        await checkForUpdate(h.page);
        await waiting(h.page);
        await approve(h, "B", t);
      },
      {
        skip: builds.A
          ? false
          : "Set PWA_OLD_DIST to an untouched old-plugin /webapp/ production build.",
      },
    );

    await scenario(
      "per-tab consent and repeated C then D discovery in the original B document",
      async ({ open, context, pages, t }) => {
        const first = await open();
        const second = await newPage(context);
        pages.push(second);
        await second.page.goto(server.origin + route);
        await controlled(second.page);
        await loaded(first.page, "B");
        await loaded(second.page, "B");
        const original = await identity(first.page);
        const count = first.log.navigations.length;
        const initialEvents = (await snapshot(first.page)).events;
        const discoveries = initialEvents.filter((event) => event.type === "updatefound").length;
        const controllerChanges = initialEvents.filter(
          (event) => event.type === "controllerchange",
        ).length;
        server.select(builds.C);
        await checkForUpdate(second.page);
        await waiting(first.page);
        await waiting(second.page);
        await approve(second, "C", t);
        await first.page.waitForFunction(
          (previous) =>
            window.pwaTest.events.filter((event) => event.type === "controllerchange").length >
              previous && window.pwaTest.registration.active?.state === "activated",
          controllerChanges,
        );
        assert.deepEqual(
          await identity(first.page),
          original,
          "unapproved B document/token/URL must remain unchanged",
        );
        assert.equal(first.log.navigations.length, count);
        server.select(builds.D);
        await checkForUpdate(second.page);
        await waiting(first.page);
        const events = (await snapshot(first.page)).events;
        assert.equal(
          events.filter((event) => event.type === "updatefound").length,
          discoveries + 2,
        );
        assert.equal((await identity(first.page)).token, original.token);
        assert.equal(first.log.navigations.length, count);
        const secondToken = (await identity(second.page)).token;
        const secondNavigations = second.log.navigations.length;
        const secondChanges = (await snapshot(second.page)).events.filter(
          (event) => event.type === "controllerchange",
        ).length;
        await approve(first, "D", t);
        await second.page.waitForFunction(
          (previous) =>
            window.pwaTest.events.filter((event) => event.type === "controllerchange").length >
              previous && window.pwaTest.registration.active?.state === "activated",
          secondChanges,
        );
        assert.equal((await identity(second.page)).token, secondToken);
        assert.equal((await identity(second.page)).marker, "C");
        assert.equal(second.log.navigations.length, secondNavigations);
        t.diagnostic(`original B observed C and D before approval: ${JSON.stringify(events)}`);
      },
    );

    await scenario(
      "fully installed C applies offline through the cached shell",
      async ({ open, context, t }) => {
        const h = await open();
        server.select(builds.C);
        await checkForUpdate(h.page);
        await waiting(h.page);
        await context.setOffline(true);
        await approve(h, "C", t);
        assert.equal(
          h.log.responses.at(-1).serviceWorker,
          true,
          "offline document served by the worker",
        );
        await h.page.locator("#server-host").waitFor({ state: "attached" });
      },
    );

    await scenario("failed C precache is not offered; D recovers", async ({ open, t }) => {
      const h = await open();
      const original = await identity(h.page);
      server.select(builds.C, true);
      await checkForUpdate(h.page);
      await h.page.waitForFunction(() =>
        window.pwaTest.events.some(
          (event) => event.type === "statechange" && event.state === "redundant",
        ),
      );
      await h.page.waitForFunction(() => !window.pwaTest.registration.installing);
      assert(
        timeline.some((entry) => entry.includes("503")),
        "the precache resource actually failed",
      );
      assert.equal(await action(h.page).count(), 0);
      assert.deepEqual(await identity(h.page), original);
      assert.equal(h.log.navigations.length, 1);
      const failedInstallation = await snapshot(h.page);
      assert.equal(failedInstallation.active, "activated");
      t.diagnostic(`failed C installation with B retained: ${JSON.stringify(failedInstallation)}`);
      server.select(builds.D);
      await checkForUpdate(h.page);
      await waiting(h.page);
      await approve(h, "D", t);
    });

    await scenario(
      "new B document discovers preexisting waiting C",
      async ({ open, context, pages, t }) => {
        const holder = await open();
        const original = await identity(holder.page);
        server.select(builds.C);
        await checkForUpdate(holder.page);
        await waiting(holder.page);
        const newcomer = await newPage(context);
        pages.push(newcomer);
        await newcomer.page.goto(server.origin + route);
        await loaded(newcomer.page, "B");
        await registration(newcomer.page);
        await waiting(newcomer.page);
        assert.equal(
          (await snapshot(newcomer.page)).events.filter((event) => event.type === "updatefound")
            .length,
          0,
        );
        await approve(newcomer, "C", t);
        assert.deepEqual(await identity(holder.page), original);
        assert.equal(holder.log.navigations.length, 1);
      },
    );

    await scenario(
      "CDP bypass document with an existing active worker (when genuinely uncontrolled)",
      async ({ open, context, pages, t }) => {
        await open();
        const h = await newPage(context);
        pages.push(h);
        const session = await context.newCDPSession(h.page);
        await session.send("Network.setBypassServiceWorker", { bypass: true });
        try {
          await h.page.goto(server.origin + route);
          await loaded(h.page, "B");
          await registration(h.page);
          if (await h.page.evaluate(() => navigator.serviceWorker.controller !== null)) {
            t.skip(
              "Chromium claimed the bypassed page; uncontrolled ordering remains unit-covered.",
            );
            return;
          }
          t.diagnostic("confirmed null controller with existing active B before C installation");
          server.select(builds.C);
          await checkForUpdate(h.page);
          await waiting(h.page);
          assert.equal((await identity(h.page)).controller, null);
          await approve(h, "C", t);
        } finally {
          await session.send("Network.setBypassServiceWorker", { bypass: false });
          await session.detach();
        }
      },
    );
  } finally {
    await browser?.close();
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
