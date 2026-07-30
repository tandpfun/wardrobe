import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Trash, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";

// Maps a wardrobe category id to where it stacks in a worn-order silhouette.
// "Base" layers sit under "outer" layers within the same zone (e.g. a top
// under a gilet); anything unrecognized (custom categories) falls back to
// a loose row above/below the stack rather than being dropped.
const SILHOUETTE_ZONES = {
  accessories_up: "accessories",
  upperbody: "torsoBase",
  wholebody_up: "torsoOuter",
  lowerbody: "legs",
  underwear: "legsUnder",
  socks: "feetUnder",
  shoes: "feet",
};

// Structural transform each layer role gets on top of its measured content
// scale — an outer layer sits slightly larger than a base layer, and an
// accessory tilts to read as draped rather than worn flat.
const LAYER_STRUCTURE = {
  base: { scale: 1.1 },
  outer: { scale: 1.12 },
  accessory: { scale: 0.95, rotateDeg: 6 },
};

function groupBySilhouetteZone(items) {
  const zones = { accessories: [], torsoBase: [], torsoOuter: [], legsUnder: [], legs: [], feetUnder: [], feet: [], other: [] };
  for (const item of items) {
    zones[SILHOUETTE_ZONES[item.part] || "other"].push(item);
  }
  return zones;
}

// Every garment cutout is generated on the same roughly-square canvas with
// generous padding, but how much of that canvas the actual garment fills
// varies hugely by shape — trousers are a thin vertical strip, shorts are a
// short wide one. Every generated garment fills ~90% of whichever dimension
// is more extreme for its own shape (skinny jeans: tall and narrow; shorts:
// short and wide), so simply not-clipping doesn't equalize them — trousers
// are already maxed out on height, so "don't clip" leaves them exactly as
// narrow as they really are while a boxy pair of shorts stays fully sized.
// What actually reads as "too small" / "too big" is overall visual area, so
// this measures each image's real content bounding box (via the alpha
// channel) and scales toward a consistent target area, capped so nothing
// zooms past the point where it would clip its own box.
const TARGET_CONTENT_AREA = 0.65;
const contentFillCache = new Map();

function measureContentFill(src) {
  if (!src) return Promise.resolve(null);
  if (contentFillCache.has(src)) return contentFillCache.get(src);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const size = 96;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.clearRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        const { data } = context.getImageData(0, 0, size, size);
        let minX = size, minY = size, maxX = -1, maxY = -1;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (data[(((y * size) + x) * 4) + 3] > 16) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < minX || maxY < minY) { resolve(null); return; }
        resolve({ widthFrac: (maxX - minX + 1) / size, heightFrac: (maxY - minY + 1) / size });
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
  contentFillCache.set(src, promise);
  return promise;
}

function useContentScale(src, active) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!active || !src) { setScale(1); return; }
    let cancelled = false;
    measureContentFill(src).then((box) => {
      if (cancelled || !box) return;
      const fill = Math.max(box.widthFrac, box.heightFrac, 0.05);
      const area = Math.max(box.widthFrac * box.heightFrac, 0.04);
      const areaScale = Math.sqrt(TARGET_CONTENT_AREA / area);
      const clipLimit = Math.min(2, 0.94 / fill);
      setScale(Math.min(clipLimit, Math.max(0.6, areaScale)));
    });
    return () => { cancelled = true; };
  }, [src, active]);
  return scale;
}

