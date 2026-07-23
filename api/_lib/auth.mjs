// Private-access authentication for the single-user deployed app.
//
// Model: one shared app passcode, stored only in the APP_PASSCODE Vercel env
// var (never shipped in the client bundle). A successful passcode check mints a
// stateless HMAC-signed session token that is set as an HttpOnly, Secure,
// SameSite=Lax cookie. Every API request re-verifies that cookie. A CLI/bulk
// import may instead present the passcode directly as a Bearer token.
//
// The signing key (AUTH_SECRET) is independent of the passcode so the passcode
// can be rotated without invalidating the secret, and vice versa. If AUTH_SECRET
// is not set we derive a stable key from the passcode as a fallback.
//
// The token payload contains only an expiry — there is no PII and no secret in
// it. Tokens are verified with a constant-time comparison over the signature.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "wardrobe_session";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

// Constant-time string comparison that never short-circuits on length.
export function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a), "utf8");
  const bufferB = Buffer.from(String(b), "utf8");
  const length = Math.max(bufferA.length, bufferB.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  bufferA.copy(paddedA);
  bufferB.copy(paddedB);
  // Include a length check so different-length inputs still fail.
  return timingSafeEqual(paddedA, paddedB) && bufferA.length === bufferB.length;
}

function signingSecret(env) {
  return env.AUTH_SECRET || (env.APP_PASSCODE ? `derived:${env.APP_PASSCODE}` : "");
}

function sign(payloadB64, secret) {
  return base64url(createHmac("sha256", secret).update(payloadB64).digest());
}

// Create a signed session token valid for `ttlSeconds`.
export function createSessionToken(secret, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS, now = Date.now()) {
  if (!secret) throw new Error("A signing secret is required to create a session");
  const payload = { v: 1, exp: Math.floor(now / 1000) + ttlSeconds, nonce: base64url(randomBytes(6)) };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

// Verify a session token's signature and expiry. Returns the decoded payload or
// null. Never throws on malformed input.
export function verifySessionToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = sign(payloadB64, secret);
  if (!safeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 < now) return null;
  return payload;
}

export function parseCookies(header) {
  const jar = {};
  if (typeof header !== "string") return jar;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

export function serializeSessionCookie(token, { maxAge = DEFAULT_SESSION_TTL_SECONDS, secure = true } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie({ secure = true } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

// Whether app auth is configured at all. When no passcode is set we treat the
// deployment as misconfigured and deny access (fail closed) rather than open.
export function authConfigured(env = process.env) {
  return Boolean(env.APP_PASSCODE && env.APP_PASSCODE.trim());
}

// Verify a raw passcode attempt against the configured passcode.
export function verifyPasscode(input, env = process.env) {
  if (!authConfigured(env)) return false;
  if (typeof input !== "string" || !input) return false;
  return safeEqual(input, env.APP_PASSCODE);
}

// Determine whether an incoming request is authenticated, via either the
// session cookie or an `Authorization: Bearer <passcode>` header (for CLI use).
export function isAuthenticated(req, env = process.env) {
  if (!authConfigured(env)) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (verifyPasscode(auth.slice(7).trim(), env)) return true;
  }
  const cookies = parseCookies(req.headers?.cookie);
  const token = cookies[SESSION_COOKIE];
  return Boolean(verifySessionToken(signingSecret(env), token));
}

export { signingSecret };

// In-memory, per-instance sliding-window rate limiter. Serverless instances are
// ephemeral and not shared, so this is best-effort throttling of brute-force
// passcode guessing within a single warm instance rather than a global guard.
// Documented as such in the handoff; a durable limiter would need external
// state (KV/Redis).
export class RateLimiter {
  constructor({ max = 5, windowMs = 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  // Returns { allowed, remaining, retryAfterMs }.
  check(key, now = Date.now()) {
    const bucket = (this.hits.get(key) || []).filter((time) => now - time < this.windowMs);
    if (bucket.length >= this.max) {
      const retryAfterMs = this.windowMs - (now - bucket[0]);
      this.hits.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    bucket.push(now);
    this.hits.set(key, bucket);
    return { allowed: true, remaining: this.max - bucket.length, retryAfterMs: 0 };
  }

  reset(key) {
    this.hits.delete(key);
  }
}

// Shared limiter instance for login attempts (per warm serverless instance).
export const loginRateLimiter = new RateLimiter({ max: 8, windowMs: 60_000 });

export function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
