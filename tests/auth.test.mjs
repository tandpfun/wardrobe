import { describe, expect, it } from "vitest";
import {
  safeEqual,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookie,
  authConfigured,
  verifyPasscode,
  isAuthenticated,
  signingSecret,
  RateLimiter,
  clientIp,
  SESSION_COOKIE,
} from "../api/_lib/auth.mjs";

describe("safeEqual", () => {
  it("returns true only for identical strings", () => {
    expect(safeEqual("hunter2", "hunter2")).toBe(true);
    expect(safeEqual("hunter2", "hunter3")).toBe(false);
  });

  it("fails on differing lengths without throwing", () => {
    expect(safeEqual("short", "a much longer value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("session tokens", () => {
  const secret = "test-secret";

  it("mints a token that verifies with the same secret", () => {
    const token = createSessionToken(secret, 3600);
    const payload = verifySessionToken(secret, token);
    expect(payload).toBeTruthy();
    expect(payload.v).toBe(1);
    expect(typeof payload.exp).toBe("number");
  });

  it("rejects tokens signed with a different secret", () => {
    const token = createSessionToken(secret, 3600);
    expect(verifySessionToken("other-secret", token)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const now = Date.now();
    const token = createSessionToken(secret, 10, now);
    expect(verifySessionToken(secret, token, now + 11_000)).toBeNull();
  });

  it("rejects tampered payloads and malformed input", () => {
    const token = createSessionToken(secret, 3600);
    const [payload, sig] = token.split(".");
    const tampered = `${payload}x.${sig}`;
    expect(verifySessionToken(secret, tampered)).toBeNull();
    expect(verifySessionToken(secret, "not-a-token")).toBeNull();
    expect(verifySessionToken(secret, "")).toBeNull();
    expect(verifySessionToken(secret, null)).toBeNull();
    expect(verifySessionToken("", token)).toBeNull();
  });

  it("throws when creating a token without a secret", () => {
    expect(() => createSessionToken("", 3600)).toThrow();
  });
});

describe("cookies", () => {
  it("round-trips through serialize/parse", () => {
    const cookie = serializeSessionCookie("abc.def", { secure: true });
    expect(cookie).toContain(`${SESSION_COOKIE}=abc.def`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const jar = parseCookies(`${SESSION_COOKIE}=abc.def; other=1`);
    expect(jar[SESSION_COOKIE]).toBe("abc.def");
    expect(jar.other).toBe("1");
  });

  it("omits Secure when disabled and clears with Max-Age=0", () => {
    expect(serializeSessionCookie("t", { secure: false })).not.toContain("Secure");
    expect(clearSessionCookie({ secure: false })).toContain("Max-Age=0");
  });

  it("handles empty / non-string cookie headers", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("novalue")).toEqual({});
  });
});

describe("passcode + configuration", () => {
  it("treats a deployment with no passcode as unconfigured (fail closed)", () => {
    expect(authConfigured({})).toBe(false);
    expect(authConfigured({ APP_PASSCODE: "   " })).toBe(false);
    expect(verifyPasscode("anything", {})).toBe(false);
  });

  it("verifies the configured passcode", () => {
    const env = { APP_PASSCODE: "letmein" };
    expect(authConfigured(env)).toBe(true);
    expect(verifyPasscode("letmein", env)).toBe(true);
    expect(verifyPasscode("nope", env)).toBe(false);
    expect(verifyPasscode(123, env)).toBe(false);
  });

  it("derives a signing secret from the passcode when AUTH_SECRET is unset", () => {
    expect(signingSecret({ APP_PASSCODE: "pw" })).toBe("derived:pw");
    expect(signingSecret({ AUTH_SECRET: "s", APP_PASSCODE: "pw" })).toBe("s");
    expect(signingSecret({})).toBe("");
  });
});

describe("isAuthenticated", () => {
  const env = { APP_PASSCODE: "letmein", AUTH_SECRET: "sekret" };

  it("accepts a valid Bearer passcode", () => {
    const req = { headers: { authorization: "Bearer letmein" } };
    expect(isAuthenticated(req, env)).toBe(true);
  });

  it("rejects a wrong Bearer passcode", () => {
    const req = { headers: { authorization: "Bearer wrong" } };
    expect(isAuthenticated(req, env)).toBe(false);
  });

  it("accepts a valid session cookie", () => {
    const token = createSessionToken(signingSecret(env), 3600);
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } };
    expect(isAuthenticated(req, env)).toBe(true);
  });

  it("rejects when no credentials are present", () => {
    expect(isAuthenticated({ headers: {} }, env)).toBe(false);
  });

  it("fails closed when auth is not configured", () => {
    const token = createSessionToken("derived:letmein", 3600);
    const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
    expect(isAuthenticated(req, {})).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to max within the window, then blocks", () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    const now = 1_000_000;
    expect(limiter.check("ip", now).allowed).toBe(true);
    expect(limiter.check("ip", now).allowed).toBe(true);
    expect(limiter.check("ip", now).allowed).toBe(true);
    const blocked = limiter.check("ip", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("recovers after the window elapses", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    const now = 2_000_000;
    expect(limiter.check("ip", now).allowed).toBe(true);
    expect(limiter.check("ip", now).allowed).toBe(false);
    expect(limiter.check("ip", now + 1001).allowed).toBe(true);
  });

  it("tracks buckets per key and supports reset", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    const now = 3_000_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("b", now).allowed).toBe(true);
    limiter.reset("a");
    expect(limiter.check("a", now).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    expect(clientIp({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })).toBe("1.1.1.1");
  });
  it("falls back to the socket address", () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: "9.9.9.9" } })).toBe("9.9.9.9");
  });
  it("returns 'unknown' when nothing is available", () => {
    expect(clientIp({ headers: {} })).toBe("unknown");
  });
});
