// Pure storage-key helpers shared by the storage backends and the backend
// router. Kept dependency-free and side-effect-free so they can be unit tested
// in isolation (see tests/storage.test.mjs).

// The single manifest + asset key scheme used across both storage backends.
// Everything lives under a flat, predictable namespace so the same keys resolve
// identically whether they are Vercel Blob pathnames or local files under the
// data directory.
export const LIBRARY_MANIFEST_KEY = "library.json";
export const OUTFITS_MANIFEST_KEY = "outfits.json";
export const REFERENCE_KEY = "private/model-reference.png";
export const LIBRARY_PREFIX = "imported";
export const OUTFIT_IMAGE_PREFIX = "outfit-images";
export const JOBS_PREFIX = "jobs";

// Normalize an arbitrary caller-supplied key into a safe storage key.
//
// - converts backslashes to forward slashes
// - strips leading/trailing slashes and collapses repeated slashes
// - rejects any path-traversal (`..`) or current-dir (`.`) segments
// - only allows [A-Za-z0-9._-] within a segment; other characters become "-"
//
// Throws on traversal rather than silently dropping it, so an attempt to escape
// the namespace is a hard error instead of a surprising read/write elsewhere.
export function normalizeStorageKey(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw Object.assign(new Error("Storage key is required"), { status: 400 });
  }
  const segments = input
    .replace(/\\+/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const safe = [];
  for (const segment of segments) {
    if (segment === "." ) continue;
    if (segment === "..") {
      throw Object.assign(new Error("Illegal storage key"), { status: 400 });
    }
    safe.push(segment.replace(/[^A-Za-z0-9._-]/g, "-"));
  }
  if (!safe.length) {
    throw Object.assign(new Error("Storage key is required"), { status: 400 });
  }
  return safe.join("/");
}

// A library id always has the shape `import-<slug>`; from it we derive the
// deterministic garment / modeled asset filenames and their public API paths.
export function garmentFilename(importId) {
  return `${importId}-garment.png`;
}

export function modeledFilename(importId) {
  return `${importId}-modeled.png`;
}

export function libraryAssetKey(filename) {
  return `${LIBRARY_PREFIX}/${normalizeBasename(filename)}`;
}

export function outfitImageKey(outfitId) {
  return `${OUTFIT_IMAGE_PREFIX}/${normalizeBasename(outfitId)}.png`;
}

export function jobKey(jobId) {
  return `${JOBS_PREFIX}/${normalizeBasename(jobId)}/job.json`;
}

export function jobAssetKey(jobId, filename) {
  return `${JOBS_PREFIX}/${normalizeBasename(jobId)}/${normalizeBasename(filename)}`;
}

// Public API url builders (what the browser sees). These never expose the
// underlying storage/Blob location.
export const LIBRARY_ASSET_ROOT = "/api/import/library";
export const JOB_ASSET_ROOT = "/api/import/assets";
export const OUTFIT_IMAGE_ROOT = "/api/import/outfits";

export function libraryAssetUrl(filename) {
  return `${LIBRARY_ASSET_ROOT}/${normalizeBasename(filename)}`;
}

// Reduce any value to a single safe path segment (no slashes, no traversal).
export function normalizeBasename(value) {
  const normalized = normalizeStorageKey(String(value));
  const base = normalized.split("/").pop();
  if (!base) throw Object.assign(new Error("Illegal storage key"), { status: 400 });
  return base;
}

// Extract the trailing filename from an internal `/api/import/library/<file>`
// url (used when persisting/copying assets between namespaces).
export function basenameFromUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const pathname = url.split(/[?#]/, 1)[0];
  const base = pathname.split("/").filter(Boolean).pop();
  return base || null;
}