function SilhouetteLayer({ item, layer, index = 0, onRemove }) {
  const src = item.thumbnail || item.image;
  const structure = LAYER_STRUCTURE[layer];
  const contentScale = useContentScale(src, Boolean(structure));

  let transform;
  if (structure) {
    const fanScale = index > 0 ? Math.max(0.7, 1 - index * 0.08) : 1;
    const parts = [`scale(${(structure.scale * contentScale * fanScale).toFixed(3)})`];
    if (structure.rotateDeg) parts.push(`rotate(${structure.rotateDeg}deg)`);
    if (index > 0) parts.push(`translate(${index * 14}px, ${index * 6}px)`);
    transform = parts.join(" ");
  } else if (index > 0) {
    transform = `translateX(${index * 14}px) scale(${Math.max(0.7, 1 - index * 0.08)})`;
  }

  return (
    <div className={`silhouette-layer ${layer}`} style={transform ? { transform } : undefined}>
      <OptimizedImage src={src} alt="" sizes="200px" breakpoints={[120, 200, 320]} />
      {onRemove && (
        <button type="button" className="silhouette-remove" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name || "item"}`}>
          <X size={11} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function OutfitSilhouette({ items, onRemove, compact = false }) {
  const zones = useMemo(() => groupBySilhouetteZone(items), [items]);

  return (
    <div className={`outfit-silhouette${compact ? " compact" : ""}`}>
      <div className="silhouette-zone silhouette-torso">
        {zones.torsoBase.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="base" index={index} onRemove={onRemove} />)}
        {zones.torsoOuter.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="outer" index={index} onRemove={onRemove} />)}
        {zones.accessories.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="accessory" index={index} onRemove={onRemove} />)}
      </div>
      <div className="silhouette-zone silhouette-legs">
        {zones.legsUnder.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="waistband" index={index} onRemove={onRemove} />)}
        {zones.legs.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="outer" index={index} onRemove={onRemove} />)}
      </div>
      <div className="silhouette-zone silhouette-feet">
        {zones.feetUnder.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="base" index={index} onRemove={onRemove} />)}
        {zones.feet.map((item, index) => <SilhouetteLayer key={item.id} item={item} layer="outer" index={index} onRemove={onRemove} />)}
      </div>
      {!!zones.other.length && (
        <div className="silhouette-row">
          {zones.other.map((item) => <SilhouetteLayer key={item.id} item={item} layer="chip" onRemove={onRemove} />)}
        </div>
      )}
      {!items.length && <p className="status empty">Add pieces below to build the look.</p>}
    </div>
  );
}

export function OutfitsGallery({ outfits, items, onNew, onOpen }) {
  const itemMap = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item])), [items]);

  return (
    <section className="outfits-pane">
      <div className="outfits-toolbar">
        <p className="piece-count">{outfits.length} {outfits.length === 1 ? "outfit" : "outfits"}</p>
        <button type="button" className="primary-button" onClick={onNew}>
          <Plus size={14} weight="bold" aria-hidden="true" /> New outfit
        </button>
      </div>

      {!outfits.length ? (
        <p className="status empty">Combine pieces from your wardrobe into your first outfit.</p>
      ) : (
        <div className="outfits-grid">
          {outfits.map((outfit) => {
            const garments = outfit.garmentIds.map((id) => itemMap[id]).filter(Boolean);
            return (
              <button
                type="button"
                className="outfit-card"
                key={outfit.id}
                onClick={() => onOpen(outfit.id)}
                aria-label={`Open ${outfit.name}`}
              >
                <OutfitSilhouette items={garments} compact />
                <div className="outfit-card-body">
                  <strong>{outfit.name}</strong>
                  {outfit.occasion && <span>{outfit.occasion}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function GarmentPicker({ items, categories, categoryMap, selectedIds, onToggle }) {
  const [activeType, setActiveType] = useState("all");

  const visibleItems = useMemo(
    () => activeType === "all" ? items : items.filter((item) => item.part === activeType),
    [items, activeType],
  );

  return (
    <div className="garment-picker">
      <div className="garment-picker-filter">
        <select value={activeType} onChange={(event) => setActiveType(event.target.value)} className="filter-select">
          <option value="all">All categories</option>
          {categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
        </select>
      </div>
      <div className="garment-picker-grid">
        {visibleItems.map((item) => {
          const selected = selectedIds.includes(item.id);
          const type = categoryMap[item.part]?.singular || "Item";
          return (
            <button
              type="button"
              key={item.id}
              className={`garment-picker-item${selected ? " selected" : ""}`}
              onClick={() => onToggle(item.id)}
              aria-pressed={selected}
              aria-label={`${selected ? "Remove" : "Add"} ${item.name || type}`}
            >
              <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="90px" breakpoints={[90, 180]} />
              {selected && (
                <span className="garment-picker-check">
                  <Check size={13} weight="bold" aria-hidden="true" />
                </span>
              )}
            </button>
          );
        })}
        {!visibleItems.length && <p className="status empty">No pieces in this category yet.</p>}
      </div>
    </div>
  );
}

export function OutfitBuilder({ outfit, items, categories, categoryMap, onClose, onSave, onDelete }) {
  const isNew = !outfit;
  const [name, setName] = useState(outfit?.name || "");
  const [garmentIds, setGarmentIds] = useState(outfit?.garmentIds || []);
  const [occasion, setOccasion] = useState(outfit?.occasion || "");
  const [style, setStyle] = useState(outfit?.style || "");
  const [setting, setSetting] = useState(outfit?.setting || "");
  const [notes, setNotes] = useState(outfit?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const itemMap = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item])), [items]);
  const selectedItems = garmentIds.map((id) => itemMap[id]).filter(Boolean);

  const toggleGarment = (id) => {
    setGarmentIds((current) => current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]);
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Give the outfit a name."); return; }
    if (!garmentIds.length) { setError("Pick at least one piece."); return; }
    setBusy(true);
    setError("");
    try {
      await onSave({
        id: outfit?.id,
        name: trimmedName,
        garmentIds,
        occasion: occasion.trim() || null,
        style: style.trim() || null,
        setting: setting.trim() || null,
        notes: notes.trim() || null,
      });
      onClose();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!outfit) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(outfit.id);
      onClose();
    } catch (requestError) {
      setError(requestError.message);
      setBusy(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-builder" role="dialog" aria-modal="true" aria-label={isNew ? "New outfit" : "Edit outfit"}>
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close outfit builder">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>{isNew ? "New outfit" : "Edit outfit"}</h2></div></div>
          <div className="viewer-details">
            <p className="card-help">Combine pieces from your wardrobe into a look.</p>

            <OutfitSilhouette items={selectedItems} onRemove={toggleGarment} />

            <div className="item-editor">
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Weekend errands" />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>Occasion</span>
                  <input value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="e.g. Casual" />
                </label>
                <label className="field">
                  <span>Setting</span>
                  <input value={setting} onChange={(event) => setSetting(event.target.value)} placeholder="e.g. Outdoors" />
                </label>
              </div>

              <label className="field details-field">
                <span>Style direction</span>
                <input value={style} onChange={(event) => setStyle(event.target.value)} placeholder="e.g. Warm neutral tailoring, relaxed drape" />
              </label>

              <label className="field details-field">
                <span>Notes</span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Anything else worth remembering about this look"
                  rows={3}
                />
              </label>

              <div className="field details-field">
                <span>Pieces</span>
                <GarmentPicker
                  items={items}
                  categories={categories}
                  categoryMap={categoryMap}
                  selectedIds={garmentIds}
                  onToggle={toggleGarment}
                />
              </div>
            </div>

            {error && <p className="status error">{error}</p>}

            <div className="viewer-actions">
              {!isNew && (
                <button className="delete-button" type="button" disabled={busy} onClick={handleDelete}>
                  <Trash size={15} weight="regular" aria-hidden="true" /> Delete
                </button>
              )}
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
              <button className="primary-button" type="button" disabled={busy} onClick={submit}>
                <Check size={15} weight="bold" aria-hidden="true" /> Save
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
