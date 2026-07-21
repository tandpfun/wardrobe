import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const API_ROOT = "/api/immich";
const UUID = /^[a-f0-9-]{36}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected JSON"), { status: 400 }); }
}

function yearsAgo(years) {
  const value = new Date();
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString();
}

function publicAsset(asset) {
  return {
    id: asset.id,
    type: asset.type,
    originalFileName: asset.originalFileName || "Immich photo",
    fileCreatedAt: asset.fileCreatedAt,
    localDateTime: asset.localDateTime,
    width: asset.width,
    height: asset.height,
    isFavorite: Boolean(asset.isFavorite),
    thumbnailUrl: `${API_ROOT}/assets/${asset.id}/thumbnail`,
    originalUrl: `${API_ROOT}/assets/${asset.id}/original`,
  };
}

async function limitedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("Immich image is too large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Immich image is too large"), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function immichApi(options = {}) {
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const baseUrl = () => setting("IMMICH_BASE_URL", "").replace(/\/$/, "");
  const keyFile = () => setting("IMMICH_API_KEY_FILE", "/run/secrets/immich-api-key");
  const years = () => Math.max(1, Math.min(10, Number(setting("IMMICH_YEARS", "4")) || 4));
  const referencePath = () => path.resolve(setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));

  async function credentials() {
    const url = baseUrl();
    if (!url) throw Object.assign(new Error("Immich is not configured"), { status: 503 });
    let key;
    try { key = (await readFile(keyFile(), "utf8")).trim(); }
    catch { throw Object.assign(new Error("Immich credential is unavailable"), { status: 503 }); }
    if (!key) throw Object.assign(new Error("Immich credential is empty"), { status: 503 });
    return { url, key };
  }

  async function request(endpoint, init = {}) {
    const { url, key } = await credentials();
    const response = await fetch(`${url}${endpoint}`, {
      ...init,
      headers: { "x-api-key": key, ...(init.headers || {}) },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error(error.message || `Immich request failed (${response.status})`), { status: response.status });
    }
    return response;
  }

  async function search(url) {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const size = Math.max(1, Math.min(60, Number(url.searchParams.get("size")) || 30));
    const query = (url.searchParams.get("query") || "").trim().slice(0, 160);
    const smart = url.searchParams.get("mode") !== "recent";
    const payload = {
      takenAfter: yearsAgo(years()),
      page,
      size,
      ...(smart ? { query: query || "full body photo of a person wearing visible clothes" } : { type: "IMAGE", order: "desc" }),
    };
    const response = await request(smart ? "/api/search/smart" : "/api/search/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    const assets = result.assets || {};
    return {
      items: (assets.items || []).filter((asset) => asset.type === "IMAGE").map(publicAsset),
      nextPage: assets.nextPage || null,
      page,
      years: years(),
      mode: smart ? "smart" : "recent",
      query,
    };
  }

  async function streamAsset(res, id, variant) {
    if (!UUID.test(id)) throw Object.assign(new Error("Invalid Immich asset id"), { status: 400 });
    const endpoint = variant === "thumbnail"
      ? `/api/assets/${id}/thumbnail?size=thumbnail`
      : `/api/assets/${id}/original`;
    const response = await request(endpoint);
    const bytes = await limitedBytes(response, variant === "thumbnail" ? 10 * 1024 * 1024 : 18 * 1024 * 1024);
    res.statusCode = 200;
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Cache-Control", variant === "thumbnail" ? "private, max-age=3600" : "no-store");
    res.end(bytes);
  }

  return {
    name: "wardrobe-immich-api",
    apply: "serve",
    configurePreviewServer(server) { server.middlewares.use(handler); },
    configureServer(server) { server.middlewares.use(handler); },
  };

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(`${API_ROOT}/`)) return next();
    try {
      if (url.pathname === `${API_ROOT}/config` && req.method === "GET") {
        const response = await request("/api/server/ping");
        const ping = await response.json();
        return json(res, 200, { ready: true, years: years(), ping: ping.res || "pong" });
      }
      if (url.pathname === `${API_ROOT}/assets` && req.method === "GET") {
        return json(res, 200, await search(url));
      }
      const assetMatch = url.pathname.match(/^\/api\/immich\/assets\/([a-f0-9-]{36})\/(thumbnail|original)$/i);
      if (assetMatch && req.method === "GET") return await streamAsset(res, assetMatch[1], assetMatch[2]);
      if (url.pathname === `${API_ROOT}/reference` && req.method === "POST") {
        const input = await body(req);
        if (!UUID.test(input.assetId || "")) throw Object.assign(new Error("A valid Immich asset id is required"), { status: 400 });
        const response = await request(`/api/assets/${input.assetId}/original`);
        const bytes = await limitedBytes(response, 64 * 1024 * 1024);
        const normalized = await sharp(bytes)
          .rotate()
          .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
          .toColorspace("srgb")
          .png({ compressionLevel: 9 })
          .toBuffer();
        await mkdir(path.dirname(referencePath()), { recursive: true, mode: 0o700 });
        await writeFile(referencePath(), normalized, { mode: 0o600 });
        return json(res, 200, { saved: true, modelReference: referencePath() });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status || 500;
      return json(res, status, { error: status === 500 ? "Immich integration failed" : error.message });
    }
  }
}
