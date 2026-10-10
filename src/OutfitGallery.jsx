import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { PhotoActions, usePhotoCollection } from "./PhotoActions.jsx";

function OutfitViewer({ outfit, onClose, onPhotoChange }) {
  const collection = usePhotoCollection("outfit", outfit.id);
  const photo = collection.photos.find((entry) => entry.mode === "default") || collection.photos[0];
  const closeRef = useRef(null);
  const [loadedImage, setLoadedImage] = useState(null);
  const image = photo?.image || outfit.image;
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape" && !document.querySelector(".photo-dialog[open]")) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose]);
  useEffect(() => {
    if (photo?.image) onPhotoChange(outfit.id, photo.image);
  }, [outfit.id, photo?.image, onPhotoChange]);

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="viewer-entry">
        <aside className="viewer outfit-viewer" role="dialog" aria-modal="true" aria-label={`Outfit: ${outfit.name || "Styled outfit"}`}>
          <button type="button" className="viewer-icon-close" aria-label="Close outfit viewer" onClick={onClose} ref={closeRef}><X size={24} weight="light" aria-hidden="true" /></button>
          <OptimizedImage className="outfit-viewer__image" src={image} alt={outfit.name || "Styled outfit"} sizes="(max-width: 860px) 100vw, 520px" breakpoints={[320, 480, 640, 800, 1040]} priority onLoad={() => setLoadedImage(image)} />
          <div className="outfit-viewer__details">
            <PhotoActions title={outfit.name || "Styled outfit"} collection={collection} photo={photo} disabled={photo?.image !== loadedImage} disabledReason={photo && photo.image !== loadedImage ? "Loading photo…" : ""} />
            {outfit.reason && <p className="outfit-viewer__reason">{outfit.reason}</p>}
            {!!outfit.occasion?.length && <p className="outfit-viewer__occasion">{Array.isArray(outfit.occasion) ? outfit.occasion.join(" · ") : outfit.occasion}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function OutfitGallery() {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [reload, setReload] = useState(0);
  const openedFrom = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch("/api/import/outfits", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Could not load your outfits.");
        if (!Array.isArray(result)) throw new Error("The outfit collection is incomplete. Try again.");
        return result;
      })
      .then(setOutfits)
      .catch((requestError) => { if (requestError.name !== "AbortError") setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const updatePhoto = useCallback((id, image) => {
    setOutfits((current) => current.map((outfit) => outfit.id === id && outfit.image !== image ? { ...outfit, image } : outfit));
  }, []);
  const closeViewer = useCallback(() => {
    setSelectedId(null);
    requestAnimationFrame(() => openedFrom.current?.focus({ preventScroll: true }));
  }, []);
  const selected = outfits.find((outfit) => outfit.id === selectedId);

  return (
    <>
      <div className="outfit-collection-heading"><p className="piece-count">{outfits.length} {outfits.length === 1 ? "outfit" : "outfits"}</p></div>
      {loading && <p className="status">Loading outfits</p>}
      {error && <div className="outfit-collection-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setReload((current) => current + 1)}>Try again</button></div>}
      {!loading && !error && !outfits.length && <p className="status empty">Your complete outfit ideas will appear here after they’re generated from your wardrobe.</p>}
      {!loading && !error && !!outfits.length && <section className="outfit-grid" aria-label="Complete outfits">
        {outfits.map((outfit) => <button className="outfit-tile" key={outfit.id} type="button" aria-label={`View outfit ${outfit.name || "Styled outfit"}`} onClick={(event) => { openedFrom.current = event.currentTarget; setSelectedId(outfit.id); }}>
          <OptimizedImage src={outfit.image} alt="" sizes="(max-width: 520px) calc(50vw - 24px), (max-width: 860px) 30vw, 300px" breakpoints={[180, 240, 320, 480, 640]} />
          <span>{outfit.name || "Styled outfit"}</span>
        </button>)}
      </section>}
      {selected && <OutfitViewer key={selected.id} outfit={selected} onClose={closeViewer} onPhotoChange={updatePhoto} />}
    </>
  );
}
