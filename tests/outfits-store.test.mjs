import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  OUTFITS_VERSION,
  composeOutfitPreview,
  createOutfit,
  deleteOutfit,
  getOutfit,
  listOutfits,
  normalizeOutfit,
  normalizeOutfitsFile,
  outfitPaths,
  readOutfitsFile,
  slugify,
  uniqueSlug,
  updateOutfit,
} from "../scripts/outfits-store.mjs";

let dataDir;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "wardrobe-outfits-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function swatch(hex) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return sharp({ create: { width: 64, height: 64, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
}

describe("slugify / uniqueSlug", () => {
  it("produces stable lowercase hyphenated slugs", () => {
    expect(slugify("Navy & Camel Classic")).toBe("navy-camel-classic");
    expect(slugify("   ")).toBe("outfit");
    expect(slugify("", "look")).toBe("look");
  });

  it("de-duplicates against taken ids", () => {
    const taken = new Set(["look", "look-2"]);
    expect(uniqueSlug("look", taken)).toBe("look-3");
    expect(uniqueSlug("fresh", taken)).toBe("fresh");
  });
});

describe("normalizeOutfit", () => {
  it("fills defaults and clamps fields", () => {
    const outfit = normalizeOutfit({ name: "  Weekend  ", garmentIds: ["a", "a", " b "], occasion: "casual, casual, weekend" });
    expect(outfit.name).toBe("Weekend");
    expect(outfit.garmentIds).toEqual(["a", "b"]);
    expect(outfit.occasion).toEqual(["casual", "weekend"]);
    expect(outfit.status).toBe("draft");
    expect(outfit.source).toBe("agent");
  });

  it("never throws on malformed input", () => {
    expect(() => normalizeOutfit(null)).not.toThrow();
    expect(() => normalizeOutfit(42)).not.toThrow();
    const outfit = normalizeOutfit(undefined);
    expect(outfit.name).toBe("Untitled outfit");
    expect(outfit.garmentIds).toEqual([]);
  });

  it("assigns a unique id when the slug is taken", () => {
    const first = normalizeOutfit({ name: "Look" }, new Set());
    const second = normalizeOutfit({ name: "Look" }, new Set([first.id]));
    expect(first.id).toBe("look");
    expect(second.id).toBe("look-2");
  });
});

describe("normalizeOutfitsFile", () => {
  it("accepts the v1 array shape", () => {
    const result = normalizeOutfitsFile([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    expect(result.version).toBe(OUTFITS_VERSION);
    expect(result.outfits.map((outfit) => outfit.id)).toEqual(["a", "b"]);
  });

  it("accepts the { version, outfits } object and de-duplicates ids", () => {
    const result = normalizeOutfitsFile({ version: 1, outfits: [{ id: "look" }, { id: "look" }] });
    expect(result.outfits.map((outfit) => outfit.id)).toEqual(["look", "look-2"]);
  });

  it("treats broken input as an empty collection", () => {
    expect(normalizeOutfitsFile("nonsense").outfits).toEqual([]);
    expect(normalizeOutfitsFile(null).outfits).toEqual([]);
  });
});

describe("file persistence", () => {
  it("returns an empty collection when no file exists", async () => {
    const data = await readOutfitsFile(dataDir);
    expect(data).toEqual({ version: OUTFITS_VERSION, outfits: [] });
  });

  it("treats a corrupt file as empty rather than throwing", async () => {
    const { file } = outfitPaths(dataDir);
    await writeFile(file, "{ not json");
    const data = await readOutfitsFile(dataDir);
    expect(data.outfits).toEqual([]);
  });

  it("supports the create / read / update / delete lifecycle", async () => {
    const created = await createOutfit(dataDir, { name: "Test Look", garmentIds: ["g1", "g2"], occasion: ["casual"] });
    expect(created.id).toBe("test-look");
    expect(created.status).toBe("draft");
    expect(created.source).toBe("builder");

    const listed = await listOutfits(dataDir);
    expect(listed).toHaveLength(1);

    const fetched = await getOutfit(dataDir, created.id);
    expect(fetched.name).toBe("Test Look");

    const updated = await updateOutfit(dataDir, created.id, { name: "Renamed", garmentIds: ["g1"] });
    expect(updated.name).toBe("Renamed");
    expect(updated.garmentIds).toEqual(["g1"]);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);

    expect(await deleteOutfit(dataDir, created.id)).toBe(true);
    expect(await getOutfit(dataDir, created.id)).toBeNull();
    expect(await deleteOutfit(dataDir, created.id)).toBe(false);
  });

  it("reconciles hasImage and status with the file on disk", async () => {
    const created = await createOutfit(dataDir, { name: "Imaged", garmentIds: ["g1"] });
    const { imageDir } = outfitPaths(dataDir);
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, `${created.id}.png`), await swatch("#334455"));
    const fetched = await getOutfit(dataDir, created.id);
    expect(fetched.image).toMatch(new RegExp(`/api/import/outfits/${created.id}\\.png`));
    expect(fetched.status).toBe("ready");
  });

  it("removes the image file on delete", async () => {
    const created = await createOutfit(dataDir, { name: "Imaged", garmentIds: ["g1"] });
    const { imageDir } = outfitPaths(dataDir);
    await mkdir(imageDir, { recursive: true });
    const image = path.join(imageDir, `${created.id}.png`);
    await writeFile(image, await swatch("#334455"));
    await deleteOutfit(dataDir, created.id);
    await expect(readFile(image)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("composeOutfitPreview", () => {
  it("returns a valid PNG for a set of garments", async () => {
    const buffers = await Promise.all([swatch("#aa3344"), swatch("#3344aa"), swatch("#44aa33")]);
    const output = await composeOutfitPreview(buffers, { size: 256 });
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("returns a blank canvas when given no garments", async () => {
    const output = await composeOutfitPreview([], { size: 128 });
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(128);
  });
});
