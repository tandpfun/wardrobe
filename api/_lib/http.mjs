// Small adapters between Vercel's Node (req, res) functions and the pure,
// backend-agnostic router in backend.mjs. Kept tiny so the functions in api/
// stay declarative.

// Read and JSON-parse a request body. Vercel may have already parsed the body
// (req.body populated) — in that case reuse it rather than re-reading a stream
// that has already been consumed. Falls back to streaming for the raw runtime.
export async function readJsonBody(req, limit = 6 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (!req.body) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw Object.assign(new Error("Expected a JSON request body"), { status: 400 });
      }
    }
    if (Buffer.isBuffer(req.body)) {
      if (!req.body.length) return {};
      try {
        return JSON.parse(req.body.toString("utf8"));
      } catch {
        throw Object.assign(new Error("Expected a JSON request body"), { status: 400 });
      }
    }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Expected a JSON request body"), { status: 400 });
  }
}

export function sendJson(res, status, value, headers) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!headers || !headers["Cache-Control"]) res.setHeader("Cache-Control", "no-store");
  if (headers) {
    for (const [name, val] of Object.entries(headers)) {
      if (val != null) res.setHeader(name, val);
    }
  }
  res.end(JSON.stringify(value));
}

// Write a `{ status, json?, image?, headers? }` result from the router to the
// Node response.
export function sendResult(res, result) {
  const headers = result.headers || {};
  if (result.image) {
    res.statusCode = result.status || 200;
    res.setHeader("Content-Type", result.image.contentType || "application/octet-stream");
    if (!headers["Cache-Control"]) res.setHeader("Cache-Control", "no-store");
    for (const [name, val] of Object.entries(headers)) {
      if (val != null) res.setHeader(name, val);
    }
    res.end(result.image.data);
    return;
  }
  sendJson(res, result.status || 200, result.json ?? {}, headers);
}

// Normalize a catch-all `path` param (string or string[]) into path segments.
export function pathSegments(pathParam) {
  if (Array.isArray(pathParam)) return pathParam.filter((s) => s != null && s !== "");
  if (typeof pathParam === "string" && pathParam) return pathParam.split("/").filter(Boolean);
  return [];
}
