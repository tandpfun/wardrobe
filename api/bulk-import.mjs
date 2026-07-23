// Authenticated one-at-a-time bulk import endpoint used by the CLI
// (scripts/bulk-import.mjs) to seed the deployed wardrobe with processed
// cutouts and to designate the private reference photo. Requires the same app
// auth as the rest of the API (cookie or Bearer passcode). Never runs OpenAI
// and never logs image bytes or secrets.

import { getStore } from "./_lib/storage.mjs";
import { handleBulkImport } from "./_lib/backend.mjs";
import { isAuthenticated, authConfigured } from "./_lib/auth.mjs";
import { readJsonBody, sendResult, sendJson } from "./_lib/http.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const env = process.env;
  if ((req.method || "GET").toUpperCase() !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  if (!authConfigured(env)) {
    return sendJson(res, 503, { error: "App access is not configured (APP_PASSCODE is unset)." });
  }
  if (!isAuthenticated(req, env)) {
    return sendJson(res, 401, { error: "Authentication required." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }

  try {
    const store = await getStore(env);
    const result = await handleBulkImport({ store, env, body });
    return sendResult(res, result);
  } catch (error) {
    console.error("bulk-import error:", error?.message || "unknown");
    return sendJson(res, error?.status || 500, { error: "Internal error handling bulk import." });
  }
}
