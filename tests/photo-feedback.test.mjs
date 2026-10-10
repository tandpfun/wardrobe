import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createPhotoFeedbackApi } from "../scripts/photo-feedback-api.mjs";

async function request(api, method, url, input) {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]);
  Object.assign(req, { method, url });
  const res = { statusCode: 200, setHeader() {}, end(value) { this.value = JSON.parse(value); } };
  await api.handle(req, res, () => assert.fail("Unexpected API route"));
  return { status: res.statusCode, ...res.value };
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-feedback-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(path.join(dataDir, "imported"));
  // Only a content digest is needed for feedback; no image model is involved.
  await writeFile(path.join(dataDir, "imported", "test.png"), Buffer.from("isolated-photo-fixture"));
  const image = "/api/import/library/test.png";
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([
    { id: "test-piece", name: "Test piece", image, modeledImages: [{ id: "default", mode: "default", image }, { id: "layer", mode: "layer", image }] },
  ]));
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify({ outfits: [{ id: "test-look", name: "Test look", image }] }));
  const createApi = () => createPhotoFeedbackApi({ root: dataDir, dataDir, editImage: () => assert.fail("No generation allowed") });
  return { dataDir, createApi, api: createApi() };
}

for (const [kind, targetId, mode] of [["item", "test-piece", "default"], ["item", "test-piece", "layer"], ["outfit", "test-look", "default"]]) {
  for (const rating of ["up", "down"]) {
    test(`${kind}/${mode}: ${rating} clears to neutral and remains neutral after API reload`, async (t) => {
      const { api, createApi, dataDir } = await fixture(t);
      const base = `/api/import/photos/${kind}/${targetId}`;
      const initial = await request(api, "GET", base);
      const versionId = initial.photos.find((photo) => photo.mode === mode).versionId;
      const rated = await request(api, "POST", `${base}/feedback`, { versionId, rating, comment: "Saved comment" });
      assert.equal(rated.status, 200);
      assert.equal(rated.photos.find((photo) => photo.mode === mode).feedback.rating, rating);
      const cleared = await request(api, "POST", `${base}/feedback`, { versionId, rating: null });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.photos.find((photo) => photo.mode === mode).feedback, null);
      assert.equal((await request(createApi(), "GET", base)).photos.find((photo) => photo.mode === mode).feedback, null);
      const history = JSON.parse(await readFile(path.join(dataDir, "photo-history", "index.json"), "utf8"));
      const entry = history.targets.find((entry) => entry.kind === kind && entry.mode === mode);
      assert.equal(entry.versions.find((version) => version.id === versionId).feedback, null);
      assert.equal(entry.events.at(-1).rating, null);
      assert.equal(entry.events.at(-1).comment, "");
      assert.equal(entry.events.at(-2).rating, rating, "Historical feedback remains in the audit log");
      const repeat = await request(api, "POST", `${base}/feedback`, { versionId, rating: null });
      assert.equal(repeat.photos.find((photo) => photo.mode === mode).feedback, null);
    });
  }
}

test("invalid clears do not change saved feedback or another photo version", async (t) => {
  const { api } = await fixture(t);
  const base = "/api/import/photos/item/test-piece";
  const initial = await request(api, "GET", base);
  const versionId = initial.photos[0].versionId;
  await request(api, "POST", `${base}/feedback`, { versionId, rating: "up", comment: "Keep me" });
  assert.equal((await request(api, "POST", `${base}/feedback`, { versionId: "missing-version", rating: null })).status, 404);
  assert.equal((await request(api, "POST", `${base}/feedback`, { versionId, rating: "invalid" })).status, 400);
  assert.equal((await request(api, "POST", `${base}/feedback`, { versionId })).status, 400);
  const saved = await request(api, "GET", base);
  assert.equal(saved.photos[0].feedback.rating, "up");
  assert.equal(saved.photos[0].feedback.comment, "Keep me");
  assert.equal(saved.photos[1].feedback, null);
});
