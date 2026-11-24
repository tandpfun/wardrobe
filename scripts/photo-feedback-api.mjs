import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getModeledImages, MODES } from "../src/wardrobe-model.js";
import { body, json } from "./http-json.mjs";
import { atomicJson, readJson as readJsonFile, withLibraryLock } from "./library-store.mjs";
import { archiveExistingPhotos, captureCurrentPhoto, createPhotoHistoryStore, imageDigest, resolvePhotoFile, UNDO_MS } from "./photo-history.mjs";

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const garmentContext = (garments) => ({ garmentIds: garments.map((piece) => piece.id), garmentModes: garments.map((piece) => ({ garmentId: piece.id, role: piece.role, mode: piece.mode })) });
const BODY_LIMIT = 16000;

export function createPhotoFeedbackApi({ root, dataDir, env = {}, now = Date.now, buildItemPrompt, editImage }) {
  const store = createPhotoHistoryStore(dataDir, now);
  const setting = (name, fallback = "") => env[name] || process.env[name] || fallback;
  const readJson = (file, fallback) => readJsonFile(path.join(dataDir, file), fallback);
  // Hold the wardrobe lock before the history lock, matching the importers.
  const withWardrobeLock = (operation) => withLibraryLock(path.join(dataDir, "library.json"), operation);
  // A replaced item photo in imported/ is a duplicate once the history holds its bytes.
  async function removeReplacedCopy(library, itemId, image) {
    if (!image?.startsWith(`/api/import/library/${itemId}-`)) return;
    if (library.some((piece) => [piece.image, piece.thumbnail, ...getModeledImages(piece).map((entry) => entry.image)].includes(image))) return;
    const file = resolvePhotoFile(dataDir, image);
    const bytes = await readFile(file).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
    if (!bytes || !existsSync(path.join(store.assets, `${imageDigest(bytes)}.png`))) return;
    await rm(file, { force: true });
  }
  // Point the wardrobe record at the active version, so library.json and
  // outfits.json readers see the same photo as the history. Callers hold both locks.
  async function activate(entry, version) {
    entry.activeVersionId = version.id;
    entry.sourceSignature = `${version.image}:${version.sha256}`;
    if (entry.kind === "item") {
      const library = await readJson("library.json", []);
      const item = library.find((piece) => piece.id === entry.targetId);
      if (!item) return;
      const replaced = getModeledImages(item).find((image) => image.mode === entry.mode)?.image;
      item.modeledImages = getModeledImages(item).map((image) => image.mode === entry.mode ? { ...image, image: version.image } : image);
      item.modeledImage = item.modeledImages[0].image;
      await atomicJson(path.join(dataDir, "library.json"), library);
      await removeReplacedCopy(library, entry.targetId, replaced);
    } else {
      const collection = await readJson("outfits.json", { outfits: [] });
      const outfit = (collection.outfits || []).find((look) => look.id === entry.targetId);
      if (!outfit) return;
      outfit.image = version.image;
      await atomicJson(path.join(dataDir, "outfits.json"), collection);
    }
  }
  async function context(kind, targetId, mode = "default", requireGarments = false) {
    if (!MODES.has(mode) || (kind === "outfit" && mode !== "default")) throw error("Invalid photo mode");
    const library = await readJson("library.json", []);
    if (kind === "item") {
      const item = library.find((piece) => piece.id === targetId);
      if (!item) throw error("Wardrobe item not found", 404);
      return { kind, targetId, mode, name: item.name, item, sources: getModeledImages(item), garments: [{ ...item, role: "featured", mode }], signature: JSON.stringify({ image: item.image, part: item.part, canLayer: item.canLayer }) };
    }
    const collection = await readJson("outfits.json", { outfits: [] });
    const outfit = (collection.outfits || []).find((look) => look.id === targetId);
    if (!outfit) throw error("Outfit not found", 404);
    const ids = outfit.garmentIds || [];
    const pieces = ids.map((id) => library.find((piece) => piece.id === id));
    if (requireGarments && (!ids.length || pieces.some((piece) => !piece))) throw error("This outfit contains a missing wardrobe piece", 409);
    let hasTop = false;
    const garments = pieces.filter(Boolean).map((piece) => {
      const assigned = outfit.garmentModes?.find((assignment) => assignment.garmentId === piece.id);
      let role = assigned?.role;
      if (!role) {
        role = piece.part === "lowerbody" ? "bottom" : piece.part === "shoes" ? "shoes"
          : piece.part === "accessories_up" ? "accessory" : piece.part === "wholebody_up" || hasTop ? "outer" : "top";
      }
      if (role === "top") hasTop = true;
      return { ...piece, role, mode: assigned?.mode || (role === "outer" ? "layer" : "default") };
    });
    return { kind, targetId, mode, name: outfit.name, outfit, garments, sources: [{ mode: "default", image: outfit.image }], signature: JSON.stringify({ image: outfit.image, garments: garments.map((piece) => [piece.id, piece.image, piece.role, piece.mode]) }) };
  }
  async function ensure(kind, targetId) {
    const current = await context(kind, targetId);
    for (const image of current.sources) {
      await captureCurrentPhoto({ dataDir, kind, targetId, mode: image.mode, image: image.image, now, context: { name: current.name, ...garmentContext(current.garments) } });
    }
    return current;
  }
  async function photos(current) {
    const { kind, targetId } = current;
    const history = await store.read();
    const modes = new Set(current.sources.map((image) => image.mode));
    return { photos: history.targets.filter((entry) => entry.kind === kind && entry.targetId === targetId && modes.has(entry.mode)).map(store.publicPhoto).filter(Boolean) };
  }
  async function generationPackage(current, direction) {
    const key = setting("OPENAI_API_KEY");
    if (!key) throw error("Add an OpenAI API key before regenerating photos", 503);
    const primary = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
    const references = [];
    const add = async (file, role, name) => {
      const bytes = await readFile(file);
      references.push({ data: bytes, name, role, sha256: imageDigest(bytes) });
    };
    await add(primary, "face identity", "face-reference.png");
    for (const index of [2, 3]) {
      try { await add(path.join(path.dirname(primary), `model-reference-${index}.png`), "body proportions", `body-reference-${index}.png`); }
      catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    }
    const identityCount = references.length;
    for (const garment of current.garments) await add(resolvePhotoFile(dataDir, garment.image), `${garment.role} ${garment.name}; mode ${garment.mode}; garment ${garment.id}`, `${garment.id}.png`);
    const modelDirection = setting("WARDROBE_MODEL_DIRECTION");
    // The outfit prompt mirrors .agents/skills/generate-outfits/references/outfit-image-prompt.md; update both together.
    const basePrompt = current.kind === "item"
      ? buildItemPrompt(current.item, current.mode, identityCount, modelDirection)
      : `Create a professional square outfit photograph of the exact person wearing the complete selected wardrobe outfit: ${current.name}.
Reference roles: ${references.map((reference, index) => `Image ${index + 1}: ${reference.role}`).join(". ")}.
Preserve recognizable face, hair, skin texture and age from the face reference, and build and body proportions from the supplied body references. ${modelDirection ? `User modeling preference: ${modelDirection}.` : ""}
Wear only these exact selected garments in their recorded roles and modes. Preserve every garment's real color, texture, fit, proportions, construction, closure, graphics, logos and text. Never invent openings or fasteners. An outer layer with a real button/zip opening may be open naturally; a pullover remains closed with its inner piece visible at a real neckline, cuff or hem. Keep every selected piece identifiable. Use understated shoes only when no shoe reference was selected.
Apply thoughtful menswear styling with an experienced menswear stylist's judgment about fit, proportion, color, texture and occasion: ${(current.outfit.occasion || []).join(", ") || "everyday"}. Keep the exact selected inner top or hoodie appropriate to the outer garment's bulk.
Square 1:1 composition, complete head-to-shoes framing with uncropped feet, relaxed mostly front-facing pose and arms away from clothing. Setting: ${current.outfit.setting || "a quiet natural real-world setting"}. Warm natural light, realistic shadows, authentic skin and fabric, restrained editorial grading. Avoid redesigned garments, missing pieces, hidden inner layers, fake logos, extra people, text overlays, watermarks or unrealistic anatomy.`;
    const prompt = [basePrompt, direction ? `User regeneration direction: ${direction}` : null].filter(Boolean).join("\n\n");
    const model = setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2"));
    return {
      prompt,
      context: { kind: current.kind, targetId: current.targetId, mode: current.mode, name: current.name, ...garmentContext(current.garments), references: references.map(({ data, ...reference }) => reference), model, modelDirection },
      request: { key, baseUrl: setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""), model, prompt, images: references, size: current.kind === "outfit" ? "1024x1024" : "1536x1024", quality: setting("OPENAI_IMAGE_QUALITY", "high"), signal: AbortSignal.timeout(600000) },
    };
  }
  async function regenerate(current, input) {
    const { kind, targetId } = current;
    const mode = input.mode || "default";
    if (typeof input.direction !== "undefined" && (typeof input.direction !== "string" || input.direction.length > 2000)) throw error("Direction must be at most 2000 characters");
    const direction = (input.direction || "").trim();
    const selected = await context(kind, targetId, mode, true);
    if (mode === "layer" && selected.item?.canLayer !== true) throw error("Save layer suitability before regenerating a layered look", 409);
    const jobId = randomUUID();
    await store.transaction((history) => {
      const entry = store.target(history, kind, targetId, mode, false);
      if (!entry?.activeVersionId || !current.sources.some((photo) => photo.mode === mode)) throw error("No accepted photo exists for this wearing mode", 409);
      if (entry.job?.status === "generating") throw error("This photo is already regenerating", 409);
      if (input.expectedVersionId !== entry.activeVersionId) throw error("The photo changed. Refresh before regenerating", 409);
      entry.job = { id: jobId, status: "generating", startedAt: store.time(), baseVersionId: entry.activeVersionId, direction, pid: process.pid, hostname: hostname(), error: null };
      store.event(entry, "regenerate", { versionId: entry.activeVersionId, fromVersionId: entry.activeVersionId, direction, jobId });
    });
    void runGeneration(selected, jobId, direction, input.expectedVersionId).catch((failure) => console.error("Photo history could not be saved:", failure.message));
  }
  async function runGeneration(current, jobId, direction, baseVersionId) {
    try {
      const pack = await generationPackage(current, direction);
      const bytes = await editImage(pack.request);
      let valid = false;
      try { const dimensions = await sharp(bytes).metadata(); valid = Math.abs(dimensions.width / dimensions.height - (current.kind === "outfit" ? 1 : 1.5)) < 0.02; }
      catch { /* Invalid provider output is still archived for diagnosis. */ }
      await withWardrobeLock(async () => {
        let unchanged = false;
        try { unchanged = (await context(current.kind, current.targetId, current.mode, true)).signature === current.signature; }
        catch (failure) { if (![404, 409].includes(failure.status)) throw failure; }
        await store.transaction(async (history) => {
          const entry = store.target(history, current.kind, current.targetId, current.mode);
          const stillCurrent = entry.activeVersionId === baseVersionId;
          const version = await store.archive(entry, bytes, { source: "regeneration", status: !valid ? "invalid" : unchanged && stillCurrent ? "accepted" : "rejected", prompt: pack.prompt, context: pack.context });
          store.event(entry, "generation-complete", { jobId, fromVersionId: baseVersionId, toVersionId: version.id, versionId: version.id });
          if (entry.job?.id !== jobId) return;
          if (!valid || !unchanged || !stillCurrent) {
            entry.job = { ...entry.job, status: "failed", error: valid ? "The wardrobe changed during generation. The returned image was saved in history." : "The returned image has the wrong shape. Your previous photo is unchanged." };
            return;
          }
          const previousVersionId = entry.activeVersionId;
          await activate(entry, version);
          entry.undo = { previousVersionId, newVersionId: version.id, expiresAt: new Date(now() + UNDO_MS).toISOString() };
          entry.job = { ...entry.job, status: "complete", completedAt: store.time(), error: null };
        });
      });
    } catch (failure) {
      await store.transaction((history) => {
        const entry = store.target(history, current.kind, current.targetId, current.mode);
        if (entry.job?.id === jobId) entry.job = { ...entry.job, status: "failed", error: failure.code === "ENOENT" ? "A required model or garment reference is missing" : failure.message };
      });
    }
  }
  async function feedback(kind, targetId, input) {
    input.comment ??= "";
    if (!["up", "down", null].includes(input.rating) || typeof input.comment !== "string" || input.comment.length > 2000) throw error("Choose a rating or clear feedback, with a comment of at most 2000 characters");
    await store.transaction((history) => {
      const entry = history.targets.find((entry) => entry.kind === kind && entry.targetId === targetId && entry.versions.some((version) => version.id === input.versionId));
      const version = entry?.versions.find((version) => version.id === input.versionId);
      if (!version) throw error("Photo version not found for this piece", 404);
      const comment = input.rating === null ? "" : input.comment.trim();
      version.feedback = input.rating === null ? null : { rating: input.rating, comment, updatedAt: store.time() };
      store.event(entry, "feedback", { versionId: version.id, rating: input.rating, comment });
    });
  }
  async function undo(kind, targetId, input) {
    await withWardrobeLock(() => store.transaction(async (history) => {
      const entry = store.target(history, kind, targetId, input.mode || "default", false);
      if (!entry?.undo || entry.undo.expiresAt <= store.time() || entry.activeVersionId !== input.expectedVersionId || entry.activeVersionId !== entry.undo.newVersionId || entry.job?.status === "generating") throw error("Undo is no longer available", 409);
      const fromVersionId = entry.activeVersionId;
      await activate(entry, entry.versions.find((version) => version.id === entry.undo.previousVersionId));
      entry.undo = null;
      store.event(entry, "undo", { versionId: fromVersionId, fromVersionId, toVersionId: entry.activeVersionId });
    }));
  }
  async function listOutfits() {
    const collection = await readJson("outfits.json", { outfits: [] });
    return (collection.outfits || []).filter((outfit) => outfit.image).map((outfit) => ({
      ...outfit, image: outfit.image.startsWith("outfit-images/") ? `/api/import/outfits/${path.basename(outfit.image)}` : outfit.image,
    }));
  }
  async function initialize() {
    await archiveExistingPhotos({ dataDir, now });
    await store.transaction((history) => {
      for (const entry of history.targets) {
        const job = entry.job;
        if (job?.status !== "generating" || job.hostname !== hostname()) continue;
        try { process.kill(job.pid, 0); }
        catch (failure) { if (failure.code === "ESRCH") entry.job = { ...job, status: "failed", error: "Generation was interrupted. Your previous photo is unchanged." }; }
      }
    });
  }
  async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/api\/import\/photos\/(item|outfit)\/([\w-]+)(?:\/(regenerate|feedback|undo))?$/);
    const asset = url.pathname.match(/^\/api\/import\/photo-history\/([a-f0-9]{64}\.png)$/);
    const oldAsset = url.pathname.match(/^\/api\/import\/outfits\/([\w-]+\.png)$/);
    if (!match && !asset && !oldAsset && url.pathname !== "/api/import/outfits") return next();
    try {
      if ((asset || oldAsset) && req.method === "GET") {
        const file = asset ? path.join(store.assets, asset[1]) : path.join(dataDir, "outfit-images", oldAsset[1]);
        const bytes = await readFile(file);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-store" }); return res.end(bytes);
      }
      if (url.pathname === "/api/import/outfits" && req.method === "GET") return json(res, 200, await listOutfits());
      if (match) {
        const [, kind, targetId, action] = match;
        if (!action && req.method === "GET") return json(res, 200, await photos(await ensure(kind, targetId)));
        if (action && req.method === "POST") {
          const input = await body(req, BODY_LIMIT);
          // Capture once; the action itself keeps the history current for the response.
          const current = await ensure(kind, targetId);
          if (action === "regenerate") await regenerate(current, input);
          else if (action === "feedback") await feedback(kind, targetId, input);
          else await undo(kind, targetId, input);
          return json(res, action === "regenerate" ? 202 : 200, await photos(current));
        }
      }
      return json(res, 405, { error: "Method not allowed" });
    } catch (failure) { return json(res, failure.code === "ENOENT" ? 404 : failure.status || 500, { error: failure.status || failure.code === "ENOENT" ? failure.message : "Could not update the photo. Try again." }); }
  }
  return { handle, initialize, captureItem: (id) => ensure("item", id) };
}
