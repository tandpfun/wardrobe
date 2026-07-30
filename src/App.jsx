import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bag, Check, Plus, TShirt, Trash, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { OutfitBuilder, OutfitsGallery } from "./outfits.jsx";

const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";
const LEGACY_EDITS_STORAGE_KEY = "open-wardrobe-edits-v1";

function readLegacyEdits() {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_EDITS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function clearLegacyEdits() {
  localStorage.removeItem(LEGACY_EDITS_STORAGE_KEY);
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

function formatRelativeTime(iso) {
  if (!iso) return "Never";
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 35) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(diffDays / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
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

function GalleryItem({ item, selected, onOpen, onWear, onPack, busy, categoryMap }) {
  const type = categoryMap[item.part]?.singular || "wardrobe item";
  const count = item.count ?? 1;
  const dirtyCount = item.dirtyCount ?? 0;
  const packedCount = item.packedCount ?? 0;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={`gallery-item-wrap${selected ? " selected" : ""}`}>
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
        {(dirtyCount > 0 || packedCount > 0) && (
          <span className="gallery-item-badges">
            {dirtyCount > 0 && (
              <span className="gallery-item-badge">
                {count > 1 ? `${dirtyCount}/${count} washing` : "Washing"}
              </span>
            )}
            {packedCount > 0 && (
              <span className="gallery-item-badge is-packed">
                {count > 1 ? `${packedCount}/${count} packed` : "Packed"}
              </span>
            )}
          </span>
        )}
      </button>
      {confirming ? (
        <div className="gallery-item-wear-confirm" onClick={(event) => event.stopPropagation()}>
          <span>Needs washing?</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => { onWear(item.id, true); setConfirming(false); }}
            aria-label="Yes, send to the washing basket"
          >
            <Check size={13} weight="bold" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { onWear(item.id, false); setConfirming(false); }}
            aria-label="No, put it straight back"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="gallery-item-actions">
          <button
            className="gallery-item-wear"
            type="button"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); setConfirming(true); }}
            aria-label={`Log wearing ${item.name || type}`}
            title="Log wear"
          >
            <TShirt size={15} weight="regular" aria-hidden="true" />
          </button>
          <button
            className="gallery-item-pack"
            type="button"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); onPack(item.id); }}
            aria-label={`Pack ${item.name || type} for the to go bag`}
            title="Add to to go bag"
          >
            <Bag size={15} weight="regular" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
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

function LocationField({ value, locations, onChange, onAddLocation, onManageLocations }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) { setAdding(false); return; }
    try {
      const location = await onAddLocation(name);
      setNewName("");
      setAdding(false);
      if (location) onChange(location.id);
    } catch {
      setAdding(false);
    }
  };

  if (adding) {
    return (
      <div className="location-add-row">
        <input
          autoFocus
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); submitNew(); }
            if (event.key === "Escape") { setAdding(false); setNewName(""); }
          }}
          placeholder="e.g. Top clothes rail"
        />
        <button type="button" className="secondary-button" onClick={submitNew}>Add</button>
        <button type="button" className="secondary-button" onClick={() => { setAdding(false); setNewName(""); }}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="location-field-row">
      <select
        value={value || ""}
        onChange={(event) => {
          if (event.target.value === "__add__") { setAdding(true); return; }
          onChange(event.target.value || null);
        }}
      >
        <option value="">Not assigned</option>
        {locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
        <option value="__add__">+ Add new location…</option>
      </select>
      {locations.length > 0 && (
        <button type="button" className="location-manage-link" onClick={onManageLocations}>Manage locations</button>
      )}
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus, locations, onAddLocation, onManageLocations, categories, categoryMap }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";
  const isCounted = Boolean(categoryMap[draft.part]?.isCounted);
  const subcategories = categoryMap[draft.part]?.subcategories || [];

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={categoryMap[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select
          value={draft.part}
          onChange={(event) => {
            const part = event.target.value;
            const allowedSubcategoryIds = new Set((categoryMap[part]?.subcategories || []).map((sub) => sub.id));
            setDraft((current) => ({
              ...current,
              part,
              subcategory: allowedSubcategoryIds.has(current.subcategory) ? current.subcategory : null,
            }));
          }}
        >
          {categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
        </select>
      </label>

      {subcategories.length > 0 && (
        <label className="field">
          <span>Subcategory</span>
          <select
            value={draft.subcategory || ""}
            onChange={(event) => setDraft((current) => ({ ...current, subcategory: event.target.value || null }))}
          >
            <option value="">Unspecified</option>
            {subcategories.map((sub) => <option value={sub.id} key={sub.id}>{sub.name}</option>)}
          </select>
        </label>
      )}

      <div className="field-row">
        <label className="field">
          <span>Brand</span>
          <input
            value={draft.brand || ""}
            onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))}
            placeholder="e.g. Nike"
          />
        </label>
        <label className="field">
          <span>Model</span>
          <input
            value={draft.model || ""}
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            placeholder="e.g. Air Force 1"
          />
        </label>
      </div>

      <label className="field">
        <span>{isCounted ? "How many do you have" : "Count"}</span>
        <input
          type="number"
          min="1"
          max="999"
          value={draft.count ?? 1}
          onChange={(event) => {
            const next = Math.max(1, Math.min(999, Math.round(Number(event.target.value)) || 1));
            setDraft((current) => ({ ...current, count: next }));
          }}
        />
      </label>

      <label className="field">
        <span>Location</span>
        <LocationField
          value={draft.locationId}
          locations={locations}
          onChange={(locationId) => setDraft((current) => ({ ...current, locationId }))}
          onAddLocation={onAddLocation}
          onManageLocations={onManageLocations}
        />
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

