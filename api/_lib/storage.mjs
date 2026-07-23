// Durable storage abstraction for the Vercel production backend.
//
// Two interchangeable backends implement the same tiny interface:
//   readJson(key, fallback) -> value
//   writeJson(key, value)   -> void
//   putImage(key, buffer, contentType) -> void
//   getImage(key)           -> { data: Buffer, contentType } | null
//   exists(key)             -> boolean
//   del(key)                -> void
//   list(prefix)            -> string[]  (full keys)
//
// - BlobStore  : Vercel Blob using PRIVATE access. Every object is written with
//                `access: 'private'`, and every read goes through the SDK's
//                authenticated `get()` (by pathname, which resolves the store
//                URL internally). No Blob URL, token, or store id is ever
//                returned to the browser: assets are streamed back through an
//                app-authenticated API function. The store is authenticated
//                either by a read-write token (BLOB_READ_WRITE_TOKEN, for
//                local/admin import) or by Vercel OIDC (VERCEL_OIDC_TOKEN +
//                BLOB_STORE_ID) for connected projects.
//   LocalStore : plain filesystem under the data directory. Used for local
//                development of the functions and for tests, so no cloud
//                credentials are required to exercise the code paths. NEVER
//                used on Vercel — getStore fails closed there when no durable
//                private Blob store is configured.
//
// All keys are normalized through normalizeStorageKey so a caller can never
// escape the namespace.

import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeStorageKey } from "./keys.mjs";

class LocalStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.backend = "local";
  }

  resolve(key) {
    const normalized = normalizeStorageKey(key);
    return { normalized, file: path.join(this.baseDir, normalized) };
  }

  async readJson(key, fallback = null) {
    const { file } = this.resolve(key);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      if (error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  async writeJson(key, value) {
    const { file } = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  async putImage(key, buffer, _contentType = "image/png") {
    const { file } = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buffer);
  }

  async getImage(key) {
    const { file } = this.resolve(key);
    try {
      const data = await readFile(file);
      return { data, contentType: contentTypeFor(file) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(key) {
    const { file } = this.resolve(key);
    try {
      await stat(file);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async del(key) {
    const { file } = this.resolve(key);
    await rm(file, { force: true, recursive: true });
  }

  async list(prefix) {
    const { normalized } = this.resolve(prefix);
    const dir = path.join(this.baseDir, normalized);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() || entry.isDirectory()).map((entry) => `${normalized}/${entry.name}`);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function isNotFound(error) {
  const name = error?.name || error?.constructor?.name || "";
  return name === "BlobNotFoundError" || error?.status === 404 || /not.?found/i.test(error?.message || "");
}

// Vercel Blob backed by PRIVATE objects. `auth` is the credential bundle the
// SDK needs: either { token } (read-write token) or { oidcToken, storeId }
// (Vercel OIDC for connected projects). We spread it into every SDK call.
class BlobStore {
  constructor(blob, auth) {
    this.blob = blob;
    this.auth = auth;
    this.backend = "blob";
  }

  async readJson(key, fallback = null) {
    const normalized = normalizeStorageKey(key);
    try {
      const result = await this.blob.get(normalized, { access: "private", useCache: false, ...this.auth });
      if (!result || result.statusCode !== 200) return fallback;
      const buffer = await streamToBuffer(result.stream);
      return JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  async writeJson(key, value) {
    const normalized = normalizeStorageKey(key);
    await this.blob.put(normalized, `${JSON.stringify(value, null, 2)}\n`, {
      access: "private",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      ...this.auth,
    });
  }

  async putImage(key, buffer, contentType = "image/png") {
    const normalized = normalizeStorageKey(key);
    await this.blob.put(normalized, buffer, {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      ...this.auth,
    });
  }

  async getImage(key) {
    const normalized = normalizeStorageKey(key);
    try {
      const result = await this.blob.get(normalized, { access: "private", useCache: false, ...this.auth });
      if (!result || result.statusCode !== 200) return null;
      const data = await streamToBuffer(result.stream);
      const contentType = result.blob?.contentType || result.headers?.get?.("content-type") || contentTypeFor(normalized);
      return { data, contentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async exists(key) {
    const normalized = normalizeStorageKey(key);
    try {
      await this.blob.head(normalized, { ...this.auth });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async del(key) {
    const normalized = normalizeStorageKey(key);
    await this.blob.del(normalized, { ...this.auth }).catch(() => {});
  }

  async list(prefix) {
    const normalized = normalizeStorageKey(prefix);
    const result = await this.blob.list({ prefix: `${normalized}/`, ...this.auth });
    return (result?.blobs || []).map((entry) => entry.pathname);
  }
}

function contentTypeFor(file) {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

// Resolve Blob credentials from the environment. Prefer Vercel OIDC (for
// connected private stores) when both the token and store id are present;
// otherwise use a read-write token (local/admin import). Returns null when no
// durable private store is configured.
export function blobAuth(env = process.env) {
  if (env.VERCEL_OIDC_TOKEN && env.BLOB_STORE_ID) {
    return { oidcToken: env.VERCEL_OIDC_TOKEN, storeId: env.BLOB_STORE_ID };
  }
  if (env.BLOB_READ_WRITE_TOKEN) {
    return { token: env.BLOB_READ_WRITE_TOKEN };
  }
  return null;
}

// Whether a durable private Blob store is configured at all.
export function blobConfigured(env = process.env) {
  return Boolean(blobAuth(env));
}

function onVercel(env) {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

let cached;

// Returns the process-wide store. Uses the private Blob backend when a durable
// store is configured. On Vercel with NO private Blob configured we FAIL CLOSED
// (throw a 503) rather than silently using the ephemeral serverless filesystem,
// which would appear to work but lose the user's photos. Off Vercel (local dev
// / tests) we fall back to the filesystem so the code paths are exercisable
// without cloud credentials.
export async function getStore(env = process.env) {
  if (cached) return cached;
  const auth = blobAuth(env);
  if (auth) {
    const blob = await import("@vercel/blob");
    cached = new BlobStore(blob, auth);
    return cached;
  }
  if (onVercel(env)) {
    throw Object.assign(
      new Error(
        "Durable private Blob storage is not configured. Set BLOB_READ_WRITE_TOKEN, or VERCEL_OIDC_TOKEN together with BLOB_STORE_ID.",
      ),
      { status: 503, expose: true },
    );
  }
  const baseDir = path.resolve(process.cwd(), env.WARDROBE_DATA_DIR || "data");
  cached = new LocalStore(baseDir);
  return cached;
}

// Exposed for tests so a fresh in-memory-ish local store can be constructed
// against a temp directory without touching the module-level cache.
export function createLocalStore(baseDir) {
  return new LocalStore(baseDir);
}

// Reset the module-level store cache. Tests use this so each case picks the
// backend implied by its own env.
export function resetStoreCache() {
  cached = undefined;
}

export { LocalStore, BlobStore };
