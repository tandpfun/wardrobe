import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { miniMaxEdit } from "../scripts/import-job-api.mjs";

const inputPng = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
}).png().toBuffer();

test("decodes a MiniMax base64 response from data.image_urls", async (t) => {
  const output = Buffer.from("generated image");
  let request;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({ base_resp: { status_code: 0 }, data: { image_urls: [output.toString("base64")] } });
  };

  const result = await miniMaxEdit({
    key: "test-key",
    baseUrl: "https://api.minimax.io/v1",
    model: "image-01",
    prompt: "Create a clean garment image.",
    images: [{ data: inputPng }],
    size: "1024x1024",
    responseFormat: "base64",
    promptOptimizer: true,
    seed: 42,
  });

  assert.deepEqual(result, output);
  assert.equal(request.url, "https://api.minimax.io/v1/image_generation");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.n, 1);
  assert.equal(payload.width, 1024);
  assert.equal(payload.height, 1024);
  assert.equal(payload.seed, 42);
  assert.equal(payload.prompt_optimizer, true);
  assert.equal(payload.subject_reference.length, 1);
  assert.match(payload.subject_reference[0].image_file, /^data:image\/png;base64,/);
});

test("downloads a MiniMax URL response and prioritizes aspect ratio", async (t) => {
  const output = Buffer.from("downloaded image");
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return Response.json({ base_resp: { status_code: 0 }, data: { image_urls: ["https://example.com/generated.png"] } });
    }
    return new Response(output, { status: 200 });
  };

  const result = await miniMaxEdit({
    key: "test-key",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "image-01-live",
    prompt: "Create a modeled look.",
    images: [{ data: inputPng }, { data: inputPng }],
    size: "1536x1024",
    aspectRatio: "3:2",
    responseFormat: "url",
  });

  assert.deepEqual(result, output);
  assert.equal(requests[1].url, "https://example.com/generated.png");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.aspect_ratio, "3:2");
  assert.equal("width" in payload, false);
  assert.equal("height" in payload, false);
  assert.equal(payload.subject_reference.length, 2);
});