function ItemViewer({ item, locations, onClose, onSave, onDelete, onAddLocation, onManageLocations, categories, categoryMap }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const buildDraft = (source) => ({
    name: source.name || "",
    part: source.part,
    subcategory: source.subcategory || null,
    color: source.color || "#9a9286",
    secondaryColor: source.secondaryColor || null,
    tags: [...(source.tags || [])],
    brand: source.brand || "",
    model: source.model || "",
    locationId: source.locationId || null,
    count: source.count ?? 1,
  });
  const [draft, setDraft] = useState(() => buildDraft(item));
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = categoryMap[item.part]?.singular || "Wardrobe item";
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
      subcategory: draft.subcategory || null,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
      brand: draft.brand.trim(),
      model: draft.model.trim(),
      locationId: draft.locationId || null,
      count: draft.count ?? 1,
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      subcategory: item.subcategory || null,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
      brand: (item.brand || "").trim(),
      model: (item.model || "").trim(),
      locationId: item.locationId || null,
      count: item.count ?? 1,
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
    setDraft(buildDraft(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const cancelEditing = () => {
    setDraft(buildDraft(item));
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({
      ...item,
      ...draft,
      name: draft.name.trim(),
      tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
      brand: draft.brand.trim() || null,
      model: draft.model.trim() || null,
    });
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
              <h2>{draft.name || categoryMap[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || categoryMap[draft.part]?.singular}</h2>
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
          locations={locations}
          onAddLocation={onAddLocation}
          onManageLocations={onManageLocations}
          categories={categories}
          categoryMap={categoryMap}
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

function WashingBasket({ items, locations, onClose, onComplete, categoryMap }) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(items.map((item) => [item.id, item.locationId || ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onComplete(items.map((item) => ({ id: item.id, locationId: drafts[item.id] || null })));
      onClose();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer washing-basket" role="dialog" aria-modal="true" aria-label="Washing basket">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close washing basket">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>Washing basket</h2></div></div>
          <div className="viewer-details">
            <div className="washing-basket-list">
              {items.map((item) => {
                const type = categoryMap[item.part]?.singular || "Item";
                const count = item.count ?? 1;
                return (
                  <div className="washing-basket-row" key={item.id}>
                    <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="52px" breakpoints={[52, 104]} />
                    <div className="washing-basket-row-body">
                      <strong>{item.name || type}</strong>
                      <span>{count > 1 ? `${item.dirtyCount} of ${count} in the wash` : "In the wash"}</span>
                    </div>
                    <select
                      value={drafts[item.id] || ""}
                      onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                      aria-label={`Location for ${item.name || type}`}
                    >
                      <option value="">Not assigned</option>
                      {locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
                    </select>
                  </div>
                );
              })}
              {!items.length && <p className="status empty">Nothing in the wash right now.</p>}
            </div>

            {error && <p className="status error">{error}</p>}

            <div className="viewer-actions">
              <span className="action-spacer" />
              <button className="primary-button" type="button" disabled={busy || !items.length} onClick={submit}>
                <Check size={15} weight="bold" aria-hidden="true" /> Done — I've put these away
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ToGoBag({ items, onClose, onReturn, categoryMap }) {
  const [busyId, setBusyId] = useState(null);

  const markReturned = async (id, needsWashing) => {
    setBusyId(id);
    try {
      await onReturn(id, needsWashing);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer to-go-bag" role="dialog" aria-modal="true" aria-label="To go bag">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close to go bag">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>To go bag</h2></div></div>
          <div className="viewer-details">
            <p className="card-help">Tick items off as you unpack them. Put clean items straight back away, or send worn ones to the washing basket. Anything still listed here is a reminder it hasn't come back yet.</p>
            <div className="washing-basket-list">
              {items.map((item) => {
                const type = categoryMap[item.part]?.singular || "Item";
                const count = item.count ?? 1;
                return (
                  <div className="washing-basket-row to-go-bag-row" key={item.id}>
                    <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="52px" breakpoints={[52, 104]} />
                    <div className="washing-basket-row-body">
                      <strong>{item.name || type}</strong>
                      <span>{count > 1 ? `${item.packedCount} of ${count} packed` : "Packed"}</span>
                    </div>
                    <div className="to-go-bag-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busyId === item.id}
                        onClick={() => markReturned(item.id, false)}
                        title="Still clean — put it straight back away"
                      >
                        <Check size={14} weight="bold" aria-hidden="true" /> Put away
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busyId === item.id}
                        onClick={() => markReturned(item.id, true)}
                        title="Send to the washing basket"
                      >
                        <TShirt size={14} weight="regular" aria-hidden="true" /> Needs wash
                      </button>
                    </div>
                  </div>
                );
              })}
              {!items.length && <p className="status empty">Nothing packed right now.</p>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function LocationManager({ locations, onClose, onAdd, onRename, onDelete }) {
  const [newName, setNewName] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState("");

  const submitAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await onAdd(name);
      setNewName("");
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const submitRename = async (id) => {
    const name = editingName.trim();
    if (!name) { setEditingId(null); return; }
    setBusyId(id);
    try {
      await onRename(id, name);
      setEditingId(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await onDelete(id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer location-manager" role="dialog" aria-modal="true" aria-label="Manage locations">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close location manager">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>Locations</h2></div></div>
          <div className="viewer-details">
            <div className="location-manager-list">
              {locations.map((location) => (
                <div className="location-manager-row" key={location.id}>
                  {editingId === location.id ? (
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && submitRename(location.id)}
                    />
                  ) : (
                    <span>{location.name}</span>
                  )}
                  <div className="location-manager-row-actions">
                    {editingId === location.id ? (
                      <button type="button" className="secondary-button" disabled={busyId === location.id} onClick={() => submitRename(location.id)}>Save</button>
                    ) : (
                      <button type="button" className="secondary-button" onClick={() => { setEditingId(location.id); setEditingName(location.name); }}>Rename</button>
                    )}
                    <button
                      type="button"
                      className="delete-button"
                      disabled={busyId === location.id}
                      onClick={() => handleDelete(location.id)}
                      aria-label={`Delete ${location.name}`}
                    >
                      <Trash size={14} weight="regular" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
              {!locations.length && <p className="status empty">No locations yet — add your first one below.</p>}
            </div>

            {error && <p className="status error">{error}</p>}

            <div className="location-manager-add">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submitAdd()}
                placeholder="e.g. Top clothes rail"
              />
              <button type="button" className="primary-button" onClick={submitAdd}>
                <Plus size={14} weight="bold" aria-hidden="true" /> Add
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CategoryManager({
  categories, onClose, onAddCategory, onRenameCategory, onDeleteCategory,
  onAddSubcategory, onRenameSubcategory, onDeleteSubcategory, needsSortingCount, onStartSorting,
}) {
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newSubcategoryNames, setNewSubcategoryNames] = useState({});
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [editingSubcategoryKey, setEditingSubcategoryKey] = useState(null);
  const [editingSubcategoryName, setEditingSubcategoryName] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");

  const submitAddCategory = async () => {
    const label = newCategoryName.trim();
    if (!label) return;
    setError("");
    try {
      await onAddCategory(label);
      setNewCategoryName("");
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const submitRenameCategory = async (id) => {
    const label = editingCategoryName.trim();
    if (!label) { setEditingCategoryId(null); return; }
    setBusyKey(`cat:${id}`);
    setError("");
    try {
      await onRenameCategory(id, label);
      setEditingCategoryId(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteCategory = async (id) => {
    setBusyKey(`cat:${id}`);
    setError("");
    try {
      await onDeleteCategory(id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKey(null);
    }
  };

  const submitAddSubcategory = async (categoryId) => {
    const name = (newSubcategoryNames[categoryId] || "").trim();
    if (!name) return;
    setError("");
    try {
      await onAddSubcategory(categoryId, name);
      setNewSubcategoryNames((current) => ({ ...current, [categoryId]: "" }));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const submitRenameSubcategory = async (categoryId, subId) => {
    const name = editingSubcategoryName.trim();
    if (!name) { setEditingSubcategoryKey(null); return; }
    const key = `sub:${categoryId}:${subId}`;
    setBusyKey(key);
    setError("");
    try {
      await onRenameSubcategory(categoryId, subId, name);
      setEditingSubcategoryKey(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteSubcategory = async (categoryId, subId) => {
    const key = `sub:${categoryId}:${subId}`;
    setBusyKey(key);
    setError("");
    try {
      await onDeleteSubcategory(categoryId, subId);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close settings">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>Settings</h2></div></div>
          <div className="viewer-details">
            {needsSortingCount > 0 && (
              <div className="needs-sorting-banner">
                <span>{needsSortingCount} item{needsSortingCount === 1 ? "" : "s"} missing a subcategory</span>
                <button type="button" className="primary-button" onClick={onStartSorting}>Start sorting</button>
              </div>
            )}

            <h3 className="stats-section-heading">Categories</h3>
            <div className="category-manager-list">
              {categories.map((category) => {
                const newSubName = newSubcategoryNames[category.id] || "";
                return (
                  <div className="category-manager-row" key={category.id}>
                    <div className="category-manager-row-head">
                      {editingCategoryId === category.id ? (
                        <input
                          autoFocus
                          value={editingCategoryName}
                          onChange={(event) => setEditingCategoryName(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && submitRenameCategory(category.id)}
                        />
                      ) : (
                        <strong>{category.label}</strong>
                      )}
                      <div className="location-manager-row-actions">
                        {editingCategoryId === category.id ? (
                          <button type="button" className="secondary-button" disabled={busyKey === `cat:${category.id}`} onClick={() => submitRenameCategory(category.id)}>Save</button>
                        ) : (
                          <button type="button" className="secondary-button" onClick={() => { setEditingCategoryId(category.id); setEditingCategoryName(category.label); }}>Rename</button>
                        )}
                        <button
                          type="button"
                          className="delete-button"
                          disabled={busyKey === `cat:${category.id}`}
                          onClick={() => handleDeleteCategory(category.id)}
                          aria-label={`Delete ${category.label}`}
                        >
                          <Trash size={14} weight="regular" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="subcategory-manager-list">
                      {category.subcategories.map((sub) => {
                        const key = `sub:${category.id}:${sub.id}`;
                        return (
                          <div className="subcategory-manager-row" key={sub.id}>
                            {editingSubcategoryKey === key ? (
                              <input
                                autoFocus
                                value={editingSubcategoryName}
                                onChange={(event) => setEditingSubcategoryName(event.target.value)}
                                onKeyDown={(event) => event.key === "Enter" && submitRenameSubcategory(category.id, sub.id)}
                              />
                            ) : (
                              <span>{sub.name}</span>
                            )}
                            <div className="location-manager-row-actions">
                              {editingSubcategoryKey === key ? (
                                <button type="button" className="secondary-button" disabled={busyKey === key} onClick={() => submitRenameSubcategory(category.id, sub.id)}>Save</button>
                              ) : (
                                <button type="button" className="secondary-button" onClick={() => { setEditingSubcategoryKey(key); setEditingSubcategoryName(sub.name); }}>Rename</button>
                              )}
                              <button
                                type="button"
                                className="delete-button"
                                disabled={busyKey === key}
                                onClick={() => handleDeleteSubcategory(category.id, sub.id)}
                                aria-label={`Delete ${sub.name}`}
                              >
                                <Trash size={14} weight="regular" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      <div className="subcategory-manager-add">
                        <input
                          value={newSubName}
                          onChange={(event) => setNewSubcategoryNames((current) => ({ ...current, [category.id]: event.target.value }))}
                          onKeyDown={(event) => event.key === "Enter" && submitAddSubcategory(category.id)}
                          placeholder={`Add a ${category.label.toLowerCase()} subcategory`}
                        />
                        <button type="button" className="secondary-button" onClick={() => submitAddSubcategory(category.id)}>
                          <Plus size={14} weight="bold" aria-hidden="true" /> Add
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!categories.length && <p className="status empty">No categories yet.</p>}
            </div>

            {error && <p className="status error">{error}</p>}

            <div className="location-manager-add">
              <input
                value={newCategoryName}
                onChange={(event) => setNewCategoryName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submitAddCategory()}
                placeholder="e.g. Bags"
              />
              <button type="button" className="primary-button" onClick={submitAddCategory}>
                <Plus size={14} weight="bold" aria-hidden="true" /> Add category
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SortingFlow({ items, categories, categoryMap, onAssign, onClose }) {
  const [dismissedIds, setDismissedIds] = useState(() => new Set());
  const [draftPart, setDraftPart] = useState(null);
  const [draftSubcategory, setDraftSubcategory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const queue = useMemo(() => items.filter((item) => !dismissedIds.has(item.id)), [items, dismissedIds]);
  const current = queue[0] || null;

  useEffect(() => {
    if (!current) return;
    setDraftPart(current.part);
    setDraftSubcategory(current.subcategory || null);
    setError("");
  }, [current?.id]);

  if (!current) {
    return (
      <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className="viewer-entry">
          <aside className="viewer sorting-flow" role="dialog" aria-modal="true" aria-label="Sort items">
            <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close sorting">
              <X size={24} weight="light" aria-hidden="true" />
            </button>
            <div className="viewer-heading"><div><h2>All sorted</h2></div></div>
            <div className="viewer-details">
              <p className="status empty">Nothing left to sort right now.</p>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  const type = categoryMap[current.part]?.singular || "Item";
  const subcategories = categoryMap[draftPart]?.subcategories || [];

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onAssign(current.id, draftPart, draftSubcategory);
      setDismissedIds((prev) => new Set([...prev, current.id]));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const skip = () => setDismissedIds((prev) => new Set([...prev, current.id]));

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer sorting-flow" role="dialog" aria-modal="true" aria-label="Sort items">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close sorting">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>Sort items</h2></div></div>
          <div className="viewer-details">
            <p className="card-help">{queue.length} item{queue.length === 1 ? "" : "s"} left to sort.</p>

            <div className="sorting-flow-item">
              <OptimizedImage src={current.thumbnail || current.image} alt="" sizes="140px" breakpoints={[140, 280]} />
              <strong>{current.name || type}</strong>
            </div>

            <label className="field">
              <span>Category</span>
              <select
                value={draftPart}
                onChange={(event) => {
                  const part = event.target.value;
                  const allowedIds = new Set((categoryMap[part]?.subcategories || []).map((sub) => sub.id));
                  setDraftPart(part);
                  setDraftSubcategory((current2) => allowedIds.has(current2) ? current2 : null);
                }}
              >
                {categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
              </select>
            </label>

            {subcategories.length > 0 && (
              <label className="field">
                <span>Subcategory</span>
                <select value={draftSubcategory || ""} onChange={(event) => setDraftSubcategory(event.target.value || null)}>
                  <option value="">Unspecified</option>
                  {subcategories.map((sub) => <option value={sub.id} key={sub.id}>{sub.name}</option>)}
                </select>
              </label>
            )}

            {error && <p className="status error">{error}</p>}

            <div className="viewer-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={skip}>Skip</button>
              <span className="action-spacer" />
              <button className="primary-button" type="button" disabled={busy} onClick={submit}>
                <Check size={15} weight="bold" aria-hidden="true" /> Save &amp; next
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatRow({ item, maxWearCount, categoryMap }) {
  const type = categoryMap[item.part]?.singular || "Item";
  const wearCount = item.wearCount ?? 0;
  const barWidth = maxWearCount > 0 ? Math.max(wearCount > 0 ? 4 : 0, Math.round((wearCount / maxWearCount) * 100)) : 0;

  return (
    <div className="stats-row">
      <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="44px" breakpoints={[44, 88]} />
      <div className="stats-row-body">
        <strong>{item.name || type}</strong>
        <div className="stats-bar-track"><div className="stats-bar-fill" style={{ width: `${barWidth}%` }} /></div>
        <span className="stats-row-meta">
          {wearCount} {wearCount === 1 ? "wear" : "wears"} · worn {formatRelativeTime(item.lastWornAt).toLowerCase()} · washed {formatRelativeTime(item.lastWashedAt).toLowerCase()}
        </span>
      </div>
    </div>
  );
}

function Stats({ items, onClose, categoryMap }) {
  const totalWears = useMemo(() => items.reduce((total, item) => total + (item.wearCount ?? 0), 0), [items]);
  const neverWorn = useMemo(() => items.filter((item) => (item.wearCount ?? 0) === 0).length, [items]);
  const mostWorn = useMemo(
    () => [...items].filter((item) => (item.wearCount ?? 0) > 0).sort((a, b) => (b.wearCount ?? 0) - (a.wearCount ?? 0)).slice(0, 8),
    [items],
  );
  const leastWorn = useMemo(
    () => [...items].sort((a, b) => (a.wearCount ?? 0) - (b.wearCount ?? 0) || (a.name || "").localeCompare(b.name || "")).slice(0, 8),
    [items],
  );
  const maxWearCount = mostWorn[0]?.wearCount ?? 0;

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer stats-panel" role="dialog" aria-modal="true" aria-label="Wardrobe stats">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close stats">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>Stats</h2></div></div>
          <div className="viewer-details">
            <div className="stats-overview">
              <div className="stats-overview-item"><strong>{items.length}</strong><span>Pieces</span></div>
              <div className="stats-overview-item"><strong>{totalWears}</strong><span>Wears logged</span></div>
              <div className="stats-overview-item"><strong>{neverWorn}</strong><span>Never worn</span></div>
            </div>

            <h3 className="stats-section-heading">Most worn</h3>
            {mostWorn.length ? (
              <div className="stats-list">
                {mostWorn.map((item) => <StatRow item={item} key={item.id} maxWearCount={maxWearCount} categoryMap={categoryMap} />)}
              </div>
            ) : <p className="status empty">Log a few wears to see your most-worn pieces here.</p>}

            {!!leastWorn.length && (
              <>
                <h3 className="stats-section-heading">Rarely worn</h3>
                <div className="stats-list">
                  {leastWorn.map((item) => <StatRow item={item} key={item.id} maxWearCount={maxWearCount} categoryMap={categoryMap} />)}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [categories, setCategories] = useState([]);
  const [outfits, setOutfits] = useState([]);
  const [view, setView] = useState("wardrobe");
  const [activeOutfitId, setActiveOutfitId] = useState(undefined);
  const [activeType, setActiveType] = useState("all");
  const [activeSubcategory, setActiveSubcategory] = useState(null);
  const [activeBrand, setActiveBrand] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [showWashingBasket, setShowWashingBasket] = useState(false);
  const [showToGoBag, setShowToGoBag] = useState(false);
  const [showLocationManager, setShowLocationManager] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSortingFlow, setShowSortingFlow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/import/locations", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then(setLocations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/import/categories", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then(setCategories)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/import/outfits", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then(setOutfits)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the wardrobe.");
        return response.json();
      })
      .then(async (loadedItems) => {
        const deleted = readDeletedItems();
        let visibleItems = loadedItems.filter((item) => !deleted.has(item.id));

        // One-time migration: earlier versions of this app only saved edits to
        // this browser's localStorage, never to the server. Replay any pending
        // local edits through the real PATCH endpoint once, then drop the cache,
        // so nothing a user previously changed is silently lost.
        const legacyEdits = readLegacyEdits();
        const legacyIds = Object.keys(legacyEdits);
        if (legacyIds.length) {
          visibleItems = await Promise.all(visibleItems.map(async (item) => {
            const edit = legacyEdits[item.id];
            if (!edit) return item;
            try {
              const response = await fetch(`/api/import/wardrobe/${item.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(edit),
              });
              if (response.ok) return await response.json();
            } catch {
              // Network hiccup — keep the local edit visible below; the cache
              // stays intact so migration retries on the next load.
              return { ...item, ...edit };
            }
            return { ...item, ...edit };
          }));
          clearLegacyEdits();
        }

        setItems(visibleItems);
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const categoryMap = useMemo(() => Object.fromEntries(categories.map((category) => [category.id, category])), [categories]);
  const categoryOrder = useMemo(() => Object.fromEntries(categories.map((category, index) => [category.id, index])), [categories]);
  const navCategories = useMemo(() => [{ id: "all", label: "All" }, ...categories.map((category) => ({ id: category.id, label: category.label }))], [categories]);

  const needsSortingItems = useMemo(() => items.filter((item) => {
    const category = categoryMap[item.part];
    if (!category) return true;
    return category.subcategories.length > 0 && !item.subcategory;
  }), [items, categoryMap]);

  const typeItems = useMemo(
    () => activeType === "all" ? items : items.filter((item) => item.part === activeType),
    [activeType, items],
  );

  const availableBrands = useMemo(
    () => [...new Set(typeItems.map((item) => item.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [typeItems],
  );

  const visibleItems = useMemo(() => {
    let filtered = typeItems;
    if (activeSubcategory) filtered = filtered.filter((item) => item.subcategory === activeSubcategory);
    if (activeBrand) filtered = filtered.filter((item) => item.brand === activeBrand);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (categoryOrder[a.part] ?? 99) - (categoryOrder[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, typeItems, activeSubcategory, activeBrand, categoryOrder]);

  const laundryItems = useMemo(() => items.filter((item) => (item.dirtyCount ?? 0) > 0), [items]);
  const packedItems = useMemo(() => items.filter((item) => (item.packedCount ?? 0) > 0), [items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setActiveSubcategory(null);
    setActiveBrand(null);
    setSelectedId(null);
  };

  const saveItem = useCallback(async (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    try {
      const response = await fetch(`/api/import/wardrobe/${updatedItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: updatedItem.name,
          part: updatedItem.part,
          subcategory: updatedItem.subcategory,
          color: updatedItem.color,
          secondaryColor: updatedItem.secondaryColor,
          tags: updatedItem.tags,
          brand: updatedItem.brand,
          model: updatedItem.model,
          locationId: updatedItem.locationId,
          count: updatedItem.count,
        }),
      });
      if (response.ok) {
        const saved = await response.json();
        setItems((current) => current.map((item) => item.id === saved.id ? saved : item));
      } else {
        setError("Could not save changes to the server — they may not persist.");
      }
    } catch {
      setError("Could not save changes to the server — they may not persist.");
    }
  }, []);

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
    setOutfits((current) => current
      .map((outfit) => outfit.garmentIds.includes(id) ? { ...outfit, garmentIds: outfit.garmentIds.filter((gid) => gid !== id) } : outfit)
      .filter((outfit) => outfit.garmentIds.length > 0));
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

  const wearItem = useCallback(async (id, needsWashing) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const available = Math.max(0, (item.count ?? 1) - (item.packedCount ?? 0));
      return {
        ...item,
        lastWornAt: new Date().toISOString(),
        dirtyCount: needsWashing ? Math.min(available, (item.dirtyCount ?? 0) + 1) : (item.dirtyCount ?? 0),
      };
    }));
    try {
      const response = await fetch(`/api/import/wardrobe/${id}/wear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needsWashing }),
      });
      if (response.ok) {
        const updated = await response.json();
        setItems((current) => current.map((item) => item.id === id ? updated : item));
      }
    } catch {
      // Optimistic update already applied; will reconcile on next load.
    }
  }, []);

  const packItem = useCallback(async (id) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const available = Math.max(0, (item.count ?? 1) - (item.dirtyCount ?? 0));
      return { ...item, packedCount: Math.min(available, (item.packedCount ?? 0) + 1) };
    }));
    try {
      const response = await fetch(`/api/import/wardrobe/${id}/pack`, { method: "POST" });
      if (response.ok) {
        const updated = await response.json();
        setItems((current) => current.map((item) => item.id === id ? updated : item));
      }
    } catch {
      // Optimistic update already applied; will reconcile on next load.
    }
  }, []);

  const returnItem = useCallback(async (id, needsWashing) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const returning = item.packedCount ?? 0;
      return {
        ...item,
        packedCount: 0,
        dirtyCount: needsWashing ? Math.min(item.count ?? 1, (item.dirtyCount ?? 0) + returning) : (item.dirtyCount ?? 0),
        wearCount: returning > 0 ? (item.wearCount ?? 0) + 1 : (item.wearCount ?? 0),
        lastWornAt: returning > 0 ? new Date().toISOString() : item.lastWornAt,
      };
    }));
    const response = await fetch(`/api/import/wardrobe/${id}/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needsWashing }),
    });
    if (!response.ok) throw new Error("Could not update the to go bag.");
    const updated = await response.json();
    setItems((current) => current.map((item) => item.id === id ? updated : item));
  }, []);

  const completeWash = useCallback(async (entries) => {
    const response = await fetch("/api/import/wardrobe/wash-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: entries }),
    });
    if (!response.ok) throw new Error("Could not update the washing basket.");
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry.locationId]));
    setItems((current) => current.map((item) => byId[item.id] !== undefined ? { ...item, dirtyCount: 0, locationId: byId[item.id] } : item));
  }, []);

  const addLocation = useCallback(async (name) => {
    const response = await fetch("/api/import/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Could not add that location.");
    const location = await response.json();
    setLocations((current) => [...current, location]);
    return location;
  }, []);

  const renameLocation = useCallback(async (id, name) => {
    const response = await fetch(`/api/import/locations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Could not rename that location.");
    const location = await response.json();
    setLocations((current) => current.map((entry) => entry.id === id ? location : entry));
  }, []);

  const deleteLocation = useCallback(async (id) => {
    const response = await fetch(`/api/import/locations/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not delete that location.");
    setLocations((current) => current.filter((entry) => entry.id !== id));
    setItems((current) => current.map((item) => item.locationId === id ? { ...item, locationId: null } : item));
  }, []);

  const addCategory = useCallback(async (label) => {
    const response = await fetch("/api/import/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not add that category.");
    const category = await response.json();
    setCategories((current) => [...current, category]);
    return category;
  }, []);

  const renameCategory = useCallback(async (id, label) => {
    const response = await fetch(`/api/import/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not rename that category.");
    const category = await response.json();
    setCategories((current) => current.map((entry) => entry.id === id ? category : entry));
  }, []);

  const deleteCategory = useCallback(async (id) => {
    const response = await fetch(`/api/import/categories/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete that category.");
    setCategories((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const addSubcategory = useCallback(async (categoryId, name) => {
    const response = await fetch(`/api/import/categories/${categoryId}/subcategories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not add that subcategory.");
    const subcategory = await response.json();
    setCategories((current) => current.map((entry) => entry.id === categoryId
      ? { ...entry, subcategories: [...entry.subcategories, subcategory] }
      : entry));
    return subcategory;
  }, []);

  const renameSubcategory = useCallback(async (categoryId, subId, name) => {
    const response = await fetch(`/api/import/categories/${categoryId}/subcategories/${subId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not rename that subcategory.");
    const subcategory = await response.json();
    setCategories((current) => current.map((entry) => entry.id === categoryId
      ? { ...entry, subcategories: entry.subcategories.map((sub) => sub.id === subId ? subcategory : sub) }
      : entry));
  }, []);

  const deleteSubcategory = useCallback(async (categoryId, subId) => {
    const response = await fetch(`/api/import/categories/${categoryId}/subcategories/${subId}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete that subcategory.");
    setCategories((current) => current.map((entry) => entry.id === categoryId
      ? { ...entry, subcategories: entry.subcategories.filter((sub) => sub.id !== subId) }
      : entry));
    setItems((current) => current.map((item) => item.subcategory === subId ? { ...item, subcategory: null } : item));
  }, []);

  const assignCategory = useCallback(async (id, part, subcategory) => {
    const response = await fetch(`/api/import/wardrobe/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ part, subcategory }),
    });
    if (!response.ok) throw new Error("Could not save that category.");
    const updated = await response.json();
    setItems((current) => current.map((item) => item.id === id ? updated : item));
    return updated;
  }, []);

  const saveOutfit = useCallback(async (payload) => {
    const isNew = !payload.id;
    const response = await fetch(isNew ? "/api/import/outfits" : `/api/import/outfits/${payload.id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not save that outfit.");
    const saved = await response.json();
    setOutfits((current) => isNew ? [...current, saved] : current.map((entry) => entry.id === saved.id ? saved : entry));
    return saved;
  }, []);

  const deleteOutfit = useCallback(async (id) => {
    const response = await fetch(`/api/import/outfits/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete that outfit.");
    setOutfits((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            {view === "wardrobe" && <p className="piece-count">{items.length} {items.length === 1 ? "piece" : "pieces"}</p>}
            <nav className="view-switch" aria-label="Switch between wardrobe and outfits">
              <button type="button" className={view === "wardrobe" ? "active" : ""} onClick={() => setView("wardrobe")}>Wardrobe</button>
              <button type="button" className={view === "outfits" ? "active" : ""} onClick={() => setView("outfits")}>Outfits</button>
            </nav>
          </div>
          {view === "wardrobe" && (
          <>
          <div className="nav-row">
            <nav className="category-nav" aria-label="Filter wardrobe by item type">
              {navCategories.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className={activeType === type.id ? "active" : ""}
                  onClick={() => chooseType(type.id)}
                  aria-pressed={activeType === type.id}
                >
                  {type.label}
                </button>
              ))}
            </nav>
            <nav className="status-nav" aria-label="Checked-out items">
              <button
                type="button"
                className={showWashingBasket ? "active" : ""}
                onClick={() => setShowWashingBasket(true)}
              >
                Laundry Basket{laundryItems.length > 0 ? ` (${laundryItems.length})` : ""}
              </button>
              <button
                type="button"
                className={showToGoBag ? "active" : ""}
                onClick={() => setShowToGoBag(true)}
              >
                To Go Bag{packedItems.length > 0 ? ` (${packedItems.length})` : ""}
              </button>
              <button
                type="button"
                className={showStats ? "active" : ""}
                onClick={() => setShowStats(true)}
              >
                Stats
              </button>
              <button
                type="button"
                className={showSettings ? "active" : ""}
                onClick={() => setShowSettings(true)}
              >
                Settings{needsSortingItems.length > 0 ? ` (${needsSortingItems.length})` : ""}
              </button>
            </nav>
          </div>

          {((categoryMap[activeType]?.subcategories?.length > 0) || availableBrands.length > 0) && (
            <div className="filters-row">
              {categoryMap[activeType]?.subcategories?.length > 0 && (
                <select
                  className="filter-select"
                  value={activeSubcategory || ""}
                  onChange={(event) => setActiveSubcategory(event.target.value || null)}
                  aria-label={`Filter ${categoryMap[activeType]?.label || "items"} by subcategory`}
                >
                  <option value="">All {categoryMap[activeType]?.label}</option>
                  {categoryMap[activeType].subcategories.map((sub) => <option value={sub.id} key={sub.id}>{sub.name}</option>)}
                </select>
              )}
              {availableBrands.length > 0 && (
                <select
                  className="filter-select"
                  value={activeBrand || ""}
                  onChange={(event) => setActiveBrand(event.target.value || null)}
                  aria-label="Filter by brand"
                >
                  <option value="">All brands</option>
                  {availableBrands.map((brand) => <option value={brand} key={brand}>{brand}</option>)}
                </select>
              )}
            </div>
          )}
          </>
          )}
        </header>

        {view === "wardrobe" && error && <p className="status error">{error}</p>}
        {view === "wardrobe" && !error && loading && <p className="status">Loading wardrobe</p>}
        {view === "wardrobe" && !error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}

        {view === "wardrobe" && !!items.length && (
          <section className="gallery-grid" aria-label={`${categoryMap[activeType]?.label || "All"} wardrobe items`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={setSelectedId}
                onWear={wearItem}
                onPack={packItem}
                categoryMap={categoryMap}
              />
            ))}
          </section>
        )}

        {view === "outfits" && (
          <OutfitsGallery
            outfits={outfits}
            items={items}
            onNew={() => setActiveOutfitId(null)}
            onOpen={(id) => setActiveOutfitId(id)}
          />
        )}
      </main>

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          locations={locations}
          onClose={() => setSelectedId(null)}
          onSave={saveItem}
          onDelete={deleteItem}
          onAddLocation={addLocation}
          onManageLocations={() => setShowLocationManager(true)}
          categories={categories}
          categoryMap={categoryMap}
        />
      )}
      {showWashingBasket && (
        <WashingBasket
          items={laundryItems}
          locations={locations}
          onClose={() => setShowWashingBasket(false)}
          onComplete={completeWash}
          categoryMap={categoryMap}
        />
      )}
      {showToGoBag && (
        <ToGoBag
          items={packedItems}
          onClose={() => setShowToGoBag(false)}
          onReturn={returnItem}
          categoryMap={categoryMap}
        />
      )}
      {showStats && <Stats items={items} onClose={() => setShowStats(false)} categoryMap={categoryMap} />}
      {showLocationManager && (
        <LocationManager
          locations={locations}
          onClose={() => setShowLocationManager(false)}
          onAdd={addLocation}
          onRename={renameLocation}
          onDelete={deleteLocation}
        />
      )}
      {showSettings && (
        <CategoryManager
          categories={categories}
          onClose={() => setShowSettings(false)}
          onAddCategory={addCategory}
          onRenameCategory={renameCategory}
          onDeleteCategory={deleteCategory}
          onAddSubcategory={addSubcategory}
          onRenameSubcategory={renameSubcategory}
          onDeleteSubcategory={deleteSubcategory}
          needsSortingCount={needsSortingItems.length}
          onStartSorting={() => { setShowSettings(false); setShowSortingFlow(true); }}
        />
      )}
      {showSortingFlow && (
        <SortingFlow
          items={needsSortingItems}
          categories={categories}
          categoryMap={categoryMap}
          onAssign={assignCategory}
          onClose={() => setShowSortingFlow(false)}
        />
      )}
      {activeOutfitId !== undefined && (
        <OutfitBuilder
          outfit={activeOutfitId ? outfits.find((entry) => entry.id === activeOutfitId) : null}
          items={items}
          categories={categories}
          categoryMap={categoryMap}
          onClose={() => setActiveOutfitId(undefined)}
          onSave={saveOutfit}
          onDelete={deleteOutfit}
        />
      )}
      <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />
    </div>
  );
}
