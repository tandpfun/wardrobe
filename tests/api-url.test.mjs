import { describe, expect, it } from "vitest";
import { API_PREFIX, apiUrl, joinApiPath, normalizePrefix } from "../src/api.js";

describe("normalizePrefix", () => {
  it("treats the untouched deploy token as same-origin", () => {
    expect(normalizePrefix("__PORT_4173__")).toBe("");
    expect(normalizePrefix("__PORT_9999__")).toBe("");
  });

  it("uses a rewritten path prefix and strips trailing slashes", () => {
    expect(normalizePrefix("/web/direct-files/xyz/proxy")).toBe("/web/direct-files/xyz/proxy");
    expect(normalizePrefix("/web/direct-files/xyz/proxy/")).toBe("/web/direct-files/xyz/proxy");
    expect(normalizePrefix("/web/direct-files/xyz/proxy///")).toBe("/web/direct-files/xyz/proxy");
  });

  it("supports a full-origin proxy prefix", () => {
    expect(normalizePrefix("https://sites.pplx.app/web/direct-files/xyz")).toBe("https://sites.pplx.app/web/direct-files/xyz");
  });

  it("falls back to same-origin for non-string tokens", () => {
    expect(normalizePrefix(undefined)).toBe("");
    expect(normalizePrefix(null)).toBe("");
  });
});

describe("joinApiPath", () => {
  it("prefixes root-relative API and image paths, preserving query strings", () => {
    const prefix = "/web/direct-files/xyz/proxy";
    expect(joinApiPath(prefix, "/api/import/outfits")).toBe("/web/direct-files/xyz/proxy/api/import/outfits");
    expect(joinApiPath(prefix, "/api/import/outfits/qa-evening-layers.png?v=3")).toBe(
      "/web/direct-files/xyz/proxy/api/import/outfits/qa-evening-layers.png?v=3",
    );
    expect(joinApiPath(prefix, "/api/import/library/g1-garment.png")).toBe(
      "/web/direct-files/xyz/proxy/api/import/library/g1-garment.png",
    );
    expect(joinApiPath(prefix, "/_ipx/x")).toBe("/web/direct-files/xyz/proxy/_ipx/x");
  });

  it("leaves same-origin paths unchanged when the prefix is empty", () => {
    expect(joinApiPath("", "/api/import/outfits/seed.png?v=1")).toBe("/api/import/outfits/seed.png?v=1");
  });

  it("does not touch absolute URLs or data/blob sources (no double-prefixing)", () => {
    const prefix = "/web/direct-files/xyz/proxy";
    // An already-prefixed absolute URL must not be prefixed again.
    expect(joinApiPath(prefix, "https://sites.pplx.app/api/import/outfits/x.png")).toBe(
      "https://sites.pplx.app/api/import/outfits/x.png",
    );
    expect(joinApiPath(prefix, "data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(joinApiPath(prefix, "blob:abc")).toBe("blob:abc");
    expect(joinApiPath(prefix, undefined)).toBe(undefined);
  });
});

describe("apiUrl (build-time token intact in tests => local same-origin)", () => {
  it("resolves to an empty prefix locally", () => {
    expect(API_PREFIX).toBe("");
  });

  it("returns root-relative API and image paths unchanged", () => {
    expect(apiUrl("/api/import/outfits")).toBe("/api/import/outfits");
    expect(apiUrl("/api/import/outfits/seed.png?v=2")).toBe("/api/import/outfits/seed.png?v=2");
    expect(apiUrl("/api/import/library/g1-garment.png")).toBe("/api/import/library/g1-garment.png");
  });

  it("passes through non-path sources", () => {
    expect(apiUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(apiUrl(undefined)).toBe(undefined);
  });
});
