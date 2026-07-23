// Exchange the shared app passcode for an HttpOnly session cookie.
//
// Rate-limited per client IP (best-effort, per warm instance). On success we
// mint a stateless HMAC-signed token and set it as a Secure, HttpOnly,
// SameSite=Lax cookie. The passcode itself is never logged or echoed back.

import {
  authConfigured,
  verifyPasscode,
  createSessionToken,
  serializeSessionCookie,
  signingSecret,
  loginRateLimiter,
  clientIp,
  DEFAULT_SESSION_TTL_SECONDS,
} from "../_lib/auth.mjs";
import { readJsonBody, sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  const env = process.env;
  if ((req.method || "GET").toUpperCase() !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  if (!authConfigured(env)) {
    return sendJson(res, 503, { error: "App access is not configured (APP_PASSCODE is unset)." });
  }

  const ip = clientIp(req);
  const limit = loginRateLimiter.check(ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
    return sendJson(res, 429, { error: "Too many attempts. Please wait and try again." });
  }

  let body;
  try {
    body = await readJsonBody(req, 4096);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }

  const passcode = typeof body.passcode === "string" ? body.passcode : "";
  if (!verifyPasscode(passcode, env)) {
    return sendJson(res, 401, { error: "Incorrect passcode." });
  }

  // Successful login clears the throttle for this IP.
  loginRateLimiter.reset(ip);
  const secret = signingSecret(env);
  const token = createSessionToken(secret, DEFAULT_SESSION_TTL_SECONDS);
  const secure = env.NODE_ENV !== "development";
  res.setHeader("Set-Cookie", serializeSessionCookie(token, { secure }));
  return sendJson(res, 200, { ok: true });
}
