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
import { createLocalStore } from "../api/_lib/storage.mjs";
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
