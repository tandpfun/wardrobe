import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getExpectedModeledModes, getModeledImages, normalizeLayering, normalizeWardrobeItem } from "../src/wardrobe-model.js";
import { body, json } from "./http-json.mjs";
import { atomicJson, withLibraryLock } from "./library-store.mjs";
import { createPhotoFeedbackApi } from "./photo-feedback-api.mjs";
import { archiveGeneratedPhoto, imageDigest, resolvePhotoFile } from "./photo-history.mjs";
import { resolveWardrobeDataDir } from "./wardrobe-paths.mjs";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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

export function normalizeMetadata(value = {}, existing = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  const part = PARTS.has(metadata.part) ? metadata.part : "upperbody";
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part,
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
    ...normalizeLayering({ ...metadata, part }, existing),
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

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
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

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, images: [], failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

export function buildAnalysisPrompt() {
  return "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody (Tops), wholebody_up (Jackets), lowerbody (Bottoms), accessories_up (Accessories), shoes (Shoes). Keep each item's usual category. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags. Independently infer canLayer for every item: true when its visible construction, fabric and fit make it suitable as an outer garment over a compatible inner garment. Casual flannel or textured shirts, zip-up jackets, cardigans and layer-friendly hoodies can qualify. Consider room for the inner garment and whether the result would be well-proportioned menswear. A formal dress shirt normally serves as an inner or standalone top and defaults to false; ordinary tees, bottoms, accessories and shoes generally default to false. Category alone must not decide suitability. Uncertain construction or suitability means false. Preserve source-supported openings and fasteners; do not invent them or infer suitability from color alone.";
}

export function buildModeledPrompt(metadata = {}, mode = "default", referenceCount = 1, direction = "") {
  const garmentIndex = referenceCount + 1;
  const identity = referenceCount > 1
    ? `Image 1 is for face and hair identity only. Images 2 through ${referenceCount} are body-proportion references. Preserve the person's recognizable face, hair, age, build, skin texture and body proportions from those respective references.`
    : "Image 1 is the identity reference. Preserve the person's recognizable face, hair, age, build, skin texture and body proportions.";
  const wearing = mode === "layer"
    ? "Use the featured garment as an OUTER LAYER over a visibly present, compatible inner garment. Apply thoughtful menswear styling with the judgment of an experienced menswear stylist: balance fit, proportion, color, texture, fabric weight and occasion. Choose an inner T-shirt, lightweight hoodie, fine knit or another appropriate base to suit this particular piece; allow enough room and avoid bulky, strained combinations. Wear real buttoned or zipped openings open when appropriate; for pullovers, show the inner garment naturally at the neckline or hem. Preserve the source-supported construction and fasteners. Keep the featured garment's sleeves, hem and distinctive details readable."
    : "Show the featured garment in its STANDARD LOOK, worn naturally in a usual way appropriate to its construction and category. Fasten its real buttons, snaps or zipper where appropriate. Use well-balanced supporting clothes needed to complete a wearable outfit without covering or competing with the featured item.";
  return `Create a professional horizontal 3:2 editorial fashion photograph of this person wearing the exact ${metadata.name || "garment"} from Image ${garmentIndex}. ${identity}

Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure and distinctive details. Do not redesign, simplify, replace or reinterpret it. ${wearing}

Use a natural pose with arms and accessories away from the garment. Keep the complete featured item visible; for bottoms and shoes frame the full person from head to shoes with uncropped feet. Place the person in a tasteful real-world setting with warm natural light, realistic shadows, authentic skin and fabric texture and restrained editorial color grading. Leave environmental breathing room for flexible cropping. ${direction ? `User modeling preference: ${direction}` : ""}

Avoid hidden details, invented openings or closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, unrealistic anatomy or synthetic AI polish.`;
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality, signal }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  if (background) form.set("background", background);
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

async function openAIAnalyze({ key, baseUrl, model, image, mime }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: buildAnalysisPrompt() },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, canLayer: { type: "boolean" }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "canLayer", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

export function wardrobeImportApi(options = {}) {
  let root;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  let photoApi;
  let dataDirectory;
  const running = new Map();
  const jobWrites = new Map();
  let libraryWrites = Promise.resolve();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  function withJobLock(id, operation) {
    const previous = jobWrites.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    jobWrites.set(id, task);
    void task.finally(() => { if (jobWrites.get(id) === task) jobWrites.delete(id); }).catch(() => {});
    return task;
  }

  // Serialize this process's writes before taking the cross-process library lock.
  function queueLibraryWrite(operation) {
    const task = libraryWrites.catch(() => {}).then(() => withLibraryLock(importedFile, operation));
    libraryWrites = task;
    return task;
  }

  async function effectiveMetadata(job) {
    const existing = (await loadImported()).find((record) => record.id === `import-${job.id}`);
    verifyExistingGarment(job, existing);
    return importMetadata(job, existing);
  }

  function verifyExistingGarment(job, existing) {
    if (!job.internal?.requiresExistingRecord) return;
    if (!existing) throw Object.assign(new Error("Imported wardrobe item not found"), { status: 404 });
    if (existing.image !== job.internal.libraryGarmentImage) throw Object.assign(new Error("The garment changed. Start its modeled photos again from the current wardrobe item."), { status: 409 });
  }

  function importMetadata(job, existing) {
    // Once a cutout is imported, its current library metadata is authoritative.
    // Later modeled approval must not undo an edit made in the gallery.
    const metadata = existing ? { ...job.metadata, ...existing } : job.metadata;
    return normalizeMetadata(metadata, existing);
  }

  function matchesGeneratedLayering(metadata, generation) {
    const current = normalizeLayering(metadata);
    return Boolean(generation) && current.canLayer === generation.canLayer;
  }

  function modeledStageImages(job) {
    const stage = job.stages.modeled;
    return getModeledImages({ modeledImages: stage.images, modeledImage: stage.assetUrl });
  }

  function verifyModeledBatch(job, metadata) {
    const images = modeledStageImages(job);
    const expected = getExpectedModeledModes(metadata);
    if (job.stages.garment.status !== "approved" || (job.stages.modeled.generationGarmentUrl && job.stages.modeled.generationGarmentUrl !== job.stages.garment.assetUrl)) {
      throw Object.assign(new Error("The featured garment changed. Approve it and regenerate the modeled photos before approving."), { status: 409 });
    }
    if (!matchesGeneratedLayering(metadata, job.stages.modeled.generationLayering)) {
      // Old one-photo jobs remain reviewable unless a newly chosen wearing mode requires a new batch.
      if (job.stages.modeled.generationLayering || metadata.canLayer) {
        throw Object.assign(new Error("Layering settings changed. Regenerate the modeled photos before approving."), { status: 409 });
      }
    }
    if (images.length !== expected.length || images.some((image, index) => image.mode !== expected[index])) {
      throw Object.assign(new Error("Review a complete set of modeled photos for the current layering settings before approving."), { status: 409 });
    }
    return images;
  }

  async function setupStatus() {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim());
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    const referencePath = path.resolve(root, referenceSetting);
    let hasModelReference = false;
    try {
      hasModelReference = (await stat(referencePath)).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      ready: hasApiKey && hasModelReference,
      hasApiKey,
      hasModelReference,
      modelReference: referenceSetting,
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try {
      const job = JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8"));
      job.metadata = normalizeMetadata(job.metadata);
      return job;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  async function loadImported() {
    try { return JSON.parse(await readFile(importedFile, "utf8")).map(normalizeWardrobeItem); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function persistImported(job, includeModeled = false) {
    return queueLibraryWrite(async () => {
      const id = `import-${job.id}`;
      const records = await loadImported();
      const existing = records.find((record) => record.id === id);
      verifyExistingGarment(job, existing);
      const metadata = importMetadata(job, existing);
      const sourceImages = includeModeled ? verifyModeledBatch(job, metadata) : [];
      await mkdir(libraryAssetDir, { recursive: true });
      const garmentSource = job.stages.garment.assetUrl
        ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
        : `garment-${job.stages.garment.attempts}.png`;
      const garmentBytes = await readFile(path.join(jobsDir, job.id, garmentSource));
      const digest = (bytes) => imageDigest(bytes).slice(0, 20);
      const garmentName = `${id}-garment-${digest(garmentBytes)}.png`;
      await writeFile(path.join(libraryAssetDir, garmentName), garmentBytes);
      const modeledImages = includeModeled ? [] : getModeledImages(existing);
      for (const image of sourceImages) {
        // A kept photo uses the item's current image, which a regeneration may have replaced since the job started.
        const kept = job.internal.retainedModeledImages?.some((entry) => entry.id === image.id)
          && getModeledImages(existing).find((entry) => entry.mode === image.mode);
        if (kept) {
          modeledImages.push({ ...image, image: kept.image });
          continue;
        }
        const source = path.basename(new URL(image.image, "http://localhost").pathname);
        const bytes = await readFile(path.join(jobsDir, job.id, source));
        const name = `${id}-modeled-${image.mode}-${digest(bytes)}.png`;
        await writeFile(path.join(libraryAssetDir, name), bytes);
        modeledImages.push({ ...image, image: `${LIBRARY_ASSET_ROOT}/${name}` });
      }
      const record = {
        ...existing,
        id,
        name: metadata.name,
        part: metadata.part,
        color: metadata.color,
        secondaryColor: metadata.secondaryColor,
        palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
        tags: metadata.tags,
        ...normalizeLayering(metadata),
        image: job.internal.requiresExistingRecord ? existing.image : `${LIBRARY_ASSET_ROOT}/${garmentName}`,
        thumbnail: job.internal.requiresExistingRecord ? existing.thumbnail : `${LIBRARY_ASSET_ROOT}/${garmentName}`,
        modeledImages,
        modeledImage: modeledImages[0]?.image || null,
        importJobId: job.id,
      };
      await atomicJson(importedFile, [...records.filter((item) => item.id !== id), record]);
      return record;
    });
  }

  function metadataPatch(input) {
    const supplied = input.metadata ?? input;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
    const allowed = ["name", "part", "color", "secondaryColor", "tags", "canLayer", "layeringSource"];
    const patch = Object.fromEntries(allowed.filter((key) => Object.hasOwn(supplied, key)).map((key) => [key, supplied[key]]));
    if (!Object.keys(patch).length) throw Object.assign(new Error("No editable metadata fields were supplied"), { status: 400 });
    if (Object.hasOwn(patch, "canLayer") && typeof patch.canLayer !== "boolean") throw Object.assign(new Error("canLayer must be a boolean"), { status: 400 });
    if (Object.hasOwn(patch, "layeringSource") && !["ai", "manual"].includes(patch.layeringSource)) throw Object.assign(new Error("layeringSource must be ai or manual"), { status: 400 });
    if (Object.hasOwn(patch, "part") && !PARTS.has(patch.part)) throw Object.assign(new Error("Invalid wardrobe category"), { status: 400 });
    if (Object.hasOwn(patch, "name") && (typeof patch.name !== "string" || !patch.name.trim())) throw Object.assign(new Error("name must be a nonempty string"), { status: 400 });
    if (Object.hasOwn(patch, "color") && !HEX_COLOR.test(patch.color)) throw Object.assign(new Error("color must be a six-digit hex color"), { status: 400 });
    if (Object.hasOwn(patch, "secondaryColor") && patch.secondaryColor !== null && !HEX_COLOR.test(patch.secondaryColor)) throw Object.assign(new Error("secondaryColor must be a six-digit hex color or null"), { status: 400 });
    if (Object.hasOwn(patch, "tags") && (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== "string"))) throw Object.assign(new Error("tags must be an array of strings"), { status: 400 });
    return patch;
  }

  function applyMetadataPatch(existing, changes) {
    const current = normalizeLayering(existing);
    const changed = Object.hasOwn(changes, "canLayer") && changes.canLayer !== current.canLayer;
    const layeringSource = changes.layeringSource === "ai"
      ? "ai"
      : changed ? "manual" : current.layeringSource;
    return normalizeMetadata({ ...existing, ...changes, layeringSource }, existing);
  }

  async function patchImported(id, changes, required = true) {
    return queueLibraryWrite(async () => {
      const records = await loadImported();
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) {
        if (!required) return null;
        throw Object.assign(new Error("Imported wardrobe item not found"), { status: 404 });
      }
      const existing = records[index];
      const metadata = applyMetadataPatch(existing, changes);
      const { boundingBox, ...fields } = metadata;
      const record = { ...existing, ...fields, palette: [fields.color, fields.secondaryColor].filter(Boolean) };
      records[index] = record;
      await atomicJson(importedFile, records);
      return record;
    });
  }

  async function startExistingModeled(id) {
    return queueLibraryWrite(async () => {
      const record = (await loadImported()).find((item) => item.id === id);
      if (!record) throw Object.assign(new Error("Imported wardrobe item not found"), { status: 404 });
      const jobId = id.slice("import-".length);
      const pending = await loadJob(jobId);
      if (pending && pending.status !== "complete") {
        pending.metadata = importMetadata(pending, record);
        return { job: pending, reused: true };
      }
      const metadata = normalizeMetadata(record);
      const expected = getExpectedModeledModes(metadata);
      const accepted = getModeledImages(record);
      if (expected.every((mode) => accepted.some((image) => image.mode === mode))) {
        throw Object.assign(new Error("This item already has its modeled looks."), { status: 409 });
      }
      const setup = await setupStatus();
      if (!setup.ready) throw Object.assign(new Error("Add an OpenAI API key and model reference before creating modeled photos."), { status: 503 });
      const libraryFile = (image) => {
        try { return resolvePhotoFile(dataDirectory, image); }
        catch { throw Object.assign(new Error("The item's local image could not be resolved."), { status: 400 }); }
      };
      const garmentBytes = await readFile(libraryFile(record.image));
      const retained = [];
      const retainedFiles = [];
      for (const mode of expected) {
        const image = accepted.find((entry) => entry.mode === mode);
        if (!image) continue;
        const name = `modeled-retained-${mode}-${randomUUID()}.png`;
        retainedFiles.push({ name, bytes: await readFile(libraryFile(image.image)) });
        retained.push({ id: image.id, mode, image: `${ASSET_ROOT}/${jobId}/${name}` });
      }
      const directory = path.join(jobsDir, jobId);
      if (pending) await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const garmentName = `garment-existing-${randomUUID()}.png`;
      await writeFile(path.join(directory, garmentName), garmentBytes);
      await writeFile(path.join(directory, "original.png"), garmentBytes);
      for (const file of retainedFiles) await writeFile(path.join(directory, file.name), file.bytes);
      const now = new Date().toISOString();
      const garmentUrl = `${ASSET_ROOT}/${jobId}/${garmentName}`;
      const approvedStage = { ...stageState(), status: "approved", decision: "approved", assetUrl: garmentUrl, updatedAt: now };
      const job = {
        id: jobId, status: "active", metadata,
        stages: { crop: { ...approvedStage }, garment: { ...approvedStage }, modeled: { ...stageState(), status: "queued" } },
        createdAt: now, updatedAt: now,
        originalAssetUrl: `${ASSET_ROOT}/${jobId}/original.png`,
        internal: { originalFile: "original.png", cropFile: "original.png", originalMime: "image/png", requiresExistingRecord: true, libraryGarmentImage: record.image, retainedModeledImages: retained },
      };
      await saveJob(job);
      return { job, reused: false };
    });
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const current = await withJobLock(job.id, async () => {
          const fresh = await loadJob(job.id);
          if (!fresh) return null;
          fresh.metadata = await effectiveMetadata(fresh);
          const stage = fresh.stages[stageName];
          stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
          if (stageName === "modeled") { stage.images = []; stage.assetUrl = null; }
          await saveJob(fresh);
          return fresh;
        });
        if (!current) return;
        const stage = current.stages[stageName];
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        let generatedImages = stageName === "modeled" ? structuredClone(current.internal.retainedModeledImages || []) : [];
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1024x1024", images: [original], prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt });
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
          const references = [{ data: modelData, mime: "image/png", name: "face-reference.png" }];
          for (const index of [2, 3]) {
            const bodyPath = path.join(path.dirname(modelPath), `model-reference-${index}.png`);
            if (bodyPath === modelPath) continue;
            try { references.push({ data: await readFile(bodyPath), mime: "image/png", name: `body-reference-${index}.png` }); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          const modes = getExpectedModeledModes(current.metadata);
          const batchId = randomUUID();
          const model = setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2"));
          for (const mode of modes) {
            if (generatedImages.some((image) => image.mode === mode)) continue;
            const basePrompt = buildModeledPrompt(current.metadata, mode, references.length, options.modeledDirection || setting("WARDROBE_MODEL_DIRECTION"));
            const prompt = [basePrompt, options.modeledPrompt, current.stages.modeled.prompt ? `User regeneration direction: ${current.stages.modeled.prompt}` : null].filter(Boolean).join("\n");
            const imageBytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model, quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1536x1024", images: [...references, garment], prompt });
            let normalized;
            try { normalized = await normalizeImage(imageBytes); }
            catch (failure) {
              await archiveGeneratedPhoto({ dataDir: dataDirectory, kind: "item", targetId: `import-${current.id}`, mode, bytes: imageBytes, activate: false, source: "import", status: "invalid", prompt, context: { name: current.metadata.name, mode } });
              throw failure;
            }
            const dimensions = await sharp(normalized).metadata();
            const validAspect = Math.abs((dimensions.width / dimensions.height) - 1.5) <= 0.02;
            await archiveGeneratedPhoto({ dataDir: dataDirectory, kind: "item", targetId: `import-${current.id}`, mode, bytes: normalized, activate: false, source: "import", status: validAspect ? "accepted" : "invalid", prompt, context: { name: current.metadata.name, garmentIds: [`import-${current.id}`], mode, model, modelDirection: setting("WARDROBE_MODEL_DIRECTION") } });
            if (!validAspect) throw new Error("Modeled photo must be horizontal 3:2. Regenerate the complete set.");
            const name = `modeled-${stage.attempts}-${mode}-${batchId}.png`;
            await writeFile(path.join(dir, name), normalized);
            generatedImages.push({ id: `${mode}-${batchId}`, mode, image: `${ASSET_ROOT}/${current.id}/${name}` });
          }
          generatedImages = modes.map((mode) => generatedImages.find((image) => image.mode === mode));
        }
        if (stageName === "garment") await writeFile(output, bytes);
        await withJobLock(current.id, async () => {
          const fresh = await loadJob(current.id);
          if (!fresh) return;
          const metadata = await effectiveMetadata(fresh);
          if (stageName === "modeled" && !matchesGeneratedLayering(metadata, normalizeLayering(current.metadata))) {
            throw new Error("Layering settings changed while generating. Regenerate the modeled photos for the new settings.");
          }
          fresh.metadata = metadata;
          fresh.stages[stageName].status = "review";
          fresh.stages[stageName].assetUrl = stageName === "modeled" ? generatedImages[0].image : `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
          if (stageName === "modeled") {
            fresh.stages.modeled.images = generatedImages;
            fresh.stages.modeled.generationLayering = normalizeLayering(current.metadata);
            fresh.stages.modeled.generationGarmentUrl = current.stages.garment.assetUrl;
          }
          fresh.stages[stageName].failedAssetUrl = null;
          fresh.stages[stageName].cleanupPreviewUrl = null;
          fresh.stages[stageName].cleanupDiagnostics = null;
          if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
          fresh.stages[stageName].updatedAt = new Date().toISOString();
          await saveJob(fresh);
        });
      } catch (error) {
        await withJobLock(job.id, async () => {
          const fresh = await loadJob(job.id);
          if (!fresh) return;
          fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
          if (stageName === "modeled") { fresh.stages.modeled.images = []; fresh.stages.modeled.assetUrl = null; }
          if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
          if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
          await saveJob(fresh);
        });
      }
    })().catch((error) => console.error("Import job could not be saved:", error.message)).finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, await loadImported());
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      const wardrobeItemMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeItemMatch && req.method === "PATCH") {
        const changes = metadataPatch(await body(req));
        return json(res, 200, await patchImported(wardrobeItemMatch[1], changes));
      }
      const existingModeledMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled$/i);
      if (existingModeledMatch && req.method === "POST") {
        const result = await startExistingModeled(existingModeledMatch[1]);
        if (!result.reused) void generate(result.job, "modeled");
        return json(res, result.reused ? 200 : 202, { job: publicJob(result.job) });
      }
      if (wardrobeItemMatch && req.method === "DELETE") {
        const id = wardrobeItemMatch[1];
        await queueLibraryWrite(async () => {
          const records = await loadImported();
          const record = records.find((item) => item.id === id);
          if (!record) throw Object.assign(new Error("Imported wardrobe item not found"), { status: 404 });
          await photoApi.captureItem(id);
          // The handler holds this item's job lock before entering the library
          // transaction, so a pending approval cannot recreate the deleted item.
          const pendingJobId = record.importJobId || id.slice("import-".length);
          if (/^[a-f0-9-]{36}$/i.test(pendingJobId)) await rm(path.join(jobsDir, pendingJobId), { recursive: true, force: true });
          await atomicJson(importedFile, records.filter((item) => item.id !== id));
          const urls = [record.image, record.thumbnail, ...getModeledImages(record).map((image) => image.image)];
          const names = new Set(urls.filter((url) => typeof url === "string" && url.startsWith(`${LIBRARY_ASSET_ROOT}/${id}-`)).map((url) => path.basename(new URL(url, "http://localhost").pathname)));
          await Promise.all([...names].map((name) => rm(path.join(libraryAssetDir, name), { force: true })));
        });
        return json(res, 200, { deleted: true, id });
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        const bytes = url.searchParams.get("thumbnail") === "1"
          ? await sharp(file)
            .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
            .resize(384, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer()
          : await readFile(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(bytes);
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
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const key = setting("OPENAI_API_KEY");
        const detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" })).map((item) => normalizeMetadata({ ...item, layeringSource: "ai" }));
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
        const hiddenJobs = loadedJobs.filter((job) => !jobWrites.has(job.id) && (job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected"));
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") { job.metadata = await effectiveMetadata(job); return json(res, 200, publicJob(job)); }
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const changes = metadataPatch(await body(req));
        job.metadata = applyMetadataPatch(await effectiveMetadata(job), changes);
        await patchImported(`import-${job.id}`, job.metadata, false);
        await saveJob(job);
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
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
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
          if (["processing", "queued"].includes(job.stages[stageName].status)) throw Object.assign(new Error("This stage is already generating. Wait for it to finish before regenerating."), { status: 409 });
          if (stageName === "modeled" && job.stages.garment.status !== "approved") throw Object.assign(new Error("Approve the garment before generating modeled photos."), { status: 409 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        if (stageName === "modeled" && decision === "approve") {
          const metadata = await effectiveMetadata(job);
          const images = verifyModeledBatch(job, metadata);
          const input = await body(req);
          if (images.length > 1 && (!Array.isArray(input.reviewedImageIds) || images.some((image) => !input.reviewedImageIds.includes(image.id)))) {
            throw Object.assign(new Error("View both modeled photos before approving this item."), { status: 409 });
          }
          job.metadata = metadata;
        }
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
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
        if (startModeled) void generate(job, "modeled");
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

  async function routeWithJobLock(req, res, next) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const jobMatch = pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/|$)/i);
    if (jobMatch) return withJobLock(jobMatch[1], () => handle(req, res, next));
    const modeled = pathname.match(/^\/api\/import\/wardrobe\/import-([a-f0-9-]{36})\/modeled$/i);
    if (modeled && req.method === "POST") return withJobLock(modeled[1], () => handle(req, res, next));
    const deletion = pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
    if (deletion && req.method === "DELETE") {
      const record = (await loadImported()).find((item) => item.id === deletion[1]);
      const id = record?.importJobId || deletion[1].slice("import-".length);
      return withJobLock(id, () => handle(req, res, next));
    }
    return handle(req, res, next);
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const dataDir = resolveWardrobeDataDir(root, options.env?.WARDROBE_DATA_DIR);
      dataDirectory = dataDir;
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      await queueLibraryWrite(async () => {
        try {
          const records = JSON.parse(await readFile(importedFile, "utf8"));
          const normalized = records.map(normalizeWardrobeItem);
          if (JSON.stringify(records) !== JSON.stringify(normalized)) await atomicJson(importedFile, normalized);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      });
      photoApi = createPhotoFeedbackApi({ root, dataDir, env: options.env, now: options.now, buildItemPrompt: buildModeledPrompt, editImage: openAIEdit });
      await photoApi.initialize();
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        await saveJob(job);
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
        } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
          job.stages.modeled.status = "pending";
          await saveJob(job);
          void generate(job, "modeled");
        }
      }
    },
    configureServer(server) { server.middlewares.use((req, res, next) => photoApi.handle(req, res, () => routeWithJobLock(req, res, next))); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => photoApi.handle(req, res, () => routeWithJobLock(req, res, next))); },
  };
}
