import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson, readJson, withLibraryLock } from "./library-store.mjs";
import { getModeledImages, MODES } from "../src/wardrobe-model.js";

export const PHOTO_ASSET_ROOT = "/api/import/photo-history";
export const UNDO_MS = 60000;
export const EMPTY_PHOTO_HISTORY = { version: 1, targets: [] };
export const photoKey = (kind, targetId, mode) => `${kind}:${targetId}:${mode}`;
export const imageDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertPhotoTarget({ kind, targetId, mode }) {
  if (!["item", "outfit"].includes(kind) || typeof targetId !== "string" || !targetId || !MODES.has(mode)) throw new Error("Invalid photo target");
}

export function resolvePhotoFile(dataDir, image) {
  if (typeof image !== "string") throw new Error("A local photo is required");
  const normalized = image.replaceAll("\\", "/");
  const routes = [["/api/import/library/", "imported"], ["/api/import/outfits/", "outfit-images"], ["outfit-images/", "outfit-images"], [`${PHOTO_ASSET_ROOT}/`, "photo-history/assets"]];
  for (const [prefix, directory] of routes) {
    if (!normalized.startsWith(prefix)) continue;
    const name = normalized.slice(prefix.length).split("?")[0];
    if (!/^[\w-]+\.png$/i.test(name)) throw new Error("Invalid local photo path");
    return path.join(dataDir, directory, name);
  }
  throw new Error("Unsupported local photo path");
}

export function createPhotoHistoryStore(dataDir, now = Date.now) {
  const directory = path.join(dataDir, "photo-history");
  const file = path.join(directory, "index.json");
  const assets = path.join(directory, "assets");
  const time = () => new Date(now()).toISOString();
  const read = () => readJson(file, EMPTY_PHOTO_HISTORY);
  async function transaction(operation) {
    return withLibraryLock(file, async () => {
      const history = await read();
      const result = await operation(history);
      await atomicJson(file, history);
      return result;
    });
  }
  function target(history, kind, targetId, mode, create = true) {
    let entry = history.targets.find((entry) => photoKey(entry.kind, entry.targetId, entry.mode) === photoKey(kind, targetId, mode));
    if (!entry && create) {
      entry = { kind, targetId, mode, activeVersionId: null, versions: [], events: [], job: null, undo: null, sourceSignature: null };
      history.targets.push(entry);
    }
    return entry;
  }
  async function archive(entry, bytes, metadata = {}) {
    await mkdir(assets, { recursive: true });
    const sha256 = imageDigest(bytes);
    await writeFile(path.join(assets, `${sha256}.png`), bytes, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const fields = Object.fromEntries(["status", "source", "prompt", "context"].filter((key) => Object.hasOwn(metadata, key)).map((key) => [key, metadata[key]]));
    const version = {
      id: randomUUID(), image: `${PHOTO_ASSET_ROOT}/${sha256}.png`, sha256,
      createdAt: time(), status: "accepted", source: "legacy", prompt: null,
      context: {}, feedback: null, ...fields,
    };
    entry.versions.push(version);
    return version;
  }
  function event(entry, type, fields) {
    const value = { id: randomUUID(), type, at: time(), ...fields };
    entry.events.push(value);
    return value;
  }
  function publicPhoto(entry) {
    const active = entry.versions.find((version) => version.id === entry.activeVersionId);
    if (!active) return null;
    return {
      kind: entry.kind, targetId: entry.targetId, mode: entry.mode,
      versionId: active.id, image: active.image, feedback: active.feedback,
      generating: entry.job?.status === "generating", error: entry.job?.error || null,
      undo: entry.undo && entry.undo.expiresAt > time() && entry.undo.newVersionId === active.id
        ? { expiresAt: entry.undo.expiresAt, previousVersionId: entry.undo.previousVersionId } : null,
      versions: entry.versions.map((version) => ({ ...version })),
    };
  }
  return { directory, file, assets, now, time, read, transaction, target, archive, event, publicPhoto };
}

export async function captureCurrentPhoto({ dataDir, kind, targetId, mode = "default", image, context = {}, now = Date.now }) {
  const bytes = await readFile(resolvePhotoFile(dataDir, image));
  const sha256 = imageDigest(bytes);
  const signature = `${image}:${sha256}`;
  const store = createPhotoHistoryStore(dataDir, now);
  // Most reads find the photo already captured; skip the locked index rewrite.
  const captured = store.target(await store.read(), kind, targetId, mode, false);
  if (captured?.sourceSignature === signature) return store.publicPhoto(captured);
  return store.transaction(async (history) => {
    const entry = store.target(history, kind, targetId, mode);
    if (entry.sourceSignature !== signature) {
      const known = entry.versions.find((version) => version.image === image && version.status === "accepted")
        || [...entry.versions].reverse().find((version) => version.sha256 === sha256 && version.status === "accepted");
      const version = known || await store.archive(entry, bytes, { context });
      entry.activeVersionId = version.id;
      entry.sourceSignature = signature;
      entry.undo = null;
    }
    return store.publicPhoto(entry);
  });
}

// Call before replacing an agent-generated collection or deleting source assets.
export async function archiveExistingPhotos({ dataDir, now = Date.now }) {
  const items = await readJson(path.join(dataDir, "library.json"), []);
  const collection = await readJson(path.join(dataDir, "outfits.json"), { outfits: [] });
  for (const item of items) {
    for (const photo of getModeledImages(item)) {
      try { await captureCurrentPhoto({ dataDir, now, kind: "item", targetId: item.id, mode: photo.mode, image: photo.image, context: { name: item.name, part: item.part, canLayer: item.canLayer } }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  for (const outfit of collection.outfits || []) {
    if (!outfit.image) continue;
    try { await captureCurrentPhoto({ dataDir, now, kind: "outfit", targetId: outfit.id, image: outfit.image, context: { name: outfit.name, garmentIds: outfit.garmentIds, garmentModes: outfit.garmentModes, occasion: outfit.occasion } }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// Agent generation and the web API share the same immutable image ledger.
// This lock is in photo-history/, independent of the wardrobe library lock.
export async function archiveGeneratedPhoto({ dataDir, kind, targetId, mode = "default", bytes, activate = false, ...metadata }) {
  assertPhotoTarget({ kind, targetId, mode });
  if (activate && metadata.status && metadata.status !== "accepted") throw new Error("Only accepted photos can be activated");
  const store = createPhotoHistoryStore(path.resolve(dataDir));
  return store.transaction(async (history) => {
    const entry = store.target(history, kind, targetId, mode);
    const version = await store.archive(entry, bytes, { source: "agent", ...metadata });
    if (activate) { entry.activeVersionId = version.id; entry.undo = null; }
    return version;
  });
}
