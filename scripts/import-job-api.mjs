import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Seeded into categories.json the first time it's read. Ids match the part
// values already persisted on every existing wardrobe item, so no migration
// is needed; anything created afterwards through the settings UI gets a
// generated cat_/sub_ id instead.
const DEFAULT_CATEGORIES = [
  { id: "upperbody", label: "Tops", singular: "Top", isCounted: false, subcategories: [] },
  {
    id: "wholebody_up", label: "Jackets", singular: "Jacket", isCounted: false,
    subcategories: [
      { id: "sub_gilets", name: "Gilets" },
      { id: "sub_coats", name: "Coats" },
      { id: "sub_zip_up_hoodies", name: "Zip up hoodies" },
      { id: "sub_hoodies", name: "Hoodies" },
    ],
  },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom", isCounted: false, subcategories: [] },
  {
    id: "accessories_up", label: "Accessories", singular: "Accessory", isCounted: false,
    subcategories: [
      { id: "sub_ties", name: "Ties" },
      { id: "sub_hats", name: "Hats" },
      { id: "sub_glasses", name: "Glasses" },
      { id: "sub_watches", name: "Watches" },
      { id: "sub_jewellery", name: "Jewellery" },
    ],
  },
  {
    id: "shoes", label: "Shoes", singular: "Shoes", isCounted: false,
    subcategories: [
      { id: "sub_high_tops", name: "High Tops" },
      { id: "sub_trainers", name: "Trainers" },
      { id: "sub_dress_shoes", name: "Dress" },
    ],
  },
  { id: "socks", label: "Socks", singular: "Socks", isCounted: true, subcategories: [] },
  { id: "underwear", label: "Underwear", singular: "Underwear", isCounted: true, subcategories: [] },
];

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[mime] || "png";
}

function decodeImage(input) {
  const raw = input.imageDataUrl || input.imageBase64;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl or imageBase64 is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || input.mimeType || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

function normalizeMetadata(value = {}, categoryIds, fallbackPart) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: categoryIds?.has(metadata.part) ? metadata.part : fallbackPart,
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

// Claude's vision API rejects any single image over 5MB, and never benefits from
// more than ~1568px on the long edge (larger just gets downscaled server-side).
// A lossless PNG re-encode of a detailed phone photo can easily blow past 5MB even
// though the source JPEG was small, so the analysis call gets its own downsized,
// re-compressed copy instead of reusing the full-resolution PNG used for cropping.
async function prepareVisionImage(bytes) {
  const CLAUDE_IMAGE_LIMIT = 4.5 * 1024 * 1024;
  let quality = 90;
  let buffer = await sharp(bytes).rotate().toColorspace("srgb").resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  while (buffer.length > CLAUDE_IMAGE_LIMIT && quality > 35) {
    quality -= 15;
    buffer = await sharp(bytes).rotate().toColorspace("srgb").resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  }
  return buffer;
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  let left = Math.max(0, Math.floor(rawLeft - padding));
  let top = Math.max(0, Math.floor(rawTop - padding));
  let right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  let bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  // Small items (glasses, watches, jewelry) can have tiny bounding boxes relative
  // to a full photo; the padding above stays proportionally tiny too, producing an
  // unrecognizable extreme close-up. Enforce a floor on the crop's absolute size so
  // there's always enough surrounding context to recognize the item.
  const minDimension = Math.round(Math.min(width, height) * 0.22);
  if (right - left < minDimension) {
    const deficit = minDimension - (right - left);
    left = Math.max(0, left - Math.ceil(deficit / 2));
    right = Math.min(width, right + Math.ceil(deficit / 2));
  }
  if (bottom - top < minDimension) {
    const deficit = minDimension - (bottom - top);
    top = Math.max(0, top - Math.ceil(deficit / 2));
    bottom = Math.min(height, bottom + Math.ceil(deficit / 2));
  }
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(colors) {
  const values = (Array.isArray(colors) ? colors : [colors]).filter((value) => HEX_COLOR.test(value || ""));
  const sources = (values.length ? values : ["#808080"]).map((value) => [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const distance = (source, candidate) => candidate.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
  // Pick the candidate that stays farthest from the *closest* garment color, not just
  // the primary — a key chosen only against a dark primary can still share a dominant
  // channel with a saturated secondary/accent color (e.g. magenta vs. a red logo),
  // which then causes the background-spill cleanup to strip that color from the logo too.
  const selected = candidates
    .map((candidate) => ({ candidate, worstCase: Math.min(...sources.map((source) => distance(source, candidate))) }))
    .sort((a, b) => b.worstCase - a.worstCase)[0].candidate;
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, quality }) {
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

function wardrobeItemsSchema(categoryIds) {
  return {
    type: "object", additionalProperties: false, properties: { items: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: categoryIds }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" } }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"],
  };
}

async function claudeAnalyzeGarments({ key, model, image, mime, categories }) {
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey: key });
  const categoryIds = categories.map((category) => category.id);
  const categoryList = categories.map((category) => `${category.id} (${category.label})`).join(", ");
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    output_config: { format: { type: "json_schema", schema: wardrobeItemsSchema(categoryIds) } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: image.toString("base64") } },
        { type: "text", text: `Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: ${categoryList}. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags.` },
      ],
    }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) throw new Error("Claude analysis returned no structured result");
  const parsed = JSON.parse(textBlock.text);
  if (!Array.isArray(parsed.items)) throw new Error("Claude analysis returned an invalid clothing list");
  return parsed.items;
}

