import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { atomicJson } from "./fs-utils.mjs";

export const OUTFITS_VERSION = 2;
export const OUTFIT_STATUSES = new Set(["draft", "generating", "ready", "failed"]);
export const OUTFIT_IMAGE_ROOT = "/api/import/outfits";

const PAPER = { r: 244, g: 240, b: 232 };

export function slugify(value, fallback = "outfit") {
  const slug = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function uniqueSlug(base, taken) {
  const seen = taken instanceof Set ? taken : new Set(taken || []);
  let candidate = base;
  let counter = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function stringList(value, limit = 12, itemLength = 40) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set();
  const result = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().slice(0, itemLength);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

// Normalizes an outfit record from any source (agent skill v1, builder, or
// already-normalized v2) into the canonical stored shape. Never throws on
// malformed input so a single bad record can't take down the whole file.
export function normalizeOutfit(raw = {}, existingIds = new Set()) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const baseSlug = slugify(record.id || record.slug || record.name);
  const id = existingIds.has(baseSlug) ? uniqueSlug(baseSlug, existingIds) : baseSlug;

  const garmentIds = Array.isArray(record.garmentIds)
    ? [...new Set(record.garmentIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].slice(0, 12)
    : [];

  const status = OUTFIT_STATUSES.has(record.status) ? record.status : "draft";
  const now = new Date().toISOString();

  return {
    id,
    name: text(record.name, 120) || "Untitled outfit",
    occasion: stringList(record.occasion ?? record.occasions, 8, 32),
    styleDirection: text(record.styleDirection ?? record.style ?? record.direction, 400),
    garmentIds,
    reason: text(record.reason, 400),
    setting: text(record.setting, 240),
    status,
    imageMode: ["openai", "demo"].includes(record.imageMode) ? record.imageMode : null,
    hasImage: Boolean(record.hasImage),
    error: text(record.error, 400) || null,
    source: ["builder", "agent", "demo"].includes(record.source) ? record.source : "agent",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

// Accepts the legacy `{ version, outfits }` object, a bare array, or a broken
// value, and returns a normalized list with de-duplicated ids.
export function normalizeOutfitsFile(parsed) {
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.outfits)
      ? parsed.outfits
      : [];
  const ids = new Set();
  const outfits = [];
  for (const raw of rawList) {
    const outfit = normalizeOutfit(raw, ids);
    ids.add(outfit.id);
    outfits.push(outfit);
  }
  return { version: OUTFITS_VERSION, outfits };
}

export function outfitPaths(dataDir) {
  return {
    file: path.join(dataDir, "outfits.json"),
    imageDir: path.join(dataDir, "outfit-images"),
  };
}

export async function readOutfitsFile(dataDir) {
  const { file } = outfitPaths(dataDir);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: OUTFITS_VERSION, outfits: [] };
    // A corrupt file should not brick the app; treat it as empty.
    if (error instanceof SyntaxError) return { version: OUTFITS_VERSION, outfits: [] };
    throw error;
  }
  return normalizeOutfitsFile(parsed);
}

export async function writeOutfitsFile(dataDir, data) {
  const { file } = outfitPaths(dataDir);
  await mkdir(dataDir, { recursive: true });
  await atomicJson(file, { version: OUTFITS_VERSION, outfits: data.outfits });
}

async function fileExists(target) {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Reconciles the stored `hasImage` flag with what is actually on disk, then
// projects the record into the public API shape (resolved, cache-busted url).
export async function toPublicOutfit(dataDir, outfit) {
  const { imageDir } = outfitPaths(dataDir);
  const hasImage = await fileExists(path.join(imageDir, `${outfit.id}.png`));
  const version = Date.parse(outfit.updatedAt) || 0;
  return {
    id: outfit.id,
    name: outfit.name,
    occasion: outfit.occasion,
    styleDirection: outfit.styleDirection,
    garmentIds: outfit.garmentIds,
    reason: outfit.reason,
    setting: outfit.setting,
    status: hasImage && outfit.status === "draft" ? "ready" : outfit.status,
    imageMode: outfit.imageMode,
    image: hasImage ? `${OUTFIT_IMAGE_ROOT}/${outfit.id}.png?v=${version}` : null,
    error: outfit.error,
    source: outfit.source,
    createdAt: outfit.createdAt,
    updatedAt: outfit.updatedAt,
  };
}

export async function listOutfits(dataDir) {
  const { outfits } = await readOutfitsFile(dataDir);
  const sorted = [...outfits].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return Promise.all(sorted.map((outfit) => toPublicOutfit(dataDir, outfit)));
}

export async function getOutfit(dataDir, id) {
  const { outfits } = await readOutfitsFile(dataDir);
  const outfit = outfits.find((item) => item.id === id);
  return outfit ? toPublicOutfit(dataDir, outfit) : null;
}

export async function createOutfit(dataDir, input = {}) {
  const data = await readOutfitsFile(dataDir);
  const ids = new Set(data.outfits.map((outfit) => outfit.id));
  const now = new Date().toISOString();
  const outfit = normalizeOutfit(
    { ...input, source: input.source || "builder", status: "draft", createdAt: now, updatedAt: now },
    ids,
  );
  data.outfits.push(outfit);
  await writeOutfitsFile(dataDir, data);
  return toPublicOutfit(dataDir, outfit);
}

const EDITABLE_FIELDS = ["name", "occasion", "styleDirection", "garmentIds", "reason", "setting", "status", "imageMode", "error"];

export async function updateOutfit(dataDir, id, patch = {}) {
  const data = await readOutfitsFile(dataDir);
  const index = data.outfits.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const merged = { ...data.outfits[index] };
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
  }
  const ids = new Set(data.outfits.filter((_, position) => position !== index).map((item) => item.id));
  const normalized = normalizeOutfit({ ...merged, id }, ids);
  normalized.id = id;
  normalized.createdAt = data.outfits[index].createdAt;
  normalized.updatedAt = new Date().toISOString();
  data.outfits[index] = normalized;
  await writeOutfitsFile(dataDir, data);
  return toPublicOutfit(dataDir, normalized);
}

export async function deleteOutfit(dataDir, id) {
  const data = await readOutfitsFile(dataDir);
  const next = data.outfits.filter((item) => item.id !== id);
  if (next.length === data.outfits.length) return false;
  await writeOutfitsFile(dataDir, { ...data, outfits: next });
  const { imageDir } = outfitPaths(dataDir);
  await rm(path.join(imageDir, `${id}.png`), { force: true });
  return true;
}

// Deterministic, OpenAI-free flat-lay: arranges the transparent garment
// cutouts on the app's paper background so the builder produces a real,
// usable preview with no API key or model reference.
export async function composeOutfitPreview(garments, options = {}) {
  const size = options.size || 1024;
  const usable = (garments || []).filter((buffer) => buffer && buffer.length);
  const canvas = sharp({
    create: { width: size, height: size, channels: 4, background: { ...PAPER, alpha: 1 } },
  });
  if (!usable.length) {
    return canvas.png().toBuffer();
  }

  const columns = Math.min(usable.length, usable.length <= 2 ? usable.length : Math.ceil(Math.sqrt(usable.length)));
  const rows = Math.ceil(usable.length / columns);
  const margin = Math.round(size * 0.06);
  const gap = Math.round(size * 0.03);
  const cellWidth = Math.floor((size - margin * 2 - gap * (columns - 1)) / columns);
  const cellHeight = Math.floor((size - margin * 2 - gap * (rows - 1)) / rows);
  const cell = Math.max(1, Math.min(cellWidth, cellHeight));
  const gridWidth = cell * columns + gap * (columns - 1);
  const gridHeight = cell * rows + gap * (rows - 1);
  const originX = Math.round((size - gridWidth) / 2);
  const originY = Math.round((size - gridHeight) / 2);

  const composites = [];
  for (let index = 0; index < usable.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const resized = await sharp(usable[index])
      .resize(cell, cell, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = originX + column * (cell + gap) + Math.floor((cell - resized.info.width) / 2);
    const top = originY + row * (cell + gap) + Math.floor((cell - resized.info.height) / 2);
    composites.push({ input: resized.data, left, top });
  }
  return canvas.composite(composites).png().toBuffer();
}
