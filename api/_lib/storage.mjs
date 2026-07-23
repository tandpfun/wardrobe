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
// - BlobStore  : Vercel Blob, selected automatically when BLOB_READ_WRITE_TOKEN
//                is present (i.e. on Vercel, or `vercel dev` with a linked
//                Blob store). Images are stored with public access but their
//                Blob URLs are NEVER returned to the browser: every asset is
//                streamed back through an authenticated API function, so the
//                app stays private.
//   LocalStore : plain filesystem under the data directory. Used for local
//                development of the functions and for tests, so no cloud
//                credentials are required to exercise the code paths.
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

class BlobStore {
  constructor(token, blob) {
    this.token = token;
    this.blob = blob;
    this.backend = "blob";
    this.urlCache = new Map();
  }

  async #url(normalized) {
    if (this.urlCache.has(normalized)) return this.urlCache.get(normalized);
    try {
      const meta = await this.blob.head(normalized, { token: this.token });
      const url = meta?.url || null;
      if (url) this.urlCache.set(normalized, url);
      return url;
    } catch {
      return null;
    }
  }

  async readJson(key, fallback = null) {
    const normalized = normalizeStorageKey(key);
    const url = await this.#url(normalized);
    if (!url) return fallback;
    try {
      const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return fallback;
      return await response.json();
    } catch {
      return fallback;
    }
  }

  async writeJson(key, value) {
    const normalized = normalizeStorageKey(key);
    const result = await this.blob.put(normalized, `${JSON.stringify(value, null, 2)}\n`, {
      access: "public",
      token: this.token,
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    this.urlCache.set(normalized, result.url);
  }

  async putImage(key, buffer, contentType = "image/png") {
    const normalized = normalizeStorageKey(key);
    const result = await this.blob.put(normalized, buffer, {
      access: "public",
      token: this.token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    this.urlCache.set(normalized, result.url);
  }

  async getImage(key) {
    const normalized = normalizeStorageKey(key);
    const url = await this.#url(normalized);
    if (!url) return null;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return { data, contentType: response.headers.get("content-type") || contentTypeFor(normalized) };
  }

  async exists(key) {
    return Boolean(await this.#url(normalizeStorageKey(key)));
  }

  async del(key) {
    const normalized = normalizeStorageKey(key);
    const url = await this.#url(normalized);
    this.urlCache.delete(normalized);
    if (url) {
      await this.blob.del(url, { token: this.token }).catch(() => {});
    }
  }

  async list(prefix) {
    const normalized = normalizeStorageKey(prefix);
    const result = await this.blob.list({ prefix: `${normalized}/`, token: this.token });
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

let cached;

// Returns the process-wide store, choosing the Blob backend when a token is
// configured and falling back to the local filesystem otherwise.
export async function getStore(env = process.env) {
  if (cached) return cached;
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const blob = await import("@vercel/blob");
    cached = new BlobStore(token, blob);
  } else {
    const baseDir = path.resolve(process.cwd(), env.WARDROBE_DATA_DIR || "data");
    cached = new LocalStore(baseDir);
  }
  return cached;
}

// Exposed for tests so a fresh in-memory-ish local store can be constructed
// against a temp directory without touching the module-level cache.
export function createLocalStore(baseDir) {
  return new LocalStore(baseDir);
}

export { LocalStore, BlobStore };
