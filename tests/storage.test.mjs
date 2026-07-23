import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  normalizeStorageKey,
  normalizeBasename,
  basenameFromUrl,
  garmentFilename,
  modeledFilename,
  libraryAssetKey,
  libraryAssetUrl,
  outfitImageKey,
  jobKey,
  jobAssetKey,
} from "../api/_lib/keys.mjs";
import {
  createLocalStore,
  BlobStore,
  blobAuth,
  blobConfigured,
  getStore,
  resetStoreCache,
} from "../api/_lib/storage.mjs";
import { handleImportApi, handleBulkImport, MAX_UPLOAD_BYTES } from "../api/_lib/backend.mjs";

describe("normalizeStorageKey", () => {
  it("collapses slashes and trims", () => {
    expect(normalizeStorageKey("/a//b/")).toBe("a/b");
    expect(normalizeStorageKey("a\\b\\c")).toBe("a/b/c");
  });

  it("sanitizes illegal characters within a segment", () => {
    expect(normalizeStorageKey("wei rd name!.png")).toBe("wei-rd-name-.png");
  });

  it("drops current-dir segments", () => {
    expect(normalizeStorageKey("a/./b")).toBe("a/b");
  });

  it("throws on path traversal", () => {
    expect(() => normalizeStorageKey("a/../b")).toThrow();
    expect(() => normalizeStorageKey("../etc/passwd")).toThrow();
  });

  it("throws on empty / non-string input", () => {
    expect(() => normalizeStorageKey("")).toThrow();
    expect(() => normalizeStorageKey("   ")).toThrow();
    expect(() => normalizeStorageKey(null)).toThrow();
  });
});

describe("key + url builders", () => {
  it("builds deterministic asset filenames and keys", () => {
    expect(garmentFilename("import-abc")).toBe("import-abc-garment.png");
    expect(modeledFilename("import-abc")).toBe("import-abc-modeled.png");
    expect(libraryAssetKey("import-abc-garment.png")).toBe("imported/import-abc-garment.png");
    expect(libraryAssetUrl("import-abc-garment.png")).toBe("/api/import/library/import-abc-garment.png");
    expect(outfitImageKey("evening")).toBe("outfit-images/evening.png");
    expect(jobKey("job1")).toBe("jobs/job1/job.json");
    expect(jobAssetKey("job1", "crop.png")).toBe("jobs/job1/crop.png");
  });

  it("normalizeBasename reduces to a single safe segment and blocks traversal", () => {
    expect(normalizeBasename("a/b/c.png")).toBe("c.png");
    expect(() => normalizeBasename("../x")).toThrow();
  });

  it("basenameFromUrl extracts the trailing filename, ignoring query/hash", () => {
    expect(basenameFromUrl("/api/import/library/g1-garment.png")).toBe("g1-garment.png");
    expect(basenameFromUrl("/api/import/outfits/e.png?v=3")).toBe("e.png");
    expect(basenameFromUrl(null)).toBeNull();
    expect(basenameFromUrl("")).toBeNull();
  });
});

describe("LocalStore round-trips", () => {
  const dirs = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function store() {
    const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-store-"));
    dirs.push(dir);
    return createLocalStore(dir);
  }

  it("reads back JSON and falls back for missing keys", async () => {
    const s = await store();
    expect(await s.readJson("library.json", [])).toEqual([]);
    await s.writeJson("library.json", [{ id: "x" }]);
    expect(await s.readJson("library.json", [])).toEqual([{ id: "x" }]);
  });

  it("stores and serves image bytes with a content type", async () => {
    const s = await store();
    const bytes = Buffer.from("89504e47", "hex");
    await s.putImage("imported/x-garment.png", bytes, "image/png");
    expect(await s.exists("imported/x-garment.png")).toBe(true);
    const asset = await s.getImage("imported/x-garment.png");
    expect(asset.contentType).toBe("image/png");
    expect(asset.data.equals(bytes)).toBe(true);
    expect(await s.getImage("imported/missing.png")).toBeNull();
  });

  it("deletes keys", async () => {
    const s = await store();
    await s.writeJson("a.json", { ok: true });
    await s.del("a.json");
    expect(await s.readJson("a.json", null)).toBeNull();
  });
});

