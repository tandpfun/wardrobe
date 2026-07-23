#!/usr/bin/env node
// One-time bulk import CLI for seeding a deployed wardrobe.
//
// Sends already-processed garment cutouts (and optionally the private reference
// photo) to the authenticated /api/bulk-import endpoint, one item per request
// so each stays well under Vercel's ~4.5MB body limit. Authentication uses the
// app passcode as a Bearer token; the passcode is read from the environment
// (WARDROBE_PASSCODE) and is never printed or written to disk.
//
// Usage:
//   WARDROBE_PASSCODE=... node scripts/bulk-import.mjs \
//     --base https://your-app.vercel.app \
//     --reference /path/to/model-reference.jpg \
//     --manifest /path/to/manifest.json
//
//   # or import loose image files as garments with default metadata:
//   WARDROBE_PASSCODE=... node scripts/bulk-import.mjs --base <url> photo1.jpg photo2.png
//
// A manifest is a JSON array of items:
//   [
//     { "file": "shirt.png", "name": "Linen shirt", "part": "upperbody",
//       "color": "#d8d0c2", "secondaryColor": null, "tags": ["summer"] },
//     ...
//   ]
// Paths in a manifest are resolved relative to the manifest's directory.

import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const options = { base: process.env.WARDROBE_BASE_URL || "http://localhost:3000", files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") options.base = argv[++i];
    else if (arg === "--reference") options.reference = argv[++i];
    else if (arg === "--manifest") options.manifest = argv[++i];
    else if (arg === "--passcode") options.passcode = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function mimeFor(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || "image/png";
}

async function toDataUrl(file) {
  const data = await readFile(file);
  return `data:${mimeFor(file)};base64,${data.toString("base64")}`;
}

async function post(base, passcode, payload) {
  const response = await fetch(new URL("/api/bulk-import", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${passcode}`,
    },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error || response.statusText}`);
  }
  return body;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const passcode = options.passcode || process.env.WARDROBE_PASSCODE;
  if (!passcode) {
    console.error("Set WARDROBE_PASSCODE (or pass --passcode) with the app passcode.");
    process.exit(1);
  }

  let imported = 0;

  if (options.reference) {
    const imageDataUrl = await toDataUrl(options.reference);
    await post(options.base, passcode, { kind: "reference", imageDataUrl });
    // Log only the filename, never the bytes.
    console.log(`Set private reference photo from ${path.basename(options.reference)}`);
  }

  const items = [];
  if (options.manifest) {
    const manifestDir = path.dirname(path.resolve(options.manifest));
    const entries = JSON.parse(await readFile(options.manifest, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Manifest must be a JSON array.");
    for (const entry of entries) {
      if (!entry.file) throw new Error("Each manifest item needs a \"file\".");
      items.push({ file: path.resolve(manifestDir, entry.file), metadata: entry, id: entry.id });
    }
  }
  for (const file of options.files) {
    items.push({ file: path.resolve(file), metadata: {} });
  }

  for (const item of items) {
    const imageDataUrl = await toDataUrl(item.file);
    const metadata = {
      name: item.metadata.name,
      part: item.metadata.part,
      color: item.metadata.color,
      secondaryColor: item.metadata.secondaryColor,
      tags: item.metadata.tags,
    };
    const result = await post(options.base, passcode, { kind: "garment", id: item.id, imageDataUrl, metadata });
    imported += 1;
    console.log(`Imported ${path.basename(item.file)} -> ${result.record?.id || "(ok)"}`);
  }

  console.log(`Done. ${imported} garment(s) imported${options.reference ? ", reference photo set" : ""}.`);
}

main().catch((error) => {
  console.error(`Bulk import failed: ${error.message}`);
  process.exit(1);
});
