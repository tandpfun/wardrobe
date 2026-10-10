export const MODES = new Set(["layer", "default"]);

// Wearing suitability is independent of the garment's category.
export function normalizeLayering(value = {}, existing = {}) {
  const manual = existing.layeringSource === "manual" && value.layeringSource !== "manual";
  const source = manual ? existing : { ...existing, ...value };
  return {
    canLayer: source.canLayer === true,
    layeringSource: source.layeringSource === "manual" ? "manual" : "ai",
  };
}

export function getExpectedModeledModes(item = {}) {
  return normalizeLayering(item).canLayer ? ["default", "layer"] : ["default"];
}

// Records saved before layering existed default to a single standard look.
export function normalizeWardrobeItem(item = {}) {
  return { ...item, ...normalizeLayering(item) };
}

// Records saved before modeledImages existed have one standard modeledImage.
export function getModeledImages(item = {}) {
  if (item.modeledImages?.length) return [...item.modeledImages];
  return item.modeledImage ? [{ id: "modeled-default", mode: "default", image: item.modeledImage }] : [];
}
