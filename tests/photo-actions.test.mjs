import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import { transformWithEsbuild } from "vite";

const file = new URL("../src/PhotoActions.jsx", import.meta.url);
const { code } = await transformWithEsbuild(await readFile(file, "utf8"), file.pathname, {
  loader: "jsx", jsx: "transform", jsxFactory: "React.createElement", format: "cjs",
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (photos, error) => ({ ok: !error, json: async () => error ? { error } : { photos } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const photo = (rating = "up", versionId = "v1") => ({ versionId, mode: "default", feedback: rating ? { rating, comment: "Existing note" } : null });

// Drive the real components/hooks with persistent hook slots and controlled
// network responses. No DOM, app server, user records, or image generation.
function harness(fetch = () => assert.fail("Unexpected network request")) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    ...React,
    useState(initial) {
      const i = cursor++;
      slots[i] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === "function" ? value(slots[i].value) : value; }];
    },
    useRef(value) { const i = cursor++; slots[i] ||= { current: value }; return slots[i]; },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useId() { return `id-${cursor++}`; },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, React, fetch, AbortController, setInterval, clearInterval,
    require: (name) => name === "react" ? hooks : name === "./photo-actions.css" ? {} : new Proxy({}, { get: () => () => null }),
  });
  return {
    ...module.exports,
    render(fn, ...args) { cursor = 0; effects = []; const result = fn(...args); for (const effect of effects) effect(); return result; },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const thumb = (tree, rating) => find(tree, (node) => node.type === "button" && node.props["aria-label"] === (rating === "up" ? "Like this photo" : "Dislike this photo"));
const dialog = (tree) => find(tree, (node) => typeof node.type === "function" && node.type.name === "PhotoDialog");

for (const rating of ["up", "down"]) {
  test(`${rating}: clicking the selected thumb clears without a dialog and suppresses rapid duplicates`, async () => {
    const h = harness();
    const pending = deferred();
    const calls = [];
    const collection = { loading: false, pending: false, act: async (action, body) => { calls.push({ action, body }); return pending.promise; } };
    let props = { collection, photo: photo(rating) };
    const tree = h.render(h.PhotoActions, props);
    const first = thumb(tree, rating).props.onClick();
    await thumb(tree, rating).props.onClick();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { action: "feedback", body: { versionId: "v1", rating: null, comment: "" } });
    assert.equal(dialog(h.render(h.PhotoActions, props)), null);
    pending.resolve(true);
    await first;
    props = { ...props, photo: photo(null) };
    const neutral = h.render(h.PhotoActions, props);
    assert.equal(thumb(neutral, rating).props["aria-pressed"], false);
    assert.ok(find(neutral, (node) => node.props.role === "status" && node.props.children === "Feedback removed for this photo."));
    h.close();
  });
}

test("initial ratings and switching direction preserve the comment dialog flow", async () => {
  for (const [saved, clicked] of [[null, "up"], [null, "down"], ["up", "down"], ["down", "up"]]) {
    const h = harness();
    const calls = [];
    const props = { photo: photo(saved), collection: { loading: false, pending: false, act: async (action, body) => { calls.push({ action, body }); return true; } } };
    await thumb(h.render(h.PhotoActions, props), clicked).props.onClick();
    const tree = h.render(h.PhotoActions, props);
    assert.ok(dialog(tree));
    assert.equal(calls.length, 0);
    await find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.equal(calls[0].body.rating, clicked);
    assert.equal(calls[0].body.comment, saved ? "Existing note" : "");
    h.close();
  }
});

test("failed clearing leaves the rating selected and reports the collection error", async () => {
  const h = harness();
  const props = { photo: photo("up"), collection: { loading: false, pending: false, act: async () => false, error: "Save failed" } };
  await thumb(h.render(h.PhotoActions, props), "up").props.onClick();
  const tree = h.render(h.PhotoActions, props);
  assert.equal(thumb(tree, "up").props["aria-pressed"], true);
  assert.equal(dialog(tree), null);
  assert.ok(find(tree, (node) => node.props.role === "alert"));
  assert.equal(find(tree, (node) => node.props.children === "Feedback removed for this photo."), null);
  h.close();
});

test("busy or unavailable controls cannot clear or open a dialog", async () => {
  for (const options of [{ pending: true }, { loading: true }]) {
    const h = harness();
    const props = { photo: photo("up"), collection: { loading: false, pending: false, act: () => assert.fail("No mutation allowed"), ...options } };
    await thumb(h.render(h.PhotoActions, props), "up").props.onClick();
    assert.equal(dialog(h.render(h.PhotoActions, props)), null);
    h.close();
  }
});

test("collection rejects duplicate mutations and ignores stale refresh responses", async () => {
  const stale = deferred();
  const mutation = deferred();
  let gets = 0;
  let posts = 0;
  const h = harness((_url, options) => {
    if (options.method === "POST") { posts += 1; return mutation.promise; }
    gets += 1;
    return gets === 1 ? Promise.resolve(response([photo("up")])) : stale.promise;
  });
  h.render(h.usePhotoCollection, "item", "a");
  await settle();
  let state = h.render(h.usePhotoCollection, "item", "a");
  const refresh = state.refresh();
  const clearing = state.act("feedback", { rating: null });
  assert.equal(await state.act("feedback", { rating: null }), false);
  assert.equal(posts, 1);
  mutation.resolve(response([photo(null)]));
  assert.equal(await clearing, true);
  stale.resolve(response([photo("up")]));
  await refresh;
  state = h.render(h.usePhotoCollection, "item", "a");
  assert.equal(state.photos[0].feedback, null);
  assert.equal(state.pending, false);
  h.close();
});

test("mutation failures retain persisted feedback and release the pending guard", async () => {
  const h = harness((_url, options) => Promise.resolve(options.method === "POST" ? response([], "Save failed") : response([photo("down")])));
  h.render(h.usePhotoCollection, "item", "a");
  await settle();
  let state = h.render(h.usePhotoCollection, "item", "a");
  assert.equal(await state.act("feedback", { rating: null }), false);
  state = h.render(h.usePhotoCollection, "item", "a");
  assert.equal(state.photos[0].feedback.rating, "down");
  assert.equal(state.error, "Save failed");
  assert.equal(state.pending, false);
  h.close();
});

test("responses from the previous target cannot overwrite or unlock a newer mutation", async () => {
  const old = deferred();
  const current = deferred();
  const h = harness((url, options) => options.method === "POST" ? (url.includes("/a/") ? old.promise : current.promise) : Promise.resolve(response([photo("up", url.endsWith("/a") ? "a1" : "b1")])));
  h.render(h.usePhotoCollection, "item", "a");
  await settle();
  const oldAction = h.render(h.usePhotoCollection, "item", "a").act("feedback", { rating: null });
  h.render(h.usePhotoCollection, "item", "b");
  await settle();
  const currentAction = h.render(h.usePhotoCollection, "item", "b").act("feedback", { rating: null });
  old.resolve(response([photo(null, "a1")]));
  assert.equal(await oldAction, false);
  let state = h.render(h.usePhotoCollection, "item", "b");
  assert.equal(state.photos[0].versionId, "b1");
  assert.equal(state.pending, true);
  assert.equal(await state.act("feedback", { rating: "down" }), false);
  current.resolve(response([photo(null, "b1")]));
  assert.equal(await currentAction, true);
  state = h.render(h.usePhotoCollection, "item", "b");
  assert.equal(state.photos[0].feedback, null);
  assert.equal(state.pending, false);
  h.close();
});