describe("handleImportApi validation (LocalStore)", () => {
  const dirs = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function ctx(extra = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-api-"));
    dirs.push(dir);
    return { store: createLocalStore(dir), env: {}, body: {}, query: {}, ...extra };
  }

  it("reports setup status via config (not ready without key or reference)", async () => {
    const base = await ctx();
    const result = await handleImportApi({ ...base, method: "GET", segments: ["config"] });
    expect(result.status).toBe(200);
    expect(result.json.ready).toBe(false);
    expect(result.json.hasApiKey).toBe(false);
    expect(result.json.hasModelReference).toBe(false);
  });

  it("returns an empty wardrobe initially", async () => {
    const base = await ctx();
    const result = await handleImportApi({ ...base, method: "GET", segments: ["wardrobe"] });
    expect(result.status).toBe(200);
    expect(result.json).toEqual([]);
  });

  it("blocks job creation until setup is complete (503)", async () => {
    const base = await ctx();
    const result = await handleImportApi({
      ...base,
      method: "POST",
      segments: ["jobs"],
      body: { imageBase64: Buffer.from("x").toString("base64") },
    });
    expect(result.status).toBe(503);
  });

  it("rejects outfit creation with no garments (400)", async () => {
    const base = await ctx();
    const result = await handleImportApi({ ...base, method: "POST", segments: ["outfits"], body: { garmentIds: [] } });
    expect(result.status).toBe(400);
  });

  it("404s for unknown routes and missing assets", async () => {
    const base = await ctx();
    expect((await handleImportApi({ ...base, method: "GET", segments: ["nope"] })).status).toBe(404);
    expect((await handleImportApi({ ...base, method: "GET", segments: ["library", "missing.png"] })).status).toBe(404);
  });
});

describe("handleBulkImport (LocalStore, no OpenAI)", () => {
  const dirs = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function store() {
    const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-bulk-"));
    dirs.push(dir);
    return createLocalStore(dir);
  }
  let pngDataUrl;
  beforeAll(async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 180, b: 160, alpha: 1 } } })
      .png()
      .toBuffer();
    pngDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  });

  it("rejects an unknown kind", async () => {
    const s = await store();
    const result = await handleBulkImport({ store: s, env: {}, body: { kind: "banana" } });
    expect(result.status).toBe(400);
  });

  it("stores the private reference photo", async () => {
    const s = await store();
    const result = await handleBulkImport({ store: s, env: {}, body: { kind: "reference", imageDataUrl: pngDataUrl } });
    expect(result.status).toBe(200);
    expect(await s.exists("private/model-reference.png")).toBe(true);
  });

  it("imports a garment and records it in the library", async () => {
    const s = await store();
    const result = await handleBulkImport({
      store: s,
      env: {},
      body: { kind: "garment", id: "abc", imageDataUrl: pngDataUrl, metadata: { name: "Tee", part: "upperbody" } },
    });
    expect(result.status).toBe(200);
    expect(result.json.record.id).toBe("import-abc");
    const library = await s.readJson("library.json", []);
    expect(library).toHaveLength(1);
    expect(library[0].name).toBe("Tee");
    expect(await s.exists("imported/import-abc-garment.png")).toBe(true);
  });

  it("rejects oversized uploads (413)", async () => {
    const s = await store();
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1).toString("base64");
    const result = await handleBulkImport({ store: s, env: {}, body: { kind: "garment", imageBase64: big, mimeType: "image/png" } });
    expect(result.status).toBe(413);
  });
});

// A fake @vercel/blob module backed by an in-memory map. Records the options
// passed to each call so we can assert private access + auth threading, and
// round-trips bytes so read paths can be exercised without the network.
function fakeBlobModule() {
  const objects = new Map();
  const calls = { put: [], get: [], head: [], del: [], list: [] };
  const toStream = (buffer) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
  return {
    calls,
    objects,
    async put(pathname, body, options) {
      calls.put.push({ pathname, options });
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      objects.set(pathname, { buffer, contentType: options.contentType || "application/octet-stream" });
      return { url: `https://store.example/${pathname}`, pathname };
    },
    async get(pathname, options) {
      calls.get.push({ pathname, options });
      const stored = objects.get(pathname);
      if (!stored) return null;
      return {
        statusCode: 200,
        stream: toStream(stored.buffer),
        headers: new Headers({ "content-type": stored.contentType }),
        blob: { contentType: stored.contentType, size: stored.buffer.length },
      };
    },
    async head(pathname, options) {
      calls.head.push({ pathname, options });
      if (!objects.has(pathname)) throw Object.assign(new Error("not found"), { name: "BlobNotFoundError" });
      return { pathname, url: `https://store.example/${pathname}` };
    },
    async del(pathname, options) {
      calls.del.push({ pathname, options });
      objects.delete(pathname);
    },
    async list({ prefix, ...options }) {
      calls.list.push({ prefix, options });
      const blobs = [...objects.keys()].filter((key) => key.startsWith(prefix)).map((pathname) => ({ pathname }));
      return { blobs };
    },
  };
}

