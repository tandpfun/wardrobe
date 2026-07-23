// Emits a single self-contained demo bundle (`public/demo-data.json`) for
// static/browser deployments (e.g. Vercel) where the Vite middleware backend
// and filesystem persistence are unavailable. Garment cutouts and outfit
// previews are rendered locally with `sharp` and inlined as base64 data URLs so
// the shipped bundle needs no `/api` endpoint and no binary asset files. The
// browser data adapter (`src/data-browser.js`) seeds itself from this file and
// then persists user changes in localStorage.
//
// Usage: node scripts/seed-demo-static.mjs
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GARMENTS, OUTFITS, garmentPng } from "./demo-fixtures.mjs";
import { composeOutfitPreview } from "./outfits-store.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outFile = path.join(root, "public", "demo-data.json");

function dataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function main() {
  const buffers = new Map();
  const garments = [];
  for (const garment of GARMENTS) {
    const png = await garmentPng(garment);
    buffers.set(garment.id, png);
    const image = dataUrl(png);
    garments.push({
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

  const now = new Date().toISOString();
  const outfits = [];
  for (const outfit of OUTFITS) {
    const preview = await composeOutfitPreview(outfit.garmentIds.map((id) => buffers.get(id)).filter(Boolean));
    outfits.push({
      ...outfit,
      status: "ready",
      imageMode: "demo",
      image: dataUrl(preview),
      source: "demo",
      createdAt: now,
      updatedAt: now,
    });
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify({ version: 1, garments, outfits }));
  console.log(`Wrote ${garments.length} garments and ${outfits.length} outfits to ${path.relative(root, outFile)}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
