// Clear the session cookie. Idempotent; safe to call unauthenticated.

import { clearSessionCookie } from "../_lib/auth.mjs";
import { sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  if ((req.method || "GET").toUpperCase() !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  const secure = process.env.NODE_ENV !== "development";
  res.setHeader("Set-Cookie", clearSessionCookie({ secure }));
  return sendJson(res, 200, { ok: true });
}
