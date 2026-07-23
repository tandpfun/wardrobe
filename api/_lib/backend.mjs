// Storage-backed backend router for the Vercel production deployment.
//
// This mirrors the routes of the local Vite middleware (scripts/import-job-api.mjs)
// but is transport- and backend-agnostic: it takes a normalized request
// (method, path segments, parsed JSON body, query) plus a `store` and `env`,
// and returns a plain result `{ status, json?, image?, headers? }`. The Vercel
// function wrapper (api/import/[...path].mjs) adapts Node req/res to this shape.
//
// It reuses the shared pipeline (scripts/wardrobe-core.mjs) for all OpenAI and
// image processing, and the pure outfit helpers (scripts/outfits-store.mjs) for
// outfit normalization. The key behavioral difference from the local dev server
// is that image generation runs synchronously within the request (serverless
// functions cannot reliably do fire-and-forget background work), so the
// frontend's polling simply observes the finished "review"/"ready" state.

import { randomUUID } from "node:crypto";
import {
  DECISIONS,
  DEFAULT_MODELED_PROMPT,
  STAGES,
  UPLOAD_MIME_TYPES,
  buildGarmentPrompt,
  buildOutfitPrompt,
  chooseChromaKey,
  cleanupTolerance,
  cropDetectedItem,
  decodeImage,
  normalizeImage,
  normalizeMetadata,
  openAIAnalyze,
  openAIEdit,
  processChromaBackground,
  removeChromaBackground,
  stageState,
} from "../../scripts/wardrobe-core.mjs";
import { composeOutfitPreview, normalizeOutfit, normalizeOutfitsFile, OUTFIT_STATUSES } from "../../scripts/outfits-store.mjs";
import {
  JOBS_PREFIX,
  JOB_ASSET_ROOT,
  LIBRARY_ASSET_ROOT,
  LIBRARY_MANIFEST_KEY,
  OUTFITS_MANIFEST_KEY,
  OUTFIT_IMAGE_ROOT,
  REFERENCE_KEY,
  basenameFromUrl,
  garmentFilename,
  jobAssetKey,
  jobKey,
  libraryAssetKey,
  libraryAssetUrl,
  modeledFilename,
  outfitImageKey,
} from "./keys.mjs";

// Cost guardrails.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB decoded image ceiling (Vercel body limit is ~4.5MB).
export const MAX_OUTFIT_GARMENTS = 5; // OpenAI edit accepts model + up to 5 garments.
export const MAX_LIBRARY_ITEMS = 500; // Upper bound on wardrobe size to bound storage/cost.

function ok(json, status = 200, headers) {
  return { status, json, headers };
}
function fail(status, message) {
  return { status, json: { error: message } };
}
function image(data, contentType, cacheControl) {
  return { status: 200, image: { data, contentType }, headers: cacheControl ? { "Cache-Control": cacheControl } : undefined };
}

const setting = (env, name, fallback = "") => (env[name] != null && env[name] !== "" ? env[name] : fallback);
const apiKey = (env) => String(setting(env, "OPENAI_API_KEY", "")).trim();
const apiBaseUrl = (env) => setting(env, "OPENAI_API_BASE_URL", "https://api.openai.com/v1");

// ---- config -------------------------------------------------------------

async function setupStatus(store, env) {
  const hasApiKey = Boolean(apiKey(env));
  const hasModelReference = await store.exists(REFERENCE_KEY);
  // Report only booleans + a coarse backend label. Never expose storage
  // pathnames, Blob URLs, tokens, or the store id to the client.
  return {
    ready: hasApiKey && hasModelReference,
    hasApiKey,
    hasModelReference,
    modelReference: null,
    backend: store.backend,
  };
}

// ---- library (wardrobe) -------------------------------------------------

async function loadLibrary(store) {
  const records = await store.readJson(LIBRARY_MANIFEST_KEY, []);
  return Array.isArray(records) ? records : [];
}
async function saveLibrary(store, records) {
  await store.writeJson(LIBRARY_MANIFEST_KEY, records);
}

