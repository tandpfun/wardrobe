import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import * as wardrobeModel from "../src/wardrobe-model.js";

// Compile the real shared component without starting the app or its data APIs.
const filename = new URL("../src/LayeringControls.jsx", import.meta.url);
const { code } = await transformWithEsbuild(await readFile(filename, "utf8"), filename.pathname, {
  loader: "jsx",
  jsx: "transform",
  jsxFactory: "React.createElement",
  format: "cjs",
});
const componentModule = { exports: {} };
runInNewContext(code, { module: componentModule, exports: componentModule.exports, React });
const { LayeringControls } = componentModule.exports;

const texts = [
  "Ways to wear",
  "Can wear as a layer",
  "Layer over a T-shirt or hoodie.",
];
const render = (value, props = {}) => renderToStaticMarkup(React.createElement(LayeringControls, {
  value,
  onChange: () => assert.fail("Rendering must not change saved layering choices"),
  ...props,
}));

for (const part of ["accessories_up", "lowerbody", "shoes"]) {
  for (const canLayer of [false, true]) {
    test(`${part}: hides the entire section with canLayer=${canLayer}`, () => {
      assert.equal(render({ part, canLayer, layeringSource: "manual" }), "");
    });
  }
}

for (const part of ["upperbody", "wholebody_up"]) {
  for (const canLayer of [false, true]) {
    test(`${part}: retains the section and checked state with canLayer=${canLayer}`, () => {
      const markup = render({ part, canLayer });
      for (const text of texts) assert.ok(markup.includes(text));
      assert.equal(markup.includes('checked=""'), canLayer);
      assert.ok(markup.includes('type="checkbox"'));
    });
  }

  test(`${part}: preserves checkbox updates and other draft fields`, () => {
    const value = { part, name: "Test piece", canLayer: false, layeringSource: "ai" };
    let next;
    const fieldset = LayeringControls({ value, onChange: (updated) => { next = updated; } });
    const checkbox = fieldset.props.children[1].props.children[0].props.children[0];
    checkbox.props.onChange({ target: { checked: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(next)), { ...value, canLayer: true, layeringSource: "manual" });
    assert.equal(value.canLayer, false);
  });
}

test("category changes hide and restore controls without losing the layering choice", () => {
  const draft = { part: "upperbody", canLayer: true, layeringSource: "manual" };
  for (const part of ["upperbody", "accessories_up", "wholebody_up", "lowerbody", "shoes", "upperbody"]) {
    const markup = render({ ...draft, part });
    const visible = part === "upperbody" || part === "wholebody_up";
    for (const text of texts) assert.equal(markup.includes(text), visible);
    if (visible) assert.ok(markup.includes('checked=""'));
  }
  assert.deepEqual(draft, { part: "upperbody", canLayer: true, layeringSource: "manual" });
});

test("busy editors retain disabled layering controls for applicable categories", () => {
  assert.ok(render({ part: "upperbody", canLayer: false }, { disabled: true }).includes('disabled=""'));
  assert.equal(render({ part: "shoes", canLayer: true }, { disabled: true }), "");
});

test("the layer action is beside the toggle, outside its label, with no duplicate", () => {
  const action = React.createElement("button", { type: "button" }, "Create layer look");
  const fieldset = LayeringControls({ value: { part: "upperbody", canLayer: true }, onChange: () => {}, action });
  const row = fieldset.props.children[1];
  assert.equal(row.props.className, "layering-row");
  assert.equal(row.props.children[0].type, "label");
  assert.equal(row.props.children[1], action);
  const markup = render({ part: "upperbody", canLayer: true }, { action });
  assert.equal(markup.split("Create layer look").length - 1, 1);
  assert.ok(!markup.includes("Add a thoughtfully styled look over a compatible inner piece."));
});

test("editors without a generation action do not gain a button", () => {
  assert.ok(!render({ part: "wholebody_up", canLayer: true }).includes("<button"));
});

test("hidden categories also hide the layer action and notice", () => {
  const action = React.createElement("button", { type: "button" }, "Create layer look");
  for (const part of ["accessories_up", "lowerbody", "shoes"]) {
    assert.equal(render({ part, canLayer: true }, { action, notice: "Save your changes first." }), "");
  }
});

test("the row preserves the action's disabled, loading, and unsaved states", () => {
  let calls = 0;
  const action = React.createElement("button", { type: "button", disabled: true, onClick: () => { calls += 1; } }, "Preparing looks…");
  const markup = render({ part: "upperbody", canLayer: true }, { action, notice: "Save your changes first." });
  assert.ok(markup.includes('<button type="button" disabled="">Preparing looks…</button>'));
  assert.ok(markup.includes('<p role="status">Save your changes first.</p>'));
  assert.equal(calls, 0, "Rendering must never start generation");
});

// Render the actual viewer with inert photo/import integrations. Effects never
// run during server rendering, so these tests cannot access data or generate.
const appFile = new URL("../src/App.jsx", import.meta.url);
const appCode = await transformWithEsbuild(`${await readFile(appFile, "utf8")}\nexport { ItemViewer };`, appFile.pathname, {
  loader: "jsx", jsx: "transform", jsxFactory: "React.createElement", format: "cjs",
});
const viewerModule = { exports: {} };
const emptyComponent = () => null;
const integrations = {
  react: React,
  "@phosphor-icons/react": { Check: emptyComponent, Plus: emptyComponent, Trash: emptyComponent, X: emptyComponent },
  "./import-flow.jsx": { WardrobeImportFlow: emptyComponent },
  "./OptimizedImage.jsx": { OptimizedImage: emptyComponent },
  "./ModeledCarousel.jsx": { ModeledCarousel: emptyComponent },
  "./LayeringControls.jsx": { LayeringControls },
  "./PhotoActions.jsx": { PhotoActions: emptyComponent, usePhotoCollection: () => ({ photos: [] }) },
  "./OutfitGallery.jsx": { OutfitGallery: emptyComponent },
  "./wardrobe-model.js": wardrobeModel,
};
runInNewContext(appCode.code, {
  module: viewerModule, exports: viewerModule.exports, React,
  require: (id) => {
    assert.ok(id in integrations, `Unexpected integration: ${id}`);
    return integrations[id];
  },
});
const renderViewer = (overrides) => renderToStaticMarkup(React.createElement(viewerModule.exports.ItemViewer, {
  item: { id: "test-item", name: "Test piece", part: "upperbody", color: "#123456", tags: [], canLayer: true, modeledImage: "/test-default.png", ...overrides },
  onCreateModeled: () => assert.fail("Tests must never trigger generation"),
}));

for (const part of ["upperbody", "wholebody_up"]) {
  test(`${part}: viewer shows one layer CTA in Ways to wear and removes the old placement`, () => {
    const markup = renderViewer({ part });
    assert.equal(markup.split("Create layer look").length - 1, 1);
    assert.match(markup, /class="layering-row"[\s\S]*Can wear as a layer[\s\S]*<button[^>]*>Create layer look<\/button><\/div>/);
    assert.ok(!markup.includes('class="create-modeled-look"'));
    assert.ok(!markup.includes("Add a thoughtfully styled look over a compatible inner piece."));
  });
}

test("viewer preserves eligibility for complete and non-layerable pieces", () => {
  const completed = renderViewer({ modeledImages: [{ id: "default", mode: "default", image: "/default.png" }, { id: "layer", mode: "layer", image: "/layer.png" }] });
  assert.ok(!completed.includes("Create layer look"));
  assert.ok(!renderViewer({ canLayer: false }).includes("Create layer look"));
  for (const part of ["accessories_up", "lowerbody", "shoes"]) {
    const markup = renderViewer({ part });
    assert.ok(!markup.includes("Create layer look"));
    assert.ok(!markup.includes("Ways to wear"));
  }
});

test("pieces without a normal photo retain the existing Create modeled looks action", () => {
  for (const canLayer of [false, true]) {
    const markup = renderViewer({ canLayer, modeledImage: null });
    assert.equal(markup.split("Create modeled looks").length - 1, 1);
    assert.ok(markup.includes('class="create-modeled-look"'));
    assert.ok(!markup.includes("Create layer look"));
  }
});
