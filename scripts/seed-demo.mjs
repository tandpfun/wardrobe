// Seeds a small, OpenAI-free demo wardrobe and outfit collection so the app is
// fully explorable without an API key or a personal reference photo. Every
// asset is drawn locally with `sharp`; no model or network call is involved.
//
// Usage: node scripts/seed-demo.mjs [--force]
//   --force overwrites an existing library.json / outfits.json. Without it the
//   script refuses to touch a non-empty wardrobe so real data is never clobbered.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson } from "./fs-utils.mjs";
import { GARMENTS, OUTFITS, garmentPng } from "./demo-fixtures.mjs";
import { composeOutfitPreview, normalizeOutfitsFile, outfitPaths } from "./outfits-store.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
const libraryFile = path.join(dataDir, "library.json");
const libraryAssetDir = path.join(dataDir, "imported");

async function libraryIsEmpty() {
  try {
    const parsed = JSON.parse(await readFile(libraryFile, "utf8"));
    return !(Array.isArray(parsed) && parsed.length);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function outfitsAreEmpty() {
  const { file } = outfitPaths(dataDir);
  try {
    const parsed = normalizeOutfitsFile(JSON.parse(await readFile(file, "utf8")));
    return parsed.outfits.length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  if (!force && !(await libraryIsEmpty() && await outfitsAreEmpty())) {
    console.error("Refusing to overwrite an existing wardrobe. Re-run with --force to reseed demo data.");
    process.exitCode = 1;
    return;
  }

  await mkdir(libraryAssetDir, { recursive: true });
  const { imageDir } = outfitPaths(dataDir);
  await mkdir(imageDir, { recursive: true });

  const buffers = new Map();
  const records = [];
  for (const garment of GARMENTS) {
    const png = await garmentPng(garment);
    buffers.set(garment.id, png);
    const fileName = `${garment.id}-garment.png`;
    await writeFile(path.join(libraryAssetDir, fileName), png);
    const image = `/api/import/library/${fileName}`;
    records.push({
      id: garment.id,
      name: garment.name,
      part: garment.part,
      color: garment.color,
      secondaryColor: null,
      palette: [garment.color],
      tags: garment.tags,
      image,
      thumbnail: image,
      modeledImage: null,
      importJobId: null,
      source: "demo",
    });
  }
  await atomicJson(libraryFile, records);

  const now = new Date().toISOString();
  const outfits = [];
  for (const outfit of OUTFITS) {
    const preview = await composeOutfitPreview(outfit.garmentIds.map((id) => buffers.get(id)).filter(Boolean));
    await writeFile(path.join(imageDir, `${outfit.id}.png`), preview);
    outfits.push({
      ...outfit,
      status: "ready",
      imageMode: "demo",
      hasImage: true,
      source: "demo",
      createdAt: now,
      updatedAt: now,
    });
  }
  await atomicJson(outfitPaths(dataDir).file, { version: 2, outfits });

  console.log(`Seeded ${records.length} demo garments and ${outfits.length} demo outfits into ${path.relative(root, dataDir) || "."}/.`);
  console.log("Start the app with `npm run dev` and open the Outfits tab to explore.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