function libraryRecord(importId, metadata, { modeledImage = null } = {}) {
  return {
    id: importId,
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || null,
    palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    image: libraryAssetUrl(garmentFilename(importId)),
    thumbnail: libraryAssetUrl(garmentFilename(importId)),
    modeledImage,
    importJobId: importId.replace(/^import-/, ""),
  };
}

async function updateLibraryRecord(store, id, patch) {
  const records = await loadLibrary(store);
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) return null;
  const current = records[index];
  const metadata = normalizeMetadata({
    name: patch.name ?? current.name,
    part: patch.part ?? current.part,
    color: patch.color ?? current.color,
    secondaryColor: Object.prototype.hasOwnProperty.call(patch, "secondaryColor") ? patch.secondaryColor : current.secondaryColor,
    tags: patch.tags ?? current.tags,
  });
  const updated = {
    ...current,
    name: metadata.name,
    part: metadata.part,
    color: metadata.color,
    secondaryColor: metadata.secondaryColor,
    tags: metadata.tags,
    palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
  };
  records[index] = updated;
  await saveLibrary(store, records);
  return updated;
}

// ---- outfits ------------------------------------------------------------

async function readOutfits(store) {
  const parsed = await store.readJson(OUTFITS_MANIFEST_KEY, { version: 2, outfits: [] });
  return normalizeOutfitsFile(parsed);
}
async function writeOutfits(store, data) {
  await store.writeJson(OUTFITS_MANIFEST_KEY, { version: 2, outfits: data.outfits });
}

