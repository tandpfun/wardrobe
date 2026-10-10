#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { getExpectedModeledModes, getModeledImages, MODES, normalizeLayering, normalizeWardrobeItem } from "../../../../src/wardrobe-model.js";
import { atomicJson, readJson, withLibraryLock } from "../../../../scripts/library-store.mjs";
import { archiveExistingPhotos, archiveGeneratedPhoto, imageDigest } from "../../../../scripts/photo-history.mjs";
import { resolveWardrobeDataDir } from "../../../../scripts/wardrobe-paths.mjs";

const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX = /^#[0-9a-f]{6}$/i;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: import-to-wardrobe.mjs --items <directory> --manifest <file> [--modeled <directory>] [--repo <directory>] [--dry-run]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (!["--items", "--manifest", "--modeled", "--repo"].includes(argument)) usage(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.items) usage("--items is required");
  if (!options.manifest) usage("--manifest is required");
  return options;
}

function safeSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Invalid slug: ${value}`);
  return value;
}

function stableUuid(hash) {
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function localPng(value, slug, field) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*\.png$/i.test(value)) {
    throw new Error(`${slug}: ${field} must be a local PNG filename without a path`);
  }
  return value;
}

function normalizeItem(item) {
  if (!item || item.status !== "accepted") return null;
  const slug = safeSlug(item.slug);
  if (!PARTS.has(item.part)) throw new Error(`${slug}: invalid part ${item.part}`);
  if (!HEX.test(item.color)) throw new Error(`${slug}: color must be a six-digit hex value`);
  if (item.secondaryColor !== null && item.secondaryColor !== undefined && !HEX.test(item.secondaryColor)) throw new Error(`${slug}: secondaryColor must be null or a six-digit hex value`);
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const classified = Object.hasOwn(item, "canLayer");
  if (classified && typeof item.canLayer !== "boolean") {
    throw new Error(`${slug}: canLayer must be a boolean`);
  }
  if (item.layeringSource !== undefined && !["ai", "manual"].includes(item.layeringSource)) {
    throw new Error(`${slug}: layeringSource must be ai or manual`);
  }
  let modeledFiles = [];
  if (item.modeledFiles !== undefined) {
    if (!Array.isArray(item.modeledFiles)) throw new Error(`${slug}: modeledFiles must be an array`);
    const modes = new Set();
    modeledFiles = item.modeledFiles.map((entry) => {
      const mode = entry?.mode;
      if (!MODES.has(mode) || modes.has(mode)) throw new Error(`${slug}: modeledFiles must have unique valid modes`);
      modes.add(mode);
      if (entry.prompt !== undefined && entry.prompt !== null && (typeof entry.prompt !== "string" || entry.prompt.length > 60000)) throw new Error(`${slug}: modeled prompt must be text or null`);
      if (entry.context !== undefined && (!entry.context || typeof entry.context !== "object" || Array.isArray(entry.context))) throw new Error(`${slug}: modeled context must be an object`);
      return { mode, file: localPng(entry.file, slug, "modeledFiles.file"), prompt: entry.prompt ?? null, context: entry.context || {} };
    });
  } else if (item.modeledFile) {
    modeledFiles = [{ mode: null, file: localPng(item.modeledFile, slug, "modeledFile") }];
  }
  return {
    slug,
    file: localPng(item.file || `${slug}.png`, slug, "file"),
    modeledFiles,
    modeledFilesPresent: item.modeledFiles !== undefined,
    classified,
    ...(classified ? { canLayer: item.canLayer, layeringSource: item.layeringSource || "ai" } : {}),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    part: item.part,
    color: item.color.toLowerCase(),
    secondaryColor: item.secondaryColor?.toLowerCase() || null,
    tags,
  };
}

async function validatePng(file, slug) {
  const bytes = await readFile(file);
  const image = sharp(bytes);
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.hasAlpha) throw new Error(`${slug}: PNG has no alpha channel`);
  const stats = await image.stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return { bytes, hash: imageDigest(bytes) };
}

async function validateModeledPng(file, slug) {
  const bytes = await readFile(file);
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.width || !metadata.height) throw new Error(`${slug}: modeled PNG has invalid dimensions`);
  return { bytes };
}

async function writeAsset(file, bytes) {
  try { await writeFile(file, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error(`Asset content conflicts with ${path.basename(file)}`);
  }
}

function previewModes(item, layering, existing) {
  const modes = item.modeledFiles.map(({ mode }) => mode || "default");
  if (modes.length && (item.classified || item.modeledFilesPresent || existing?.canLayer !== undefined)) {
    const expected = getExpectedModeledModes({ ...item, ...layering });
    if (modes.length !== expected.length || expected.some((mode) => !modes.includes(mode))) {
      throw new Error(`${item.slug}: modeled photos must have exactly ${expected.join(" and ")} modes; check saved manual choices before generation`);
    }
  }
  return modes;
}

const options = parseArgs(process.argv.slice(2));
const repo = path.resolve(options.repo);
const itemsDir = path.resolve(options.items);
const modeledDir = options.modeled ? path.resolve(options.modeled) : null;
const manifestFile = path.resolve(options.manifest);
const packageFile = path.join(repo, "package.json");
const packageJson = await readJson(packageFile, null);
if (!packageJson || packageJson.name !== "wardrobe") throw new Error(`Not a Wardrobe repository: ${repo}`);

const manifest = await readJson(manifestFile, null);
if (!manifest || !Array.isArray(manifest.items)) throw new Error("Manifest must contain an items array");
const accepted = manifest.items.map(normalizeItem).filter(Boolean);
if (!accepted.length) throw new Error("Manifest contains no accepted items");
if (new Set(accepted.map(({ slug }) => slug)).size !== accepted.length) throw new Error("Accepted item slugs must be unique");

const prepared = [];
for (const item of accepted) {
  const source = path.resolve(itemsDir, item.file);
  if (path.dirname(source) !== itemsDir) throw new Error(`${item.slug}: file must be directly inside the items directory`);
  if (!(await stat(source)).isFile()) throw new Error(`${item.slug}: source is not a file`);
  const { bytes, hash } = await validatePng(source, item.slug);
  const uuid = stableUuid(hash);
  const id = `import-${uuid}`;
  const assetName = `${id}-garment.png`;
  const models = [];
  for (const model of item.modeledFiles) {
    if (!modeledDir) throw new Error(`${item.slug}: --modeled is required when modeled files are set`);
    const modeledSource = path.resolve(modeledDir, model.file);
    if (path.dirname(modeledSource) !== modeledDir) throw new Error(`${item.slug}: modeledFile must be directly inside the modeled directory`);
    if (!(await stat(modeledSource)).isFile()) throw new Error(`${item.slug}: modeled source is not a file`);
    const modeled = await validateModeledPng(modeledSource, item.slug);
    models.push({ ...model, ...modeled });
  }
  prepared.push({ ...item, bytes, uuid, id, assetName, models });
}
if (new Set(prepared.map(({ id }) => id)).size !== prepared.length) throw new Error("Accepted items contain duplicate garment cutouts; consolidate physical items in the manifest");

const dataDir = resolveWardrobeDataDir(repo);
const importedDir = path.join(dataDir, "imported");
const libraryFile = path.join(dataDir, "library.json");
async function importRecords() {
  const records = await readJson(libraryFile, []);
  if (!Array.isArray(records)) throw new Error(`${libraryFile} must contain a JSON array`);

  const nextRecords = records.map(normalizeWardrobeItem);
  // Validate every item's modes before writing any asset or history version.
  const planned = prepared.map((item) => {
    const existing = nextRecords.find((entry) => entry.id === item.id);
    const layering = normalizeLayering(item, existing || {});
    const modes = previewModes(item, layering, existing);
    const models = item.models.map((model, index) => ({ ...model, mode: modes[index] }))
      .sort((first, second) => (first.mode === "layer") - (second.mode === "layer"));
    return { item, existing, layering, models };
  });

  if (!options.dryRun) {
    await archiveExistingPhotos({ dataDir });
    await mkdir(importedDir, { recursive: true });
  }
  for (const { item, existing, layering, models } of planned) {
    let modeledImages = getModeledImages(existing || {});
    if (!options.dryRun) {
      await writeAsset(path.join(importedDir, item.assetName), item.bytes);
      if (models.length) modeledImages = [];
      for (const model of models) {
        const version = await archiveGeneratedPhoto({
          dataDir, kind: "item", targetId: item.id, mode: model.mode,
          bytes: model.bytes, source: "agent", status: "accepted", activate: false,
          prompt: model.prompt ?? null,
          context: { ...model.context, name: item.name, part: item.part, canLayer: layering.canLayer },
        });
        modeledImages.push({ id: `${item.id}-${model.mode}`, mode: model.mode, image: version.image });
      }
    }
    const assetUrl = `/api/import/library/${item.assetName}`;
    const record = {
      id: item.id,
      name: item.name,
      part: item.part,
      color: item.color,
      secondaryColor: item.secondaryColor,
      palette: [item.color, item.secondaryColor].filter(Boolean),
      tags: item.tags,
      image: assetUrl,
      thumbnail: assetUrl,
      ...layering,
      modeledImages,
      modeledImage: modeledImages[0]?.image || null,
      importJobId: item.uuid,
    };
    if (existing) nextRecords[nextRecords.indexOf(existing)] = { ...existing, ...record };
    else nextRecords.push(record);
  }

  if (!options.dryRun) await atomicJson(libraryFile, nextRecords);
  return { nextRecords, planned };
}

// Re-read manual choices while holding the same cross-process lock as the UI.
const { nextRecords, planned } = await withLibraryLock(libraryFile, importRecords);

console.log(JSON.stringify({
  dryRun: options.dryRun,
  imported: prepared.length,
  total: nextRecords.length,
  library: libraryFile,
  items: planned.map(({ item, models }) => ({ id: item.id, name: item.name, part: item.part, assetName: item.assetName, modeledModes: models.map((model) => model.mode) })),
}, null, 2));
