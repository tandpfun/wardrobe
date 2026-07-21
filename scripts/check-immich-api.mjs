import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { immichApi } from "./immich-api.mjs";

const assetId = "11111111-1111-4111-8111-111111111111";
const oversizedId = "22222222-2222-4222-8222-222222222222";
const secret = "test-only-immich-key";
const fixture = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#884422" } }).jpeg().toBuffer();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const fakeImmich = createServer(async (req, res) => {
  assert.equal(req.headers["x-api-key"], secret);
  if (req.url === "/api/server/ping") {
    res.setHeader("content-type", "application/json");
    return res.end('{"res":"pong"}');
  }
  if (req.url === "/api/search/smart" || req.url === "/api/search/metadata") {
    for await (const _chunk of req) { /* consume request */ }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ assets: { items: [{ id: assetId, type: "IMAGE", originalFileName: "fixture.jpg", fileCreatedAt: "2025-01-02T03:04:05.000Z", width: 2000, height: 1000 }], nextPage: null } }));
  }
  if (req.url === `/api/assets/${oversizedId}/original`) {
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("content-length", String(65 * 1024 * 1024));
    return res.end();
  }
  if (req.url === `/api/assets/${assetId}/thumbnail?size=thumbnail` || req.url === `/api/assets/${assetId}/original`) {
    res.setHeader("content-type", "image/jpeg");
    return res.end(fixture);
  }
  res.statusCode = 404;
  res.end();
});

const directory = await mkdtemp(path.join(tmpdir(), "wardrobe-immich-test-"));
const keyFile = path.join(directory, "api-key");
const referenceFile = path.join(directory, "model-reference.png");
await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });

let app;
try {
  const immichPort = await listen(fakeImmich);
  let middleware;
  const plugin = immichApi({ env: {
    IMMICH_BASE_URL: `http://127.0.0.1:${immichPort}`,
    IMMICH_API_KEY_FILE: keyFile,
    IMMICH_YEARS: "4",
    WARDROBE_MODEL_REFERENCE: referenceFile,
  } });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  app = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  const appPort = await listen(app);
  const base = `http://127.0.0.1:${appPort}`;

  const config = await fetch(`${base}/api/immich/config`).then((response) => response.json());
  assert.deepEqual(config, { ready: true, years: 4, ping: "pong" });

  const catalog = await fetch(`${base}/api/immich/assets?query=outfit&size=5`).then((response) => response.json());
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].id, assetId);
  assert.equal(catalog.items[0].thumbnailUrl, `/api/immich/assets/${assetId}/thumbnail`);
  assert.equal(JSON.stringify(catalog).includes(secret), false);

  const thumbnail = await fetch(`${base}${catalog.items[0].thumbnailUrl}`);
  assert.equal(thumbnail.status, 200);
  assert.match(thumbnail.headers.get("content-type"), /^image\//);

  const oversized = await fetch(`${base}/api/immich/assets/${oversizedId}/original`);
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, "Immich image is too large");

  const saved = await fetch(`${base}/api/immich/reference`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetId }),
  }).then((response) => response.json());
  assert.equal(saved.saved, true);
  const metadata = await sharp(await readFile(referenceFile)).metadata();
  assert.ok(metadata.width <= 1536 && metadata.height <= 1536);
  assert.equal((await stat(referenceFile)).mode & 0o777, 0o600);

  console.log("immich_api_contract=ok");
} finally {
  if (app?.listening) await close(app);
  if (fakeImmich.listening) await close(fakeImmich);
  await rm(directory, { recursive: true, force: true });
}