describe("BlobStore uses private access + auth", () => {
  it("writes with access:'private' and the provided auth", async () => {
    const blob = fakeBlobModule();
    const store = new BlobStore(blob, { token: "rw-token" });
    await store.writeJson("library.json", [{ id: "x" }]);
    await store.putImage("imported/x-garment.png", Buffer.from("bytes"), "image/png");
    expect(blob.calls.put).toHaveLength(2);
    for (const call of blob.calls.put) {
      expect(call.options.access).toBe("private");
      expect(call.options.token).toBe("rw-token");
    }
  });

  it("reads with access:'private' and round-trips bytes", async () => {
    const blob = fakeBlobModule();
    const store = new BlobStore(blob, { token: "rw-token" });
    const bytes = Buffer.from("89504e47", "hex");
    await store.putImage("imported/y.png", bytes, "image/png");
    const asset = await store.getImage("imported/y.png");
    expect(asset.data.equals(bytes)).toBe(true);
    expect(asset.contentType).toBe("image/png");
    expect(blob.calls.get.every((call) => call.options.access === "private")).toBe(true);
    expect(await store.readJson("missing.json", "fallback")).toBe("fallback");
  });

  it("threads OIDC auth (oidcToken + storeId) into every call", async () => {
    const blob = fakeBlobModule();
    const store = new BlobStore(blob, { oidcToken: "oidc", storeId: "store_123" });
    await store.writeJson("a.json", { ok: true });
    await store.readJson("a.json", null);
    await store.exists("a.json");
    await store.del("a.json");
    await store.list("imported");
    const everyCall = [...blob.calls.put, ...blob.calls.get, ...blob.calls.head, ...blob.calls.del, ...blob.calls.list];
    for (const call of everyCall) {
      expect(call.options.oidcToken).toBe("oidc");
      expect(call.options.storeId).toBe("store_123");
      expect(call.options.token).toBeUndefined();
    }
  });

  it("reports existence via head and treats not-found as absent", async () => {
    const blob = fakeBlobModule();
    const store = new BlobStore(blob, { token: "t" });
    expect(await store.exists("private/model-reference.png")).toBe(false);
    await store.putImage("private/model-reference.png", Buffer.from("x"), "image/png");
    expect(await store.exists("private/model-reference.png")).toBe(true);
  });
});

describe("blobAuth / blobConfigured", () => {
  it("prefers OIDC when both OIDC and a read-write token are present", () => {
    const auth = blobAuth({ VERCEL_OIDC_TOKEN: "oidc", BLOB_STORE_ID: "s", BLOB_READ_WRITE_TOKEN: "rw" });
    expect(auth).toEqual({ oidcToken: "oidc", storeId: "s" });
  });

  it("falls back to a read-write token", () => {
    expect(blobAuth({ BLOB_READ_WRITE_TOKEN: "rw" })).toEqual({ token: "rw" });
  });

  it("requires BOTH OIDC token and store id for OIDC mode", () => {
    expect(blobAuth({ VERCEL_OIDC_TOKEN: "oidc" })).toBeNull();
    expect(blobAuth({ BLOB_STORE_ID: "s" })).toBeNull();
  });

  it("returns null / not-configured when nothing is set", () => {
    expect(blobAuth({})).toBeNull();
    expect(blobConfigured({})).toBe(false);
    expect(blobConfigured({ BLOB_READ_WRITE_TOKEN: "rw" })).toBe(true);
  });
});

describe("getStore fails closed on Vercel without a private Blob store", () => {
  afterEach(() => resetStoreCache());

  it("throws an exposable 503 on Vercel with no Blob configured", async () => {
    resetStoreCache();
    await expect(getStore({ VERCEL: "1" })).rejects.toMatchObject({ status: 503, expose: true });
    resetStoreCache();
    await expect(getStore({ VERCEL_ENV: "production" })).rejects.toMatchObject({ status: 503 });
  });

  it("does NOT fall back to the filesystem on Vercel", async () => {
    resetStoreCache();
    let store = null;
    try {
      store = await getStore({ VERCEL: "1" });
    } catch {
      /* expected */
    }
    expect(store).toBeNull();
  });

  it("uses the private Blob backend when a read-write token is configured", async () => {
    resetStoreCache();
    const store = await getStore({ VERCEL: "1", BLOB_READ_WRITE_TOKEN: "rw" });
    expect(store.backend).toBe("blob");
  });

  it("allows the filesystem fallback only off Vercel (local dev/tests)", async () => {
    resetStoreCache();
    const store = await getStore({ WARDROBE_DATA_DIR: "data" });
    expect(store.backend).toBe("local");
  });
});
