import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildGarmentPrompt, frameTransparentGarment } from "../scripts/import-job-api.mjs";

describe("buildGarmentPrompt", () => {
  it("embeds the garment metadata and chroma key", () => {
    const prompt = buildGarmentPrompt(
      { name: "Ecru Tee", part: "upperbody", color: "#e7e0d2", secondaryColor: "#3f4d6b", tags: ["cotton", "crew"] },
      "#00ff00",
    );
    expect(prompt).toContain("Ecru Tee");
    expect(prompt).toContain("#e7e0d2");
    expect(prompt).toContain("#3f4d6b");
    expect(prompt).toContain("cotton, crew");
    expect(prompt).toContain("#00ff00");
  });

  it("falls back to sensible copy when metadata is sparse", () => {
    const prompt = buildGarmentPrompt({}, "#ff00ff");
    expect(prompt).toContain("clothing item");
    expect(prompt).toContain("#ff00ff");
  });
});

describe("frameTransparentGarment", () => {
  it("centers a garment on a square transparent canvas", async () => {
    // A small opaque block on a transparent field, off-center.
    const source = await sharp({ create: { width: 200, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer(), left: 10, top: 10 }])
      .png()
      .toBuffer();
    const framed = await frameTransparentGarment(source, 256);
    const meta = await sharp(framed).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(meta.hasAlpha).toBe(true);
  });

  it("throws when nothing visible remains", async () => {
    const empty = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expect(frameTransparentGarment(empty, 128)).rejects.toThrow();
  });
});