async function toPublicOutfit(store, outfit) {
  const hasImage = await store.exists(outfitImageKey(outfit.id));
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

async function resolveOutfitGarments(store, garmentIds) {
  const records = await loadLibrary(store);
  const buffers = [];
  for (const id of garmentIds) {
    const record = records.find((item) => item.id === id);
    if (!record) continue;
    const file = basenameFromUrl(record.image || record.thumbnail);
    if (!file) continue;
    const asset = await store.getImage(libraryAssetKey(file));
    if (asset) buffers.push({ record, data: asset.data });
  }
  return buffers;
}

async function runOutfitGeneration(store, env, outfit) {
  const garments = (await resolveOutfitGarments(store, outfit.garmentIds)).slice(0, MAX_OUTFIT_GARMENTS);
  if (!garments.length) {
    return { status: "failed", imageMode: outfit.imageMode, error: "None of this outfit's garments have stored images. Add garments before generating." };
  }
  const setup = await setupStatus(store, env);
  let bytes;
  let imageMode;
  if (setup.ready) {
    imageMode = "openai";
    const reference = await store.getImage(REFERENCE_KEY);
    if (!reference) return { status: "failed", imageMode, error: "The private reference photo is not configured." };
    const images = [
      { data: reference.data, mime: "image/png", name: "model.png" },
      ...garments.map((garment, index) => ({ data: garment.data, mime: "image/png", name: `garment-${index + 1}.png` })),
    ];
    bytes = await openAIEdit({
      key: apiKey(env),
      baseUrl: apiBaseUrl(env),
      model: setting(env, "OPENAI_MODELED_MODEL", setting(env, "OPENAI_IMAGE_MODEL", "gpt-image-2")),
      quality: setting(env, "OPENAI_IMAGE_QUALITY", "high"),
      size: "1024x1024",
      images,
      prompt: buildOutfitPrompt(outfit, garments),
    });
  } else {
    imageMode = "demo";
    bytes = await composeOutfitPreview(garments.map((garment) => garment.data));
  }
  await store.putImage(outfitImageKey(outfit.id), bytes, "image/png");
  return { status: "ready", imageMode, error: null };
}

// ---- jobs (interactive import pipeline) ---------------------------------

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

async function loadJob(store, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  return store.readJson(jobKey(id), null);
}
async function saveJob(store, job) {
  job.updatedAt = new Date().toISOString();
  await store.writeJson(jobKey(job.id), job);
}
async function deleteJobDir(store, id) {
  const keys = await store.list(`${JOBS_PREFIX}/${id}`);
  await Promise.all(keys.map((key) => store.del(key)));
  await store.del(`${JOBS_PREFIX}/${id}`).catch(() => {});
}

async function persistImported(store, job, includeModeled) {
  const importId = `import-${job.id}`;
  const garmentSource = basenameFromUrl(job.stages.garment.assetUrl) || `garment-${job.stages.garment.attempts}.png`;
  const garmentAsset = await store.getImage(jobAssetKey(job.id, garmentSource));
  if (!garmentAsset) throw new Error("Garment asset is missing for this job");
  await store.putImage(libraryAssetKey(garmentFilename(importId)), garmentAsset.data, "image/png");
  let modeledImage = null;
  if (includeModeled) {
    const modeledSource = basenameFromUrl(job.stages.modeled.assetUrl) || `modeled-${job.stages.modeled.attempts}.png`;
    const modeledAsset = await store.getImage(jobAssetKey(job.id, modeledSource));
    if (modeledAsset) {
      await store.putImage(libraryAssetKey(modeledFilename(importId)), modeledAsset.data, "image/png");
      modeledImage = libraryAssetUrl(modeledFilename(importId));
    }
  }
  const records = await loadLibrary(store);
  const existing = records.find((record) => record.id === importId);
  const record = libraryRecord(importId, job.metadata || {}, { modeledImage: modeledImage || existing?.modeledImage || null });
  const next = [...records.filter((item) => item.id !== importId), record];
  await saveLibrary(store, next);
  return record;
}

// Runs one generation stage synchronously and persists the resulting job.
async function generateStage(store, env, job, stageName) {
  const current = await loadJob(store, job.id);
  const stage = current.stages[stageName];
  stage.status = "processing";
  stage.decision = null;
  stage.error = null;
  stage.attempts += 1;
  stage.updatedAt = new Date().toISOString();
  await saveJob(store, current);

  let failedAssetUrl = null;
  let chromaKeyUsed = null;
  try {
    const key = apiKey(env);
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    const outputName = `${stageName}-${stage.attempts}.png`;
    if (stageName === "garment") {
      const sourceName = current.internal.cropFile || current.internal.originalFile;
      const source = await store.getImage(jobAssetKey(current.id, sourceName));
      if (!source) throw new Error("Source crop is missing for this job");
      chromaKeyUsed = chooseChromaKey(current.metadata.color);
      const basePrompt = buildGarmentPrompt(current.metadata, chromaKeyUsed);
      let bytes = await openAIEdit({
        key,
        baseUrl: apiBaseUrl(env),
        model: setting(env, "OPENAI_GARMENT_MODEL", setting(env, "OPENAI_IMAGE_MODEL", "gpt-image-2")),
        quality: setting(env, "OPENAI_IMAGE_QUALITY", "high"),
        size: "1024x1024",
        images: [{ data: source.data, mime: "image/png", name: "source.png" }],
        prompt: stage.prompt ? `${basePrompt}\nUser regeneration direction: ${stage.prompt}` : basePrompt,
      });
      const rawName = `${stageName}-${stage.attempts}-source.png`;
      await store.putImage(jobAssetKey(current.id, rawName), bytes, "image/png");
      failedAssetUrl = `${JOB_ASSET_ROOT}/${current.id}/${rawName}`;
      bytes = await removeChromaBackground(bytes, chromaKeyUsed);
      await store.putImage(jobAssetKey(current.id, outputName), bytes, "image/png");
    } else {
      const garmentName = basenameFromUrl(current.stages.garment.assetUrl) || `garment-${current.stages.garment.attempts}.png`;
      const garment = await store.getImage(jobAssetKey(current.id, garmentName));
      if (!garment) throw new Error("Approved garment asset is missing");
      const reference = await store.getImage(REFERENCE_KEY);
      if (!reference) throw new Error("The private reference photo is not configured.");
      const basePrompt = DEFAULT_MODELED_PROMPT;
      const bytes = await openAIEdit({
        key,
        baseUrl: apiBaseUrl(env),
        model: setting(env, "OPENAI_MODELED_MODEL", setting(env, "OPENAI_IMAGE_MODEL", "gpt-image-2")),
        quality: setting(env, "OPENAI_IMAGE_QUALITY", "high"),
        size: "1536x1024",
        images: [{ data: reference.data, mime: "image/png", name: "model.png" }, { data: garment.data, mime: "image/png", name: "garment.png" }],
        prompt: stage.prompt ? `${basePrompt}\nUser regeneration direction: ${stage.prompt}` : basePrompt,
      });
      await store.putImage(jobAssetKey(current.id, outputName), bytes, "image/png");
    }
    const fresh = await loadJob(store, current.id);
    fresh.stages[stageName].status = "review";
    fresh.stages[stageName].assetUrl = `${JOB_ASSET_ROOT}/${fresh.id}/${outputName}`;
    fresh.stages[stageName].failedAssetUrl = null;
    fresh.stages[stageName].cleanupPreviewUrl = null;
    fresh.stages[stageName].cleanupDiagnostics = null;
    if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
    fresh.stages[stageName].updatedAt = new Date().toISOString();
    await saveJob(store, fresh);
    return fresh;
  } catch (error) {
    const fresh = await loadJob(store, current.id);
    fresh.stages[stageName].status = "failed";
    fresh.stages[stageName].error = error.message;
    fresh.stages[stageName].updatedAt = new Date().toISOString();
    if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
    if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
    await saveJob(store, fresh);
    return fresh;
  }
}

// ---- main router --------------------------------------------------------

// segments: path parts after "/api/import" (e.g. ["wardrobe","import-x"]).
export async function handleImportApi({ store, env, method, segments, body = {}, query = {} }) {
  const [head, ...rest] = segments;

  if (head === "config" && method === "GET") {
    return ok(await setupStatus(store, env));
  }

  // ---- wardrobe ----
  if (head === "wardrobe") {
    const id = rest[0] ? decodeURIComponent(rest[0]) : null;
    if (!id && method === "GET") return ok(await loadLibrary(store));
    if (id && /^import-[a-z0-9][a-z0-9-]*$/i.test(id)) {
      if (method === "PATCH" || method === "PUT") {
        const patch = body.metadata && typeof body.metadata === "object" ? body.metadata : body;
        const updated = await updateLibraryRecord(store, id, patch);
        return updated ? ok(updated) : fail(404, "Imported wardrobe item not found");
      }
      if (method === "DELETE") {
        const records = await loadLibrary(store);
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return fail(404, "Imported wardrobe item not found");
        await saveLibrary(store, next);
        await Promise.all([
          store.del(libraryAssetKey(garmentFilename(id))),
          store.del(libraryAssetKey(modeledFilename(id))),
        ]);
        return ok({ deleted: true, id });
      }
    }
    return fail(404, "Not found");
  }

  // ---- library asset serving ----
  if (head === "library" && method === "GET" && rest.length === 1) {
    const asset = await store.getImage(libraryAssetKey(rest[0]));
    if (!asset) return fail(404, "Asset not found");
    return image(asset.data, asset.contentType, "public, max-age=31536000, immutable");
  }

  // ---- job asset serving ----
  if (head === "assets" && method === "GET" && rest.length === 2) {
    if (!/^[a-f0-9-]{36}$/i.test(rest[0])) return fail(404, "Asset not found");
    const asset = await store.getImage(jobAssetKey(rest[0], rest[1]));
    if (!asset) return fail(404, "Asset not found");
    return image(asset.data, asset.contentType, "no-store");
  }

  // ---- outfits ----
  if (head === "outfits") {
    // Outfit image: /outfits/<id>.png
    if (rest.length === 1 && /\.png$/i.test(rest[0]) && method === "GET") {
      const outfitId = rest[0].replace(/\.png$/i, "");
      const asset = await store.getImage(outfitImageKey(outfitId));
      if (!asset) return fail(404, "Outfit image not found");
      return image(asset.data, asset.contentType, "no-store");
    }
    const id = rest[0] ? decodeURIComponent(rest[0]) : null;
    const action = rest[1] || null;
    if (!id) {
      if (method === "GET") {
        const { outfits } = await readOutfits(store);
        const sorted = [...outfits].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return ok(await Promise.all(sorted.map((outfit) => toPublicOutfit(store, outfit))));
      }
      if (method === "POST") {
        if (!Array.isArray(body.garmentIds) || body.garmentIds.length === 0) return fail(400, "Select at least one garment for the outfit.");
        const data = await readOutfits(store);
        const ids = new Set(data.outfits.map((outfit) => outfit.id));
        const now = new Date().toISOString();
        const outfit = normalizeOutfit({ ...body, source: body.source || "builder", status: "draft", createdAt: now, updatedAt: now }, ids);
        data.outfits.push(outfit);
        await writeOutfits(store, data);
        return ok(await toPublicOutfit(store, outfit), 201);
      }
      return fail(404, "Not found");
    }
    const data = await readOutfits(store);
    const index = data.outfits.findIndex((outfit) => outfit.id === id);
    if (index === -1) return fail(404, "Outfit not found");
    const outfit = data.outfits[index];
    if (!action && method === "GET") return ok(await toPublicOutfit(store, outfit));
    if (!action && (method === "PATCH" || method === "PUT")) {
      const editable = ["name", "occasion", "styleDirection", "garmentIds", "reason", "setting"];
      const merged = { ...outfit };
      for (const field of editable) {
        if (Object.prototype.hasOwnProperty.call(body, field)) merged[field] = body[field];
      }
      const ids = new Set(data.outfits.filter((_, position) => position !== index).map((item) => item.id));
      const normalized = normalizeOutfit({ ...merged, id }, ids);
      normalized.id = id;
      normalized.createdAt = outfit.createdAt;
      normalized.updatedAt = new Date().toISOString();
      data.outfits[index] = normalized;
      await writeOutfits(store, data);
      return ok(await toPublicOutfit(store, normalized));
    }
    if (!action && method === "DELETE") {
      data.outfits.splice(index, 1);
      await writeOutfits(store, data);
      await store.del(outfitImageKey(id));
      return ok({ deleted: true, id });
    }
    if (action === "generate" && method === "POST") {
      if (!outfit.garmentIds.length) return fail(400, "Add garments to this outfit before generating an image.");
      // Explicit user action (POST) triggers generation; runs synchronously.
      const result = await runOutfitGeneration(store, env, outfit);
      const normalized = normalizeOutfit({ ...outfit, ...result }, new Set(data.outfits.filter((o) => o.id !== id).map((o) => o.id)));
      normalized.id = id;
      normalized.createdAt = outfit.createdAt;
      normalized.updatedAt = new Date().toISOString();
      data.outfits[index] = normalized;
      await writeOutfits(store, data);
      return ok(await toPublicOutfit(store, normalized), result.status === "failed" ? 200 : 200);
    }
    return fail(404, "Not found");
  }

  // ---- jobs ----
  if (head === "jobs") {
    if (rest.length === 0 && method === "POST") {
      const setup = await setupStatus(store, env);
      if (!setup.ready) {
        const missing = [
          !setup.hasApiKey && "OPENAI_API_KEY",
          !setup.hasModelReference && "a private reference photo",
        ].filter(Boolean).join(" and ");
        return fail(503, `Setup required: configure ${missing}.`);
      }
      const library = await loadLibrary(store);
      if (library.length >= MAX_LIBRARY_ITEMS) return fail(429, `Wardrobe item limit (${MAX_LIBRARY_ITEMS}) reached.`);
      let decoded;
      try {
        decoded = decodeImage(body);
      } catch (error) {
        return fail(error.status || 400, error.message);
      }
      if (decoded.data.length > MAX_UPLOAD_BYTES) return fail(413, `Image exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB upload limit. Resize before importing.`);
      if (!UPLOAD_MIME_TYPES.has(decoded.mime)) return fail(415, "Only JPEG, PNG, and WebP uploads are supported.");
      const normalizedImage = await normalizeImage(decoded.data);
      const detected = (await openAIAnalyze({ key: apiKey(env), baseUrl: apiBaseUrl(env), model: setting(env, "OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
      const jobs = [];
      for (const metadata of detected) {
        const jobId = randomUUID();
        const originalFile = "original.png";
        const cropFile = "crop.png";
        const cropped = await cropDetectedItem(normalizedImage, metadata.boundingBox);
        await store.putImage(jobAssetKey(jobId, originalFile), normalizedImage, "image/png");
        await store.putImage(jobAssetKey(jobId, cropFile), cropped, "image/png");
        const now = new Date().toISOString();
        const job = {
          id: jobId,
          status: "active",
          metadata,
          stages: { crop: { ...stageState(), status: "review", assetUrl: `${JOB_ASSET_ROOT}/${jobId}/${cropFile}`, updatedAt: now }, garment: stageState(), modeled: stageState() },
          createdAt: now,
          updatedAt: now,
          originalAssetUrl: `${JOB_ASSET_ROOT}/${jobId}/${originalFile}`,
          internal: { originalFile, cropFile, originalMime: "image/png" },
        };
        await saveJob(store, job);
        jobs.push(publicJob(job));
      }
      return ok({ jobs, noClothingDetected: jobs.length === 0 }, 202);
    }
    if (rest.length === 0 && method === "GET") {
      const keys = await store.list(JOBS_PREFIX);
      const ids = [...new Set(keys.map((key) => key.split("/")[1]).filter(Boolean))];
      const loaded = (await Promise.all(ids.map((id) => loadJob(store, id)))).filter(Boolean);
      const hidden = loaded.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
      await Promise.all(hidden.map((job) => deleteJobDir(store, job.id)));
      const visible = loaded.filter((job) => !hidden.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return ok(visible.map(publicJob));
    }
    const jobId = rest[0];
    if (!jobId || !/^[a-f0-9-]{36}$/i.test(jobId)) return fail(404, "Not found");
    const job = await loadJob(store, jobId);
    if (!job) return fail(404, "Job not found");
    const action = rest.slice(1).join("/");

    if (!action && method === "GET") return ok(publicJob(job));
    if (!action && method === "DELETE") {
      await deleteJobDir(store, jobId);
      return ok({ deleted: true, id: jobId });
    }
    if (action === "metadata" && (method === "PATCH" || method === "PUT")) {
      if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) return fail(400, "metadata must be an object");
      job.metadata = normalizeMetadata({ ...job.metadata, ...body.metadata });
      await saveJob(store, job);
      return ok(publicJob(job));
    }

    const cleanupMatch = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
    if (cleanupMatch && method === "POST") {
      const stage = job.stages.garment;
      if (stage.status !== "failed" || !stage.failedAssetUrl) return fail(409, "No failed garment source is available for cleanup");
      const tolerance = cleanupTolerance(body.tolerance);
      const sourceName = basenameFromUrl(stage.failedAssetUrl);
      const source = await store.getImage(jobAssetKey(jobId, sourceName));
      if (!source) return fail(409, "The garment source to clean up is missing");
      const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
      const cleaned = await processChromaBackground(source.data, key, { tolerance });
      const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
      await store.putImage(jobAssetKey(jobId, previewName), cleaned.bytes, "image/png");
      stage.chromaKey = key;
      stage.cleanupTolerance = cleaned.tolerance;
      stage.cleanupDiagnostics = cleaned.verification;
      stage.cleanupPreviewUrl = `${JOB_ASSET_ROOT}/${jobId}/${previewName}`;
      stage.updatedAt = new Date().toISOString();
      if (cleanupMatch[1] === "cleanup-accept") {
        stage.status = "review";
        stage.decision = null;
        stage.error = null;
        stage.assetUrl = stage.cleanupPreviewUrl;
      }
      await saveJob(store, job);
      return ok(publicJob(job));
    }

    const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
    if (stageMatch && method === "POST") {
      const [, stageName, decision] = stageMatch;
      if (!STAGES.has(stageName)) return fail(400, "Invalid stage");
      if (decision === "regenerate") {
        if (stageName === "crop") return fail(400, "Upload the image again to create new crops");
        job.stages[stageName].prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1200) || null : null;
        job.stages[stageName].status = "queued";
        job.stages[stageName].decision = null;
        await saveJob(store, job);
        const result = await generateStage(store, env, job, stageName);
        return ok(publicJob(result), 200);
      }
      if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") return fail(409, "Stage is not ready for review");
      job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
      job.stages[stageName].status = job.stages[stageName].decision;
      job.stages[stageName].error = null;
      job.stages[stageName].updatedAt = new Date().toISOString();
      const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
      const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
      if (stageName === "modeled" && decision === "approve") job.status = "complete";

      if (decision === "approve" && stageName !== "crop") {
        await persistImported(store, job, stageName === "modeled");
      }
      await saveJob(store, job);

      if (decision === "reject") {
        await deleteJobDir(store, jobId);
        return ok(publicJob(job));
      }
      // Kick off the next generation stage synchronously so the caller's next
      // poll observes a finished "review" state.
      if (startGarment) {
        const result = await generateStage(store, env, job, "garment");
        return ok(publicJob(result));
      }
      if (startModeled) {
        const result = await generateStage(store, env, job, "modeled");
        return ok(publicJob(result));
      }
      const response = publicJob(job);
      if (job.status === "complete") await deleteJobDir(store, jobId);
      return ok(response);
    }

    return fail(404, "Not found");
  }

  return fail(404, "Not found");
}

// ---- bulk import (used by the authenticated CLI) ------------------------
//
// Accepts one processed garment at a time (a ready-to-store cutout PNG plus its
// metadata) or designates the private reference photo, and writes directly to
// durable storage. Never runs OpenAI and never logs image bytes or secrets.
export async function handleBulkImport({ store, env, body = {} }) {
  const kind = body.kind;
  if (kind === "reference") {
    let decoded;
    try {
      decoded = decodeImage(body);
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    // Reference photo is normalized to PNG for consistent downstream use.
    const png = await normalizeImage(decoded.data);
    await store.putImage(REFERENCE_KEY, png, "image/png");
    return ok({ ok: true, kind: "reference", bytes: png.length });
  }

  if (kind === "garment") {
    const metadata = normalizeMetadata(body.metadata || {});
    let decoded;
    try {
      decoded = decodeImage(body);
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if (decoded.data.length > MAX_UPLOAD_BYTES) return fail(413, `Image exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit.`);
    if (!UPLOAD_MIME_TYPES.has(decoded.mime)) return fail(415, "Only JPEG, PNG, and WebP images are supported.");
    const library = await loadLibrary(store);
    if (library.length >= MAX_LIBRARY_ITEMS) return fail(429, `Wardrobe item limit (${MAX_LIBRARY_ITEMS}) reached.`);
    // Deterministic id, either caller-provided (idempotent re-imports) or random.
    const rawId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : randomUUID();
    const importId = rawId.startsWith("import-") ? rawId : `import-${rawId}`;
    const png = await normalizeImage(decoded.data);
    await store.putImage(libraryAssetKey(garmentFilename(importId)), png, "image/png");
    const record = libraryRecord(importId, metadata, { modeledImage: null });
    const next = [...library.filter((item) => item.id !== importId), record];
    await saveLibrary(store, next);
    return ok({ ok: true, kind: "garment", record });
  }

  return fail(400, "Unknown bulk import kind. Expected 'garment' or 'reference'.");
}

export const OUTFIT_STATUS_SET = OUTFIT_STATUSES;
