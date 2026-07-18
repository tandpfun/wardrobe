import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Check, CoatHanger, Plus, Trash, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";

const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
  { id: "outfits", label: "Outfits" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));


function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary color"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary color"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("Changes saved.");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("That spot is transparent—try directly on the garment.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <div className="modeled-hero">
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`${draft.name || type} worn by a model`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> Save
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

const OUTFIT_SLOTS = {
  // tops: alternate left/right across the top of the card
  upperbody: [
    { top: "4%", left: "5%", maxH: "56%", maxW: "44%", rot: -5 },
    { top: "4%", right: "5%", maxH: "56%", maxW: "44%", rot: 5 },
  ],
  wholebody_up: [
    { top: "4%", left: "5%", maxH: "56%", maxW: "44%", rot: -5 },
    { top: "4%", right: "5%", maxH: "56%", maxW: "44%", rot: 5 },
  ],
  // bottoms: alternate right/left across the bottom (taller, keep natural proportion)
  lowerbody: [
    { bottom: "3%", right: "5%", maxH: "58%", maxW: "44%", rot: 5 },
    { bottom: "3%", left: "5%", maxH: "58%", maxW: "44%", rot: -5 },
  ],
  // shoes: bottom-left, smaller
  shoes: [
    { bottom: "6%", left: "10%", maxH: "26%", maxW: "34%", rot: -3 },
    { bottom: "6%", right: "10%", maxH: "26%", maxW: "34%", rot: 3 },
  ],
  // accessories: top-right, smaller
  accessories_up: [
    { top: "6%", right: "7%", maxH: "30%", maxW: "32%", rot: 6 },
    { top: "6%", left: "7%", maxH: "30%", maxW: "32%", rot: -6 },
  ],
};

function slotForGarment(part, indexAmongPart) {
  const slots = OUTFIT_SLOTS[part] || OUTFIT_SLOTS.upperbody;
  return slots[indexAmongPart % slots.length];
}

// When more pieces of a part exist than predefined slots (3+ tops, etc.),
// apply a deterministic pseudo-random jitter on top of the base slot so the
// overflow pieces don't land on exactly the same spot as piece 0/1.
// Same outfit+garment → same jitter every render (no flicker on re-render).
function jitteredSlot(part, indexAmongPart, outfitId, garmentId) {
  const base = slotForGarment(part, indexAmongPart);
  const slots = OUTFIT_SLOTS[part] || OUTFIT_SLOTS.upperbody;
  // Only jitter when we're past the predefined slot count.
  if (indexAmongPart < slots.length) return base;

  const r1 = hash01(`${outfitId}:${garmentId}:jx`);
  const r2 = hash01(`${outfitId}:${garmentId}:jy`);
  const r3 = hash01(`${outfitId}:${garmentId}:jr`);

  const clone = { ...base };
  // Shift ±3%..±8% horizontally, ±2.5%..±5% vertically, ±3°..±6° rotation.
  const dx = (r1 - 0.5) * 16; // -8..+8
  const dy = (r2 - 0.5) * 10; // -5..+5
  const dr = (r3 - 0.5) * 12; // -6..+6 deg

  if (clone.top != null) clone.top = `${parseFloat(clone.top) + dy}%`;
  if (clone.bottom != null) clone.bottom = `${parseFloat(clone.bottom) - dy}%`;
  if (clone.left != null) clone.left = `${parseFloat(clone.left) + dx}%`;
  if (clone.right != null) clone.right = `${parseFloat(clone.right) - dx}%`;
  clone.rot = (clone.rot || 0) + dr;
  // Make overflow pieces slightly smaller so they read as "secondary".
  clone.maxH = `${parseFloat(clone.maxH) * 0.8}%`;
  clone.maxW = `${parseFloat(clone.maxW) * 0.8}%`;
  return clone;
}

// Deterministic hash → [0,1). Used to scatter garment pieces in the viewer
// with a stable flat-lay feel (same outfit → same scatter every open).
function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

// Returns { xPct, rotDeg, yPct } for piece at `index` in outfit `outfitId`.
// Outward tilt + zig-zag drift + small overlap → loose flat-lay that
// "opens outward" (top leans left, bottom leans right, etc.) instead of
// collapsing toward center.
function pieceScatter(outfitId, garmentId, index) {
  const r1 = hash01(`${outfitId}:${garmentId}:x`);
  const r2 = hash01(`${outfitId}:${garmentId}:r`);
  const r3 = hash01(`${outfitId}:${garmentId}:y`);
  const side = index % 2 === 0 ? 1 : -1; // even → right, odd → left
  const xPct = side * (8 + r1 * 7);      // ±8%..±15%
  // Outward rotation: even (right side) tilts clockwise (+), odd (left side) tilts CCW (−).
  // Mirror the x sign so each piece leans AWAY from the centerline.
  const rotDeg = side * (3 + r2 * 4);    // ±3°..±7°, tilting outward
  const yPct = index === 0 ? 0 : -(4 + r3 * 6); // subsequent pieces overlap upward 4%..10%
  return { xPct, rotDeg, yPct };
}

function OutfitGalleryItem({ outfit, onOpen }) {
  const garments = outfit.garments || [];
  const partCounts = {};

  return (
    <button
      className="outfit-gallery-item"
      type="button"
      onClick={() => onOpen(outfit.id)}
      aria-label={`View outfit ${outfit.name}`}
    >
      {outfit.status === "ready" && outfit.image ? (
        <>
          <img className="outfit-photo" src={outfit.image} alt={outfit.name} />
          {garments.length > 0 && (
            <div className="outfit-garments-overlay">
              {garments.map((garment) => {
                const part = garment.part || "upperbody";
                const idx = (partCounts[part] = (partCounts[part] || 0) + 1) - 1;
                const slot = jitteredSlot(part, idx, outfit.id, garment.id);
                const style = {
                  "--rot": `${slot.rot}deg`,
                  maxHeight: slot.maxH,
                  maxWidth: slot.maxW,
                };
                if (slot.top != null) style.top = slot.top;
                if (slot.bottom != null) style.bottom = slot.bottom;
                if (slot.left != null) style.left = slot.left;
                if (slot.right != null) style.right = slot.right;
                return (
                  <img
                    key={garment.id}
                    className="outfit-garment-cutout"
                    src={garment.thumbnail || garment.image}
                    alt=""
                    style={style}
                  />
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="outfit-placeholder">
          {outfit.status === "generating" ? (
            <>
              <div className="outfit-spinner" />
              <span>Generating</span>
            </>
          ) : outfit.status === "failed" ? (
            <span className="outfit-error-icon">Failed</span>
          ) : outfit.status === "stalled" ? (
            <span className="outfit-error-icon">Interrupted</span>
          ) : (
            <CoatHanger size={32} weight="light" aria-hidden="true" />
          )}
        </div>
      )}
    </button>
  );
}

function OutfitViewer({ outfit, lookNumber, onClose, onDelete, onRegenerate }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose]);

  const garments = outfit.garments || [];
  const lookLabel = Number.isInteger(lookNumber) && lookNumber > 0
    ? `LOOK ${String(lookNumber).padStart(2, "0")}`
    : null;

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-viewer" role="dialog" aria-modal="true" aria-label={`Outfit ${outfit.name}`}>
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close viewer" ref={closeButtonRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          {lookLabel && <div className="outfit-look-number">{lookLabel}</div>}

          <div className="outfit-viewer-pieces">
            {garments.length > 0 ? (
              garments.map((garment, idx) => {
                const { xPct, rotDeg, yPct } = pieceScatter(outfit.id, garment.id, idx);
                return (
                  <div
                    className="outfit-viewer-piece"
                    key={garment.id}
                    style={{
                      "--piece-x": `${xPct}%`,
                      "--piece-rot": `${rotDeg}deg`,
                      "--piece-y": `${yPct}%`,
                    }}
                  >
                    <OptimizedImage
                      src={garment.thumbnail || garment.image}
                      alt={garment.name}
                      sizes="(max-width: 860px) 100vw, 440px"
                      breakpoints={[200, 320, 440, 560]}
                      quality={88}
                    />
                  </div>
                );
              })
            ) : (
              <div className="outfit-placeholder large">
                <CoatHanger size={48} weight="light" aria-hidden="true" />
              </div>
            )}
          </div>

          <div className="viewer-details outfit-viewer-details">
            <div className="outfit-viewer-meta">
              <h2 className="outfit-viewer-name">{outfit.name}</h2>
              {outfit.description && <p className="outfit-viewer-description">{outfit.description}</p>}
              {Array.isArray(outfit.tags) && outfit.tags.length > 0 && (
                <div className="outfit-viewer-tags">
                  {outfit.tags.map((tag) => (
                    <span className="outfit-viewer-tag" key={tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="viewer-actions outfit-viewer-actions">
              <button className="viewer-quiet-button" type="button" onClick={() => onDelete(outfit.id)} aria-label="Delete outfit">
                <Trash size={15} weight="regular" aria-hidden="true" />
              </button>
              {outfit.status === "ready" && (
                <button className="viewer-quiet-button" type="button" onClick={() => onRegenerate(outfit.id)} aria-label="Regenerate outfit">
                  <ArrowsClockwise size={15} weight="regular" aria-hidden="true" />
                </button>
              )}
              {outfit.status === "failed" && (
                <button className="secondary-button" type="button" onClick={() => onRegenerate(outfit.id)}>
                  <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> Retry
                </button>
              )}
              {outfit.status === "stalled" && (
                <button className="secondary-button" type="button" onClick={() => onRegenerate(outfit.id)}>
                  <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> Retry
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OutfitCreator({ items, onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);

  const toggle = (id) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((s) => s !== id)
        : current.length >= 6
          ? current
          : [...current, id]
    );
  };

  const canCreate = selected.length >= 2;

  const handleSubmit = () => {
    if (!canCreate) return;
    onCreate({ name: name.trim() || "New Outfit", garmentIds: selected });
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-creator" role="dialog" aria-modal="true" aria-label="Create outfit">
          <button className="viewer-icon-close" type="button" onClick={onCancel} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          <div className="viewer-heading">
            <div>
              <h2>Create Outfit</h2>
            </div>
          </div>

          <div className="viewer-details">
            <label className="field">
              <span>Outfit name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Weekend Casual"
                onKeyDown={(event) => event.key === "Enter" && canCreate && handleSubmit()}
              />
            </label>

            <div className="outfit-creator-info">
              <span>Selected: {selected.length}/6</span>
              <small>Pick 2-6 pieces to compose a look</small>
            </div>

            <div className="outfit-creator-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`outfit-creator-item${selected.includes(item.id) ? " selected" : ""}`}
                  onClick={() => toggle(item.id)}
                  aria-pressed={selected.includes(item.id)}
                >
                  <OptimizedImage
                    src={item.thumbnail || item.image}
                    alt={item.name}
                    sizes="100px"
                    breakpoints={[80, 120]}
                  />
                  <span className="outfit-creator-item-name">{item.name}</span>
                  {selected.includes(item.id) && (
                    <span className="outfit-creator-check">
                      <Check size={14} weight="bold" aria-hidden="true" />
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="viewer-actions">
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
              <button
                className="primary-button"
                type="button"
                onClick={handleSubmit}
                disabled={!canCreate}
              >
                <Plus size={15} weight="bold" aria-hidden="true" /> Generate
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState(() => {
    if (typeof window === "undefined") return "all";
    const hash = window.location.hash.slice(1);
    return TYPES.some((t) => t.id === hash) ? hash : "all";
  });
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Outfit state
  const [outfits, setOutfits] = useState([]);
  const [outfitsLoading, setOutfitsLoading] = useState(false);
  const [selectedOutfitId, setSelectedOutfitId] = useState(null);
  const [showCreator, setShowCreator] = useState(false);

  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the wardrobe.");
        return response.json();
      })
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
    if (typeof window !== "undefined") window.location.hash = typeId;
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/import/wardrobe/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  // ── Outfit logic ──

  const loadOutfits = useCallback(async () => {
    setOutfitsLoading(true);
    try {
      const response = await fetch("/api/import/outfits", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load outfits.");
      const data = await response.json();
      setOutfits(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setOutfitsLoading(false);
    }
  }, []);

  // Load outfits when switching to outfits tab
  useEffect(() => {
    if (activeType === "outfits" && outfits.length === 0 && !outfitsLoading) {
      loadOutfits();
    }
  }, [activeType, outfits.length, outfitsLoading, loadOutfits]);

  // Poll for generating outfits. Depend only on the boolean (not the whole
  // outfits array) so the interval isn't torn down + recreated every poll.
  const hasGeneratingOutfit = outfits.some((o) => o.status === "generating");
  useEffect(() => {
    if (activeType !== "outfits" || !hasGeneratingOutfit) return;
    const interval = setInterval(() => {
      fetch("/api/import/outfits", { cache: "no-store" })
        .then((r) => r.ok ? r.json() : [])
        .then((data) => setOutfits(data))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [activeType, hasGeneratingOutfit]);

  const createOutfit = async ({ name, garmentIds }) => {
    setShowCreator(false);
    try {
      const response = await fetch("/api/import/outfits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, garmentIds }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Could not create outfit");
      }
      const newOutfit = await response.json();
      setOutfits((current) => [...current, newOutfit]);
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteOutfit = async (id) => {
    try {
      const response = await fetch(`/api/import/outfits/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("Could not delete outfit.");
    } catch (err) {
      setError(err.message);
      return;
    }
    setOutfits((current) => current.filter((o) => o.id !== id));
    setSelectedOutfitId(null);
  };

  const regenerateOutfit = async (id) => {
    try {
      const response = await fetch(`/api/import/outfits/${id}/regenerate`, { method: "POST" });
      if (!response.ok) throw new Error("Could not regenerate outfit.");
      const updated = await response.json();
      setOutfits((current) => current.map((o) => o.id === id ? { ...updated, garments: o.garments } : o));
    } catch (err) {
      setError(err.message);
    }
  };

  const selectedOutfit = outfits.find((o) => o.id === selectedOutfitId) || null;

  const isOutfitsView = activeType === "outfits";

  return (
    <div className={`app-shell${selectedItem || selectedOutfit ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">
              {isOutfitsView
                ? `${outfits.length} ${outfits.length === 1 ? "outfit" : "outfits"}`
                : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
            </p>
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`${activeType === type.id ? "active" : ""}${type.id === "outfits" ? " outfits-tab" : ""}`}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}

        {isOutfitsView ? (
          <>
            {!error && outfitsLoading && <p className="status">Loading outfits</p>}
            {!error && !outfitsLoading && !outfits.length && (
              <p className="status empty">No outfits yet. Tap + to compose a look.</p>
            )}

            {!!outfits.length && (
              <section className="gallery-grid outfit-grid" aria-label="Outfit gallery">
                {outfits.map((outfit) => (
                  <OutfitGalleryItem
                    key={outfit.id}
                    outfit={outfit}
                    onOpen={setSelectedOutfitId}
                  />
                ))}
              </section>
            )}
          </>
        ) : (
          <>
            {!error && loading && <p className="status">Loading wardrobe</p>}
            {!error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}

            {!!items.length && (
              <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
                {visibleItems.map((item) => (
                  <GalleryItem
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    onOpen={setSelectedId}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} />}
      {selectedOutfit && (
        <OutfitViewer
          outfit={selectedOutfit}
          lookNumber={
            [...outfits]
              .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
              .findIndex((o) => o.id === selectedOutfit.id) + 1
          }
          onClose={() => setSelectedOutfitId(null)}
          onDelete={deleteOutfit}
          onRegenerate={regenerateOutfit}
        />
      )}
      {showCreator && (
        <OutfitCreator
          items={items}
          onCancel={() => setShowCreator(false)}
          onCreate={createOutfit}
        />
      )}

      {isOutfitsView ? (
        <button
          className="outfit-fab"
          type="button"
          onClick={() => setShowCreator(true)}
          disabled={items.length < 2}
          aria-label="Create new outfit"
        >
          <Plus size={19} aria-hidden="true" />
        </button>
      ) : (
        <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />
      )}
    </div>
  );
}
