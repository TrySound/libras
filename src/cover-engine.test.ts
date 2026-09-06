import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverEngine, type CoverRequest } from "./cover-engine";
import { SubsonicClient } from "./subsonic-client";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

function installOpfs(
  cached = false,
  metadata: { etag?: string; lastModified?: string; type: string } = { type: "image/jpeg" },
) {
  const files = new Map<string, File>();
  const handles = new Map<
    string,
    {
      createWritable(): Promise<WritableStream<Uint8Array>>;
      getFile(): Promise<File>;
    }
  >();

  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (cached && !files.has(name)) {
        files.set(
          name,
          name.endsWith(".json")
            ? new File([JSON.stringify(metadata)], name)
            : new File(["image"], name),
        );
      }
      if (!files.has(name) && !options?.create) throw new DOMException("Missing", "NotFoundError");
      if (!handles.has(name)) {
        handles.set(name, {
          async createWritable() {
            const chunks: BlobPart[] = [];
            const commit = () => {
              files.set(name, new File(chunks, name));
            };
            const stream = new WritableStream<Uint8Array>({
              write(chunk) {
                chunks.push(chunk.slice().buffer as ArrayBuffer);
              },
              close: commit,
              abort() {
                files.delete(name);
              },
            });
            return Object.assign(stream, {
              async write(chunk: BlobPart) {
                chunks.push(chunk);
              },
              async close() {
                commit();
              },
              async abort() {
                files.delete(name);
              },
            });
          },
          async getFile() {
            const file = files.get(name);
            if (!file) throw new DOMException("Missing", "NotFoundError");
            return file;
          },
        });
      }
      return handles.get(name)!;
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };

  vi.stubGlobal("navigator", {
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          },
        };
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cover engine", () => {
  it("reactively resolves a cached object URL", async () => {
    installOpfs(true);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-cover");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const request = { candidates: ["cover-1"], allowNetwork: true };
    const cover = engine.getCover(request);

    expect(cover.source).toBeUndefined();
    expect(engine.getCover(request)).toBe(cover);
    await vi.waitFor(() => expect(cover.source).toBe("blob:cached-cover"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates cached covers and publishes changed images", async () => {
    installOpfs(true, { type: "image/jpeg", etag: '"old"' });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:cached-cover")
      .mockReturnValueOnce("blob:updated-cover");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetcher = vi.fn(
      async (..._arguments: Parameters<typeof fetch>) =>
        new Response("updated", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const request = { candidates: ["cover-1"], allowNetwork: true };

    await vi.waitFor(() => expect(engine.getCover(request).source).toBe("blob:updated-cover"));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("If-None-Match")).toBe('"old"');
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cached-cover");
  });

  it("uses the first cached fallback", async () => {
    installOpfs(true);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fallback-cover");
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const request = {
      candidates: [undefined, "album-cover", "track-cover"],
      allowNetwork: false,
    };

    await vi.waitFor(() => expect(engine.getCover(request).source).toBe("blob:fallback-cover"));
  });

  it("resolves a Navidrome URL and caches it after loading", async () => {
    installOpfs();
    const fetcher = vi.fn(
      async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const request: CoverRequest = { candidates: ["cover-1"], allowNetwork: true };

    let source: string | undefined;
    await vi.waitFor(() => {
      source = engine.getCover(request).source;
      expect(source).toContain("/rest/getCoverArt.view?");
    });
    const cover = engine.getCover(request);
    expect(cover.cache()).toBeUndefined();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  });

  it("updates existing cache-only handles when a UI cover finishes caching", async () => {
    installOpfs();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-cover");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } })),
    );
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const cached = engine.getCover({ candidates: ["cover-1"], allowNetwork: false });
    const online = engine.getCover({ candidates: ["cover-1"], allowNetwork: true });
    await vi.waitFor(() => expect(online.source).toContain("/rest/getCoverArt.view?"));
    expect(cached.source).toBeUndefined();
    online.cache();
    await vi.waitFor(() => expect(cached.source).toBe("blob:new-cover"));
    engine.destroy();
  });

  it("builds cached URLs from a memory snapshot rather than an OPFS file", async () => {
    installOpfs(true);
    const arrayBuffer = vi.spyOn(File.prototype, "arrayBuffer");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:snapshot");
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const cover = engine.getCover({ candidates: ["cover-1"], allowNetwork: false });
    await vi.waitFor(() => expect(cover.source).toBe("blob:snapshot"));
    expect(arrayBuffer).toHaveBeenCalled();
    engine.destroy();
  });

  it("does not resolve a server URL when network access is disabled", async () => {
    installOpfs();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setClient(new SubsonicClient(auth));
    const request = { candidates: ["cover-1"], allowNetwork: false };

    expect(engine.getCover(request).source).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve));
    expect(engine.getCover(request).source).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
