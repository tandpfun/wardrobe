import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Sparkle, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { apiFetch, apiUrl } from "./api.js";
import "./outfits.css";

const OUTFITS_API = "/api/import/outfits";

const PART_LABELS = {
  upperbody: "Top",
  wholebody_up: "Jacket",
  lowerbody: "Bottom",
  accessories_up: "Accessory",
  shoes: "Shoes",
};

const PART_ORDER = ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"];

const STATUS_COPY = {
  draft: "Draft — no image yet",
  generating: "Generating image",
  ready: "Ready",
  failed: "Generation failed",
};

async function api(path, options) {
  const response = await apiFetch(path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The outfit request could not be completed.");
  return value;
}

function splitList(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function emptyDraft() {
  return { name: "", occasion: "", styleDirection: "", setting: "", reason: "", garmentIds: [] };
}

function draftFromOutfit(outfit) {
  return {
    name: outfit.name || "",
    occasion: (outfit.occasion || []).join(", "),
    styleDirection: outfit.styleDirection || "",
    setting: outfit.setting || "",
    reason: outfit.reason || "",
    garmentIds: [...(outfit.garmentIds || [])],
  };
}

function draftToPayload(draft) {
  return {
    name: draft.name.trim(),
    occasion: splitList(draft.occasion),
    styleDirection: draft.styleDirection.trim(),
    setting: draft.setting.trim(),
    reason: draft.reason.trim(),
    garmentIds: draft.garmentIds,
  };
}

function GarmentPicker({ garments, selectedIds, onToggle }) {
  const sorted = useMemo(
    () => [...garments].sort((a, b) => (PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part)) || a.id.localeCompare(b.id)),
    [garments],
  );

  if (!garments.length) {
    return <p className="outfit-picker-empty">Import garments first, then combine them into an outfit.</p>;
  }

  return (
    <div className="outfit-picker" role="group" aria-label="Choose garments for this outfit">
      {sorted.map((garment) => {
        const selected = selectedIds.includes(garment.id);
        return (
          <button
            type="button"
            key={garment.id}
            className={`outfit-picker-item${selected ? " selected" : ""}`}
            aria-pressed={selected}
            onClick={() => onToggle(garment.id)}
            data-testid={`outfit-picker-${garment.id}`}
          >
            <span className="outfit-picker-thumb">
              <img src={apiUrl(garment.thumbnail || garment.image)} alt="" loading="lazy" />
              {selected && <span className="outfit-picker-check"><Check size={14} weight="bold" aria-hidden="true" /></span>}
            </span>
            <span className="outfit-picker-name">{garment.name || PART_LABELS[garment.part] || "Piece"}</span>
            <span className="outfit-picker-part">{PART_LABELS[garment.part] || "Piece"}</span>
          </button>
        );
      })}
    </div>
  );
}

function OutfitForm({ heading, draft, setDraft, garments, busy, error, onSubmit, onCancel, submitLabel }) {
  const toggleGarment = (id) => {
    setDraft((current) => ({
      ...current,
      garmentIds: current.garmentIds.includes(id)
        ? current.garmentIds.filter((existing) => existing !== id)
        : [...current.garmentIds, id],
    }));
  };
  const canSubmit = draft.garmentIds.length > 0 && !busy;

  return (
    <form
      className="outfit-form"
      onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit(); }}
      data-testid="outfit-form"
    >
      <div className="outfit-form-scroll">
        <p className="outfit-form-heading">{heading}</p>
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Untitled outfit"
            data-testid="outfit-name-input"
          />
        </label>
        <label className="field">
          <span>Occasion</span>
          <input
            value={draft.occasion}
            onChange={(event) => setDraft((current) => ({ ...current, occasion: event.target.value }))}
            placeholder="smart-casual, weekend"
          />
        </label>
        <label className="field">
          <span>Style direction</span>
          <textarea
            rows="2"
            value={draft.styleDirection}
            onChange={(event) => setDraft((current) => ({ ...current, styleDirection: event.target.value }))}
            placeholder="Warm neutral tailoring with a relaxed drape."
          />
        </label>
        <label className="field">
          <span>Setting <small>optional</small></span>
          <input
            value={draft.setting}
            onChange={(event) => setDraft((current) => ({ ...current, setting: event.target.value }))}
            placeholder="a quiet warm-stone courtyard"
          />
        </label>
        <label className="field">
          <span>Notes <small>optional</small></span>
          <textarea
            rows="2"
            value={draft.reason}
            onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
            placeholder="Why these pieces work together."
          />
        </label>
        <div className="field">
          <span>Garments <small>{draft.garmentIds.length} selected</small></span>
          <GarmentPicker garments={garments} selectedIds={draft.garmentIds} onToggle={toggleGarment} />
        </div>
      </div>
      {error && <p className="outfit-status is-error" role="alert">{error}</p>}
      <div className="outfit-form-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={!canSubmit} data-testid="outfit-save">
          {busy ? <SpinnerGap size={15} className="outfit-spinner" aria-hidden="true" /> : <Check size={15} weight="bold" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function OutfitCard({ outfit, garments, selected, onOpen }) {
  const pieces = outfit.garmentIds
    .map((id) => garments.find((garment) => garment.id === id))
    .filter(Boolean);
  return (
    <button
      type="button"
      className={`outfit-card is-${outfit.status}${selected ? " selected" : ""}`}
      onClick={() => onOpen(outfit.id)}
      data-testid={`outfit-card-${outfit.id}`}
    >
      <span className="outfit-card-art">
        {outfit.image ? (
          <img src={apiUrl(outfit.image)} alt={`${outfit.name} preview`} loading="lazy" />
        ) : (
          <span className="outfit-card-placeholder" aria-hidden="true">
            {pieces.slice(0, 4).map((piece) => (
              <img key={piece.id} src={apiUrl(piece.thumbnail || piece.image)} alt="" loading="lazy" />
            ))}
          </span>
        )}
        {outfit.status === "generating" && (
          <span className="outfit-card-badge"><SpinnerGap size={13} className="outfit-spinner" aria-hidden="true" /> Generating</span>
        )}
        {outfit.status === "failed" && <span className="outfit-card-badge is-error"><WarningCircle size={13} aria-hidden="true" /> Failed</span>}
        {outfit.imageMode === "demo" && outfit.image && <span className="outfit-card-tag">Demo</span>}
      </span>
      <span className="outfit-card-body">
        <span className="outfit-card-name">{outfit.name}</span>
        <span className="outfit-card-meta">{outfit.occasion.length ? outfit.occasion.join(" · ") : `${outfit.garmentIds.length} pieces`}</span>
      </span>
    </button>
  );
}

function OutfitViewer({ outfit, garments, busy, demoMode, onClose, onGenerate, onEdit, onDelete }) {
  const closeRef = useRef(null);
  const pieces = outfit.garmentIds
    .map((id) => garments.find((garment) => garment.id === id))
    .filter(Boolean);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose]);

  const generating = outfit.status === "generating" || busy;

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-viewer" role="dialog" aria-modal="true" aria-label={`Outfit ${outfit.name}`} data-testid="outfit-viewer">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close outfit" ref={closeRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          <div className="outfit-hero">
            {outfit.image ? (
              <OptimizedImage
                className="outfit-hero-photo"
                src={outfit.image}
                alt={`${outfit.name} outfit`}
                sizes="(max-width: 860px) 100vw, 520px"
                breakpoints={[320, 480, 640, 800, 1040]}
                priority
              />
            ) : (
              <div className="outfit-hero-empty">
                <Sparkle size={30} weight="light" aria-hidden="true" />
                <p>No image yet. Generate one to preview this look.</p>
              </div>
            )}
            {generating && (
              <div className="outfit-hero-overlay"><SpinnerGap size={26} className="outfit-spinner" aria-hidden="true" /><span>Generating image…</span></div>
            )}
          </div>

          <div className="viewer-details outfit-details">
            <div className="viewer-heading">
              <h2>{outfit.name}</h2>
            </div>
            {outfit.occasion.length > 0 && (
              <div className="outfit-chip-row">
                {outfit.occasion.map((entry) => <span className="outfit-chip" key={entry}>{entry}</span>)}
              </div>
            )}
            {outfit.styleDirection && <p className="outfit-blurb">{outfit.styleDirection}</p>}
            {outfit.reason && <p className="outfit-blurb outfit-blurb-muted">{outfit.reason}</p>}
            {outfit.setting && <p className="outfit-setting"><span>Setting</span>{outfit.setting}</p>}

            <div className="outfit-piece-list" aria-label="Garments in this outfit">
              {pieces.map((piece) => (
                <span className="outfit-piece" key={piece.id}>
                  <img src={apiUrl(piece.thumbnail || piece.image)} alt="" loading="lazy" />
                  <span>
                    <strong>{piece.name || PART_LABELS[piece.part] || "Piece"}</strong>
                    <small>{PART_LABELS[piece.part] || "Piece"}</small>
                  </span>
                </span>
              ))}
              {outfit.garmentIds.length > pieces.length && (
                <span className="outfit-piece-missing">{outfit.garmentIds.length - pieces.length} garment(s) no longer in your wardrobe.</span>
              )}
            </div>

            {outfit.status === "failed" && outfit.error && <p className="outfit-status is-error" role="alert">{outfit.error}</p>}
            {demoMode && (
              <p className="outfit-status is-note">Demo mode: images are composed locally from your garment cutouts. Add an OpenAI key and reference photo for modeled photos.</p>
            )}

            <div className="viewer-actions">
              <button className="delete-button" type="button" onClick={() => onDelete(outfit.id)} disabled={generating} data-testid="outfit-delete">
                <Trash size={15} weight="regular" aria-hidden="true" /> Delete
              </button>
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={() => onEdit(outfit)} disabled={generating}>Edit</button>
              <button className="primary-button" type="button" onClick={() => onGenerate(outfit.id)} disabled={generating} data-testid="outfit-generate">
                {generating ? <SpinnerGap size={15} className="outfit-spinner" aria-hidden="true" /> : <Sparkle size={15} weight="bold" aria-hidden="true" />}
                {outfit.image ? "Regenerate" : "Generate image"}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function OutfitsView({ garments, setup }) {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState(null); // "create" | "edit" | null
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const demoMode = setup ? setup.ready === false : false;

  const load = useCallback(async () => {
    try {
      const data = await api(OUTFITS_API);
      setOutfits(Array.isArray(data) ? data : []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while any outfit is mid-generation so the preview lands on its own.
  useEffect(() => {
    if (!outfits.some((outfit) => outfit.status === "generating")) return undefined;
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [outfits, load]);

  const selectedOutfit = outfits.find((outfit) => outfit.id === selectedId) || null;

  const openCreate = () => {
    setDraft(emptyDraft());
    setFormError("");
    setMode("create");
  };

  const openEdit = (outfit) => {
    setDraft(draftFromOutfit(outfit));
    setFormError("");
    setSelectedId(null);
    setMode("edit");
    setEditingId(outfit.id);
  };

  const closeForm = () => { setMode(null); setEditingId(null); setFormError(""); };

  const submitForm = async () => {
    setBusy(true);
    setFormError("");
    try {
      const payload = draftToPayload(draft);
      if (mode === "create") {
        const created = await api(OUTFITS_API, { method: "POST", body: JSON.stringify(payload) });
        setOutfits((current) => [created, ...current]);
        closeForm();
        setSelectedId(created.id);
      } else {
        const updated = await api(`${OUTFITS_API}/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
        setOutfits((current) => current.map((outfit) => outfit.id === updated.id ? updated : outfit));
        closeForm();
        setSelectedId(updated.id);
      }
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (id) => {
    setBusy(true);
    setError("");
    try {
      const queued = await api(`${OUTFITS_API}/${id}/generate`, { method: "POST" });
      setOutfits((current) => current.map((outfit) => outfit.id === id ? queued : outfit));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    setError("");
    try {
      await api(`${OUTFITS_API}/${id}`, { method: "DELETE" });
      setOutfits((current) => current.filter((outfit) => outfit.id !== id));
      setSelectedId(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="outfits-pane" aria-label="Outfits">
      <header className="gallery-header">
        <div className="gallery-meta-row">
          <p className="piece-count">{outfits.length} {outfits.length === 1 ? "outfit" : "outfits"}</p>
          <button className="primary-button outfits-new-button" type="button" onClick={openCreate} data-testid="outfit-new">
            <Plus size={15} weight="bold" aria-hidden="true" /> New outfit
          </button>
        </div>
        <p className="outfits-intro">
          Combine pieces from your wardrobe into a look, then generate a modeled photo.
          {demoMode && " Without an OpenAI key, previews are composed locally so you can still build and browse outfits."}
        </p>
      </header>

      {error && <p className="status error">{error}</p>}
      {!error && loading && <p className="status" data-testid="outfits-loading">Loading outfits</p>}
      {!error && !loading && !outfits.length && (
        <div className="outfits-empty" data-testid="outfits-empty">
          <Sparkle size={30} weight="light" aria-hidden="true" />
          <h2>No outfits yet</h2>
          <p>
            {garments.length
              ? "Build your first look by combining a few pieces from your wardrobe."
              : "Import a few garments first, then combine them into outfits here."}
          </p>
          {garments.length > 0 && <button className="primary-button" type="button" onClick={openCreate}><Plus size={15} weight="bold" aria-hidden="true" /> New outfit</button>}
        </div>
      )}

      {!!outfits.length && (
        <div className="outfits-grid" data-testid="outfits-grid">
          {outfits.map((outfit) => (
            <OutfitCard
              key={outfit.id}
              outfit={outfit}
              garments={garments}
              selected={selectedId === outfit.id}
              onOpen={setSelectedId}
            />
          ))}
        </div>
      )}

      {selectedOutfit && (
        <OutfitViewer
          outfit={selectedOutfit}
          garments={garments}
          busy={busy}
          demoMode={demoMode}
          onClose={() => setSelectedId(null)}
          onGenerate={generate}
          onEdit={openEdit}
          onDelete={remove}
        />
      )}

      {mode && (
        <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeForm()}>
          <div className="viewer-entry">
            <aside className="viewer outfit-builder" role="dialog" aria-modal="true" aria-label={mode === "create" ? "Create outfit" : "Edit outfit"}>
              <button className="viewer-icon-close" type="button" onClick={closeForm} aria-label="Close builder">
                <X size={24} weight="light" aria-hidden="true" />
              </button>
              <OutfitForm
                heading={mode === "create" ? "New outfit" : "Edit outfit"}
                draft={draft}
                setDraft={setDraft}
                garments={garments}
                busy={busy}
                error={formError}
                onSubmit={submitForm}
                onCancel={closeForm}
                submitLabel={mode === "create" ? "Create outfit" : "Save changes"}
              />
            </aside>
          </div>
        </div>
      )}
    </section>
  );
}
