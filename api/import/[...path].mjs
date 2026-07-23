// Authenticated catch-all for all app data + pipeline routes.
//
// Every request under /api/import/* is gated by the shared app session (cookie
// or Bearer passcode). Reads/writes go through the durable store; image
// generation runs synchronously inside the request (see backend.mjs). GET
// asset routes stream bytes back through this function so the underlying Blob
// URLs are never exposed to the browser.

import { getStore } from "../_lib/storage.mjs";
import { handleImportApi } from "../_lib/backend.mjs";
import { isAuthenticated, authConfigured } from "../_lib/auth.mjs";
import { readJsonBody, sendJson, sendResult, pathSegments } from "../_lib/http.mjs";

// Image generation can take a while; give the function room. Vercel caps this
// by plan (Hobby ~60s); documented as a limitation in the handoff.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const env = process.env;
  if (!authConfigured(env)) {
    return sendJson(res, 503, { error: "App access is not configured (APP_PASSCODE is unset)." });
  }
  if (!isAuthenticated(req, env)) {
    return sendJson(res, 401, { error: "Authentication required." });
  }

  const method = (req.method || "GET").toUpperCase();
  const segments = pathSegments(req.query?.path);

  let body = {};
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
  }

  try {
    const store = await getStore(env);
    const result = await handleImportApi({ store, env, method, segments, body, query: req.query || {} });
    return sendResult(res, result);
  } catch (error) {
    // Never leak internals; log a short message server-side only. Errors marked
    // `expose` (e.g. fail-closed storage misconfiguration) carry a safe message.
    console.error("import handler error:", error?.message || "unknown");
    if (error?.expose) return sendJson(res, error.status || 500, { error: error.message });
    return sendJson(res, error?.status || 500, { error: "Internal error handling request." });
  }
}