export function wardrobeImportApi(options = {}) {
  let root;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  let locationsFile;
  let categoriesFile;
  let outfitsFile;
  const running = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  async function setupStatus() {
    const hasAnthropicKey = Boolean(setting("ANTHROPIC_API_KEY").trim());
    const hasOpenAIKey = Boolean(setting("OPENAI_API_KEY").trim());
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    const referencePath = path.resolve(root, referenceSetting);
    let hasModelReference = false;
    try {
      hasModelReference = (await stat(referencePath)).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      ready: hasAnthropicKey && hasOpenAIKey && hasModelReference,
      hasAnthropicKey,
      hasOpenAIKey,
      hasModelReference,
      modelReference: referenceSetting,
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  function normalizeLibraryRecord(record) {
    return {
      brand: null,
      model: null,
      subcategory: null,
      locationId: null,
      count: 1,
      dirtyCount: 0,
      packedCount: 0,
      wearCount: 0,
      washCount: 0,
      lastWornAt: null,
      lastWashedAt: null,
      ...record,
    };
  }

  async function loadImported() {
    try {
      const records = JSON.parse(await readFile(importedFile, "utf8"));
      return Array.isArray(records) ? records.map(normalizeLibraryRecord) : [];
    }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function loadLocations() {
    try {
      const records = JSON.parse(await readFile(locationsFile, "utf8"));
      return Array.isArray(records) ? records : [];
    }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  function normalizeCategoryRecord(category) {
    return {
      id: category.id,
      label: category.label,
      singular: category.singular || category.label,
      isCounted: Boolean(category.isCounted),
      subcategories: Array.isArray(category.subcategories)
        ? category.subcategories.filter((sub) => sub && typeof sub.id === "string" && typeof sub.name === "string")
        : [],
    };
  }

  async function seedCategories() {
    const seeded = structuredClone(DEFAULT_CATEGORIES);
    await atomicJson(categoriesFile, seeded);
    return seeded;
  }

  async function loadCategories() {
    try {
      const records = JSON.parse(await readFile(categoriesFile, "utf8"));
      if (!Array.isArray(records) || !records.length) return seedCategories();
      return records.map(normalizeCategoryRecord);
    }
    catch (error) { if (error.code === "ENOENT") return seedCategories(); throw error; }
  }

  function normalizeOutfitRecord(outfit) {
    return {
      id: outfit.id,
      name: outfit.name || "Untitled outfit",
      garmentIds: Array.isArray(outfit.garmentIds) ? outfit.garmentIds.filter((id) => typeof id === "string") : [],
      occasion: outfit.occasion || null,
      style: outfit.style || null,
      setting: outfit.setting || null,
      notes: outfit.notes || null,
      createdAt: outfit.createdAt || new Date().toISOString(),
      updatedAt: outfit.updatedAt || outfit.createdAt || new Date().toISOString(),
    };
  }

  async function loadOutfits() {
    try {
      const records = JSON.parse(await readFile(outfitsFile, "utf8"));
      return Array.isArray(records) ? records.map(normalizeOutfitRecord) : [];
    }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  // One-time migration: an earlier version of this app stored subcategory as
  // a raw display name (e.g. "Gilets") instead of a stable id. Resolve any
  // leftover name-shaped values against the current category's subcategories
  // by name, or clear them if nothing matches anymore.
  async function migrateLegacySubcategories() {
    const categories = await loadCategories();
    const categoryMap = new Map(categories.map((category) => [category.id, category]));
    const records = await loadImported();
    let changed = false;
    const next = records.map((record) => {
      if (!record.subcategory) return record;
      const category = categoryMap.get(record.part);
      const subcategories = category?.subcategories || [];
      if (subcategories.some((sub) => sub.id === record.subcategory)) return record;
      const match = subcategories.find((sub) => sub.name.toLowerCase() === String(record.subcategory).toLowerCase());
      changed = true;
      return { ...record, subcategory: match ? match.id : null };
    });
    if (changed) await atomicJson(importedFile, next);
  }

  async function persistImported(job, includeModeled = false) {
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await copyFile(path.join(jobsDir, job.id, modeledSource), path.join(libraryAssetDir, modeledName));
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported();
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      brand: existing?.brand ?? null,
      model: existing?.model ?? null,
      subcategory: existing?.subcategory ?? null,
      locationId: existing?.locationId ?? null,
      count: existing?.count ?? 1,
      dirtyCount: existing?.dirtyCount ?? 0,
      packedCount: existing?.packedCount ?? 0,
      wearCount: existing?.wearCount ?? 0,
      washCount: existing?.washCount ?? 0,
      lastWornAt: existing?.lastWornAt ?? null,
      lastWashedAt: existing?.lastWashedAt ?? null,
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await atomicJson(importedFile, next);
    return record;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey([current.metadata.color, current.metadata.secondaryColor]);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "medium"), size: "1024x1024", images: [original], prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt });
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), bytes);
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garmentName = current.stages.garment.assetUrl
            ? path.basename(new URL(current.stages.garment.assetUrl, "http://localhost").pathname)
            : `garment-${current.stages.garment.attempts}.png`;
          const garmentFile = path.join(dir, garmentName);
          const garment = { data: await readFile(garmentFile), mime: "image/png", name: "garment.png" };
          const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
          let modelData;
          try {
            modelData = await readFile(modelPath);
          } catch (error) {
            if (error.code === "ENOENT") throw new Error(`Model reference not found at ${modelPath}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
            throw error;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const basePrompt = options.modeledPrompt || "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "medium"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt });
        }
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        // The job directory can vanish mid-flight (user deleted/rejected it while this
        // generation call was still running against OpenAI) — loadJob then returns null.
        // Skip the write rather than crashing the whole process on a null dereference.
        if (!fresh) return;
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, await loadImported());
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      if (url.pathname === "/api/import/locations" && req.method === "GET") {
        return json(res, 200, await loadLocations());
      }
      if (url.pathname === "/api/import/locations" && req.method === "POST") {
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
        if (!name) throw Object.assign(new Error("A location name is required"), { status: 400 });
        const locations = await loadLocations();
        const location = { id: `loc_${randomUUID()}`, name };
        await atomicJson(locationsFile, [...locations, location]);
        return json(res, 201, location);
      }
      const locationMatch = url.pathname.match(/^\/api\/import\/locations\/(loc_[a-f0-9-]{36})$/i);
      if (locationMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = locationMatch[1];
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
        if (!name) throw Object.assign(new Error("A location name is required"), { status: 400 });
        const locations = await loadLocations();
        const location = locations.find((entry) => entry.id === id);
        if (!location) return json(res, 404, { error: "Location not found" });
        location.name = name;
        await atomicJson(locationsFile, locations);
        return json(res, 200, location);
      }
      if (locationMatch && req.method === "DELETE") {
        const id = locationMatch[1];
        const locations = await loadLocations();
        const next = locations.filter((entry) => entry.id !== id);
        if (next.length === locations.length) return json(res, 404, { error: "Location not found" });
        await atomicJson(locationsFile, next);
        const records = await loadImported();
        const affected = records.filter((record) => record.locationId === id);
        if (affected.length) {
          await atomicJson(importedFile, records.map((record) => record.locationId === id ? { ...record, locationId: null } : record));
        }
        return json(res, 200, { deleted: true, id, itemsUnassigned: affected.length });
      }
      if (url.pathname === "/api/import/categories" && req.method === "GET") {
        return json(res, 200, await loadCategories());
      }
      if (url.pathname === "/api/import/categories" && req.method === "POST") {
        const input = await body(req);
        const label = typeof input.label === "string" ? input.label.trim().slice(0, 60) : "";
        if (!label) throw Object.assign(new Error("A category name is required"), { status: 400 });
        const singular = typeof input.singular === "string" && input.singular.trim() ? input.singular.trim().slice(0, 60) : label;
        const isCounted = input.isCounted === true;
        const categories = await loadCategories();
        const category = { id: `cat_${randomUUID()}`, label, singular, isCounted, subcategories: [] };
        await atomicJson(categoriesFile, [...categories, category]);
        return json(res, 201, category);
      }
      const categoryMatch = url.pathname.match(/^\/api\/import\/categories\/([\w-]+)$/i);
      if (categoryMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = categoryMatch[1];
        const input = await body(req);
        const categories = await loadCategories();
        const index = categories.findIndex((entry) => entry.id === id);
        if (index === -1) return json(res, 404, { error: "Category not found" });
        const patch = {};
        if (typeof input.label === "string") {
          const label = input.label.trim().slice(0, 60);
          if (!label) throw Object.assign(new Error("A category name is required"), { status: 400 });
          patch.label = label;
        }
        if (typeof input.singular === "string") patch.singular = input.singular.trim().slice(0, 60) || patch.label || categories[index].label;
        if (typeof input.isCounted === "boolean") patch.isCounted = input.isCounted;
        categories[index] = { ...categories[index], ...patch };
        await atomicJson(categoriesFile, categories);
        return json(res, 200, categories[index]);
      }
      if (categoryMatch && req.method === "DELETE") {
        const id = categoryMatch[1];
        const categories = await loadCategories();
        if (!categories.some((entry) => entry.id === id)) return json(res, 404, { error: "Category not found" });
        if (categories.length <= 1) throw Object.assign(new Error("At least one category must remain"), { status: 400 });
        const records = await loadImported();
        const inUse = records.filter((record) => record.part === id).length;
        if (inUse > 0) throw Object.assign(new Error(`${inUse} item${inUse === 1 ? "" : "s"} still use this category — reassign them first`), { status: 400 });
        await atomicJson(categoriesFile, categories.filter((entry) => entry.id !== id));
        return json(res, 200, { deleted: true, id });
      }
      const subcategoriesMatch = url.pathname.match(/^\/api\/import\/categories\/([\w-]+)\/subcategories$/i);
      if (subcategoriesMatch && req.method === "POST") {
        const categoryId = subcategoriesMatch[1];
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
        if (!name) throw Object.assign(new Error("A subcategory name is required"), { status: 400 });
        const categories = await loadCategories();
        const index = categories.findIndex((entry) => entry.id === categoryId);
        if (index === -1) return json(res, 404, { error: "Category not found" });
        if (categories[index].subcategories.some((sub) => sub.name.toLowerCase() === name.toLowerCase())) {
          throw Object.assign(new Error("That subcategory already exists"), { status: 400 });
        }
        const subcategory = { id: `sub_${randomUUID()}`, name };
        categories[index] = { ...categories[index], subcategories: [...categories[index].subcategories, subcategory] };
        await atomicJson(categoriesFile, categories);
        return json(res, 201, subcategory);
      }
      const subcategoryMatch = url.pathname.match(/^\/api\/import\/categories\/([\w-]+)\/subcategories\/([\w-]+)$/i);
      if (subcategoryMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const [, categoryId, subId] = subcategoryMatch;
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
        if (!name) throw Object.assign(new Error("A subcategory name is required"), { status: 400 });
        const categories = await loadCategories();
        const index = categories.findIndex((entry) => entry.id === categoryId);
        if (index === -1) return json(res, 404, { error: "Category not found" });
        const subIndex = categories[index].subcategories.findIndex((sub) => sub.id === subId);
        if (subIndex === -1) return json(res, 404, { error: "Subcategory not found" });
        const nextSubcategories = [...categories[index].subcategories];
        nextSubcategories[subIndex] = { ...nextSubcategories[subIndex], name };
        categories[index] = { ...categories[index], subcategories: nextSubcategories };
        await atomicJson(categoriesFile, categories);
        return json(res, 200, nextSubcategories[subIndex]);
      }
      if (subcategoryMatch && req.method === "DELETE") {
        const [, categoryId, subId] = subcategoryMatch;
        const categories = await loadCategories();
        const index = categories.findIndex((entry) => entry.id === categoryId);
        if (index === -1) return json(res, 404, { error: "Category not found" });
        if (!categories[index].subcategories.some((sub) => sub.id === subId)) return json(res, 404, { error: "Subcategory not found" });
        categories[index] = { ...categories[index], subcategories: categories[index].subcategories.filter((sub) => sub.id !== subId) };
        await atomicJson(categoriesFile, categories);
        const records = await loadImported();
        const affected = records.filter((record) => record.subcategory === subId);
        if (affected.length) {
          await atomicJson(importedFile, records.map((record) => record.subcategory === subId ? { ...record, subcategory: null } : record));
        }
        return json(res, 200, { deleted: true, id: subId, itemsUnassigned: affected.length });
      }
      if (url.pathname === "/api/import/outfits" && req.method === "GET") {
        return json(res, 200, await loadOutfits());
      }
      if (url.pathname === "/api/import/outfits" && req.method === "POST") {
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
        if (!name) throw Object.assign(new Error("An outfit name is required"), { status: 400 });
        const wardrobe = await loadImported();
        const wardrobeIds = new Set(wardrobe.map((item) => item.id));
        const garmentIds = Array.isArray(input.garmentIds)
          ? [...new Set(input.garmentIds.filter((id) => typeof id === "string" && wardrobeIds.has(id)))]
          : [];
        if (!garmentIds.length) throw Object.assign(new Error("Pick at least one garment for the outfit"), { status: 400 });
        const now = new Date().toISOString();
        const outfit = normalizeOutfitRecord({
          id: `outfit_${randomUUID()}`,
          name,
          garmentIds,
          occasion: typeof input.occasion === "string" ? input.occasion.trim().slice(0, 80) || null : null,
          style: typeof input.style === "string" ? input.style.trim().slice(0, 120) || null : null,
          setting: typeof input.setting === "string" ? input.setting.trim().slice(0, 80) || null : null,
          notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 400) || null : null,
          createdAt: now,
          updatedAt: now,
        });
        const outfits = await loadOutfits();
        await atomicJson(outfitsFile, [...outfits, outfit]);
        return json(res, 201, outfit);
      }
      const outfitMatch = url.pathname.match(/^\/api\/import\/outfits\/(outfit_[a-f0-9-]{36})$/i);
      if (outfitMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = outfitMatch[1];
        const input = await body(req);
        const outfits = await loadOutfits();
        const index = outfits.findIndex((entry) => entry.id === id);
        if (index === -1) return json(res, 404, { error: "Outfit not found" });
        const patch = {};
        if (typeof input.name === "string") {
          const name = input.name.trim().slice(0, 120);
          if (!name) throw Object.assign(new Error("An outfit name is required"), { status: 400 });
          patch.name = name;
        }
        if (Array.isArray(input.garmentIds)) {
          const wardrobe = await loadImported();
          const wardrobeIds = new Set(wardrobe.map((item) => item.id));
          const garmentIds = [...new Set(input.garmentIds.filter((gid) => typeof gid === "string" && wardrobeIds.has(gid)))];
          if (!garmentIds.length) throw Object.assign(new Error("Pick at least one garment for the outfit"), { status: 400 });
          patch.garmentIds = garmentIds;
        }
        if (input.occasion === null) patch.occasion = null;
        else if (typeof input.occasion === "string") patch.occasion = input.occasion.trim().slice(0, 80) || null;
        if (input.style === null) patch.style = null;
        else if (typeof input.style === "string") patch.style = input.style.trim().slice(0, 120) || null;
        if (input.setting === null) patch.setting = null;
        else if (typeof input.setting === "string") patch.setting = input.setting.trim().slice(0, 80) || null;
        if (input.notes === null) patch.notes = null;
        else if (typeof input.notes === "string") patch.notes = input.notes.trim().slice(0, 400) || null;
        const updated = { ...outfits[index], ...patch, updatedAt: new Date().toISOString() };
        outfits[index] = updated;
        await atomicJson(outfitsFile, outfits);
        return json(res, 200, updated);
      }
      if (outfitMatch && req.method === "DELETE") {
        const id = outfitMatch[1];
        const outfits = await loadOutfits();
        const next = outfits.filter((entry) => entry.id !== id);
        if (next.length === outfits.length) return json(res, 404, { error: "Outfit not found" });
        await atomicJson(outfitsFile, next);
        return json(res, 200, { deleted: true, id });
      }
      if (url.pathname === "/api/import/wardrobe/wash-complete" && req.method === "POST") {
        const input = await body(req);
        const items = Array.isArray(input.items) ? input.items : [];
        if (!items.length) throw Object.assign(new Error("items must be a non-empty array"), { status: 400 });
        const records = await loadImported();
        const locations = await loadLocations();
        const updatedIds = [];
        for (const entry of items) {
          if (!entry || typeof entry.id !== "string") continue;
          const index = records.findIndex((record) => record.id === entry.id);
          if (index === -1) continue;
          const record = records[index];
          let locationId = record.locationId ?? null;
          if (entry.locationId === null) locationId = null;
          else if (typeof entry.locationId === "string" && locations.some((location) => location.id === entry.locationId)) locationId = entry.locationId;
          records[index] = { ...record, dirtyCount: 0, locationId, lastWashedAt: new Date().toISOString(), washCount: (record.washCount ?? 0) + 1 };
          updatedIds.push(entry.id);
        }
        await atomicJson(importedFile, records);
        return json(res, 200, { updated: updatedIds });
      }
      const wearMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/wear$/i);
      if (wearMatch && req.method === "POST") {
        const id = wearMatch[1];
        const input = await body(req);
        const needsWashing = input.needsWashing === true;
        const records = await loadImported();
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(res, 404, { error: "Imported wardrobe item not found" });
        const record = records[index];
        const available = Math.max(0, (record.count ?? 1) - (record.packedCount ?? 0));
        const updated = {
          ...record,
          lastWornAt: new Date().toISOString(),
          wearCount: (record.wearCount ?? 0) + 1,
          dirtyCount: needsWashing ? Math.min(available, (record.dirtyCount ?? 0) + 1) : record.dirtyCount ?? 0,
        };
        records[index] = updated;
        await atomicJson(importedFile, records);
        return json(res, 200, updated);
      }
      const packMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/pack$/i);
      if (packMatch && req.method === "POST") {
        const id = packMatch[1];
        const records = await loadImported();
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(res, 404, { error: "Imported wardrobe item not found" });
        const record = records[index];
        const available = Math.max(0, (record.count ?? 1) - (record.dirtyCount ?? 0));
        const updated = { ...record, packedCount: Math.min(available, (record.packedCount ?? 0) + 1) };
        records[index] = updated;
        await atomicJson(importedFile, records);
        return json(res, 200, updated);
      }
      const returnMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/return$/i);
      if (returnMatch && req.method === "POST") {
        const id = returnMatch[1];
        const input = await body(req);
        const needsWashing = input.needsWashing !== false;
        const records = await loadImported();
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(res, 404, { error: "Imported wardrobe item not found" });
        const record = records[index];
        // Packing it implies you wore it away from home, so coming back always
        // logs a wear — but it only goes to the washing basket if it needs one;
        // otherwise it goes straight back into rotation clean.
        const returning = record.packedCount ?? 0;
        const updated = {
          ...record,
          packedCount: 0,
          dirtyCount: needsWashing ? Math.min(record.count ?? 1, (record.dirtyCount ?? 0) + returning) : record.dirtyCount ?? 0,
          wearCount: returning > 0 ? (record.wearCount ?? 0) + 1 : (record.wearCount ?? 0),
          lastWornAt: returning > 0 ? new Date().toISOString() : record.lastWornAt,
        };
        records[index] = updated;
        await atomicJson(importedFile, records);
        return json(res, 200, updated);
      }
      const wardrobeItemMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeItemMatch && req.method === "DELETE") {
        const id = wardrobeItemMatch[1];
        const records = await loadImported();
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await atomicJson(importedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
        ]);
        const outfits = await loadOutfits();
        const affectedOutfits = outfits.filter((outfit) => outfit.garmentIds.includes(id));
        if (affectedOutfits.length) {
          const nextOutfits = outfits
            .map((outfit) => outfit.garmentIds.includes(id) ? { ...outfit, garmentIds: outfit.garmentIds.filter((gid) => gid !== id) } : outfit)
            .filter((outfit) => outfit.garmentIds.length > 0);
          await atomicJson(outfitsFile, nextOutfits);
        }
        return json(res, 200, { deleted: true, id });
      }
      if (wardrobeItemMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = wardrobeItemMatch[1];
        const input = await body(req);
        const records = await loadImported();
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(res, 404, { error: "Imported wardrobe item not found" });
        const record = records[index];
        const categories = await loadCategories();
        const categoryMap = new Map(categories.map((category) => [category.id, category]));
        const patch = {};
        if (typeof input.name === "string") patch.name = input.name.trim().slice(0, 120) || record.name;
        if (typeof input.part === "string" && categoryMap.has(input.part)) patch.part = input.part;
        const nextPart = patch.part ?? record.part;
        const allowedSubcategories = categoryMap.get(nextPart)
          ? new Set(categoryMap.get(nextPart).subcategories.map((sub) => sub.id))
          : null;
        if (input.subcategory === null || typeof input.subcategory === "string") {
          patch.subcategory = (typeof input.subcategory === "string" && allowedSubcategories?.has(input.subcategory)) ? input.subcategory : null;
        } else if (patch.part && !allowedSubcategories?.has(record.subcategory)) {
          // Category changed and the old subcategory isn't valid for the new one.
          patch.subcategory = null;
        }
        if (typeof input.color === "string" && HEX_COLOR.test(input.color)) patch.color = input.color.toLowerCase();
        if (input.secondaryColor === null) patch.secondaryColor = null;
        else if (typeof input.secondaryColor === "string" && HEX_COLOR.test(input.secondaryColor)) patch.secondaryColor = input.secondaryColor.toLowerCase();
        if (Array.isArray(input.tags)) patch.tags = input.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12);
        if (typeof input.brand === "string") patch.brand = input.brand.trim().slice(0, 80) || null;
        else if (input.brand === null) patch.brand = null;
        if (typeof input.model === "string") patch.model = input.model.trim().slice(0, 80) || null;
        else if (input.model === null) patch.model = null;
        if (input.locationId === null) patch.locationId = null;
        else if (typeof input.locationId === "string") {
          const locations = await loadLocations();
          if (!locations.some((entry) => entry.id === input.locationId)) throw Object.assign(new Error("Unknown location"), { status: 400 });
          patch.locationId = input.locationId;
        }
        if (input.count !== undefined && Number.isFinite(Number(input.count))) {
          const nextCount = Math.max(1, Math.min(999, Math.round(Number(input.count))));
          patch.count = nextCount;
          patch.dirtyCount = Math.min(record.dirtyCount ?? 0, nextCount);
          patch.packedCount = Math.min(record.packedCount ?? 0, nextCount);
        }
        const nextColor = patch.color ?? record.color;
        const nextSecondary = patch.secondaryColor !== undefined ? patch.secondaryColor : record.secondaryColor;
        const updated = { ...record, ...patch, palette: [nextColor, nextSecondary].filter(Boolean) };
        records[index] = updated;
        await atomicJson(importedFile, records);
        return json(res, 200, updated);
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        const stats = await stat(file);
        // The same filename is reused whenever a garment image is replaced
        // (manual edit or re-import), so it can't be treated as immutable —
        // validate against mtime instead of caching it forever.
        const lastModified = new Date(Math.floor(stats.mtimeMs / 1000) * 1000).toUTCString();
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Last-Modified", lastModified);
        if (req.headers["if-modified-since"] === lastModified) {
          res.statusCode = 304;
          return res.end();
        }
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasAnthropicKey && "ANTHROPIC_API_KEY in .env",
            !setup.hasOpenAIKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const analysisImage = await prepareVisionImage(image.data);
        const key = setting("ANTHROPIC_API_KEY");
        const categories = await loadCategories();
        const categoryIds = new Set(categories.map((category) => category.id));
        const fallbackPart = categories[0]?.id;
        const detected = (await claudeAnalyzeGarments({ key, model: setting("ANTHROPIC_VISION_MODEL", "claude-opus-5"), image: analysisImage, mime: "image/jpeg", categories }))
          .map((item) => normalizeMetadata(item, categoryIds, fallbackPart));
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
        }
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        const ids = await readdir(jobsDir).catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        const categories = await loadCategories();
        const categoryIds = new Set(categories.map((category) => category.id));
        const fallbackPart = categories[0]?.id;
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }, categoryIds, fallbackPart); await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey([job.metadata?.color, job.metadata?.secondaryColor]);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        const canSkipUngenerated = decision === "reject" && stageName === "modeled" && job.stages[stageName].status === "pending";
        if (!DECISIONS.has(decision) || (job.stages[stageName].status !== "review" && !canSkipUngenerated)) throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job);
        if (decision === "approve" && stageName !== "crop") {
          try {
            await persistImported(job, stageName === "modeled");
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        if (decision === "reject") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        if (startGarment) void generate(job, "garment");
        const response = publicJob(job);
        if (job.status === "complete") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      locationsFile = path.join(dataDir, "locations.json");
      categoriesFile = path.join(dataDir, "categories.json");
      outfitsFile = path.join(dataDir, "outfits.json");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      await migrateLegacySubcategories();
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        if (job.status === "complete") {
          try {
            await persistImported(job, true);
            await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          } catch (error) {
            job.status = "active";
            job.stages.modeled.status = "review";
            job.stages.modeled.decision = null;
            job.stages.modeled.error = null;
            await saveJob(job);
          }
          continue;
        }
        if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected") {
          await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          continue;
        }
        if (job.stages.crop && job.stages.crop.status !== "approved") continue;
        if (["processing", "queued"].includes(job.stages.garment.status)) {
          job.stages.garment.status = "pending";
          await saveJob(job);
          void generate(job, "garment");
        } else if (job.stages.garment.status === "approved" && ["processing", "queued"].includes(job.stages.modeled.status)) {
          job.stages.modeled.status = "pending";
          await saveJob(job);
          void generate(job, "modeled");
        }
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
