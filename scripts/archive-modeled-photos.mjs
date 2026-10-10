#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { archiveExistingPhotos, archiveGeneratedPhoto, assertPhotoTarget } from "./photo-history.mjs";
import { resolveWardrobeDataDir } from "./wardrobe-paths.mjs";

const usage = "Usage: node scripts/archive-modeled-photos.mjs [--data <directory>] --manifest <file.json>";

async function main(argv) {
  let dataDir = resolveWardrobeDataDir();
  let manifestFile;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) { console.log(usage); return; }
    if (!["--data", "--manifest"].includes(argument)) throw new Error(usage);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--data") dataDir = path.resolve(value);
    else if (manifestFile) throw new Error("Provide one manifest");
    else manifestFile = path.resolve(value);
  }
  if (!manifestFile) throw new Error(usage);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (!Array.isArray(manifest.photos) || !manifest.photos.length) throw new Error("Manifest must contain a nonempty photos array");
  const prepared = await Promise.all(manifest.photos.map(async (photo) => {
    assertPhotoTarget(photo ?? {});
    if (!["accepted", "rejected", "invalid"].includes(photo.status) || typeof photo.activate !== "boolean" || (photo.activate && photo.status !== "accepted")) throw new Error("Only accepted photos can be activated; every photo needs status and activate");
    if (typeof photo.file !== "string" || !photo.file) throw new Error("Each photo needs a local file");
    if (!(photo.prompt === null || typeof photo.prompt === "string")) throw new Error("Each photo needs its exact prompt, or null when unknown");
    if (!photo.context || typeof photo.context !== "object" || Array.isArray(photo.context)) throw new Error("Each photo needs generation context");
    const sourceFile = path.resolve(path.dirname(manifestFile), photo.file);
    const bytes = await readFile(sourceFile);
    return { dataDir, kind: photo.kind, targetId: photo.targetId, mode: photo.mode, bytes, prompt: photo.prompt, context: photo.context, status: photo.status, activate: photo.activate, source: photo.source === "legacy" ? "legacy" : "agent" };
  }));
  await archiveExistingPhotos({ dataDir });
  const photos = [];
  for (const photo of prepared) {
    const version = await archiveGeneratedPhoto(photo);
    photos.push({ kind: photo.kind, targetId: photo.targetId, mode: photo.mode, ...version });
  }
  console.log(JSON.stringify({ archived: photos.length, photos }, null, 2));
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
