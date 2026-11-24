import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowClockwise, ArrowCounterClockwise, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react";
import "./photo-actions.css";

const PHOTO_API = "/api/import/photos";

async function readResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not update this photo. Try again.");
  if (!Array.isArray(result.photos)) throw new Error("The photo information is incomplete. Try again.");
  return result.photos;
}

// Keep photo history separate from the garment editor, so a new image never resets a draft.
export function usePhotoCollection(kind, targetId) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestNumber = useRef(0);
  const loadController = useRef(null);
  const mutationPending = useRef(null);
  const base = `${PHOTO_API}/${kind}/${encodeURIComponent(targetId)}`;

  const refresh = useCallback(async () => {
    if (mutationPending.current) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const number = ++requestNumber.current;
    try {
      const nextPhotos = await readResponse(await fetch(base, { cache: "no-store", signal: controller.signal }));
      if (number === requestNumber.current) {
        setPhotos(nextPhotos);
        setError("");
      }
    } catch (requestError) {
      if (requestError.name !== "AbortError" && number === requestNumber.current) setError(requestError.message);
    } finally {
      if (number === requestNumber.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    mutationPending.current = null;
    setPending(false);
    setPhotos([]);
    setLoading(true);
    setError("");
    refresh();
    return () => {
      ++requestNumber.current;
      mutationPending.current = null;
      loadController.current?.abort();
    };
  }, [refresh]);

  const generating = photos.some((photo) => photo.generating);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  const act = useCallback(async (action, body) => {
    if (mutationPending.current) return false;
    loadController.current?.abort();
    const number = ++requestNumber.current;
    mutationPending.current = number;
    setPending(true);
    setError("");
    try {
      const nextPhotos = await readResponse(await fetch(`${base}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      if (number === requestNumber.current) setPhotos(nextPhotos);
      return number === requestNumber.current;
    } catch (requestError) {
      if (number === requestNumber.current) setError(requestError.message);
      return false;
    } finally {
      if (mutationPending.current === number) mutationPending.current = null;
      if (number === requestNumber.current) {
        setPending(false);
        setLoading(false);
      }
    }
  }, [base]);

  return { photos, loading, pending, error, refresh, act };
}

function PhotoDialog({ title, busy, onClose, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    // showModal() focuses the first control, the close button; start in the text field instead.
    dialog.querySelector("textarea")?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className="photo-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="photo-dialog__content">
        <div className="photo-dialog__heading">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="photo-dialog__close" aria-label="Close photo dialog" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function PhotoActions({ title, collection, photo, disabled = false, disabledReason = "" }) {
  const [dialog, setDialog] = useState(null);
  const [rating, setRating] = useState("up");
  const [text, setText] = useState("");
  const [now, setNow] = useState(Date.now());
  // A notice belongs to one photo version, so Undo can announce the version it restores.
  const [notice, setNotice] = useState(null);
  const feedbackPending = useRef(false);
  const versionId = photo?.versionId;
  const mode = photo?.mode;
  const busy = collection.pending || photo?.generating || disabled;
  const expiresAt = photo?.undo?.expiresAt ? Date.parse(photo.undo.expiresAt) : 0;
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const available = !!versionId && !collection.loading;
  const isFeedback = dialog === "feedback";

  useEffect(() => {
    setDialog(null);
    setNotice((current) => current?.versionId === versionId ? current : null);
    setNow(Date.now());
  }, [versionId, mode]);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // The dialog closes whenever the photo version changes, so it always acts on the current one.
  const openDialog = (type, nextRating) => {
    if (nextRating) setRating(nextRating);
    setText(type === "feedback" ? photo.feedback?.comment || "" : "");
    setNotice(null);
    setDialog(type);
  };
  const giveFeedback = async (nextRating) => {
    if (!available || busy || feedbackPending.current) return;
    if (photo.feedback?.rating !== nextRating) {
      openDialog("feedback", nextRating);
      return;
    }
    feedbackPending.current = true;
    setNotice(null);
    try {
      if (await collection.act("feedback", { versionId, rating: null, comment: "" })) {
        setNotice({ versionId, text: "Feedback removed for this photo." });
      }
    } finally { feedbackPending.current = false; }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const success = isFeedback
      ? await collection.act("feedback", { versionId, rating, comment: text.trim() })
      : await collection.act("regenerate", { mode, expectedVersionId: versionId, direction: text.trim() });
    if (success) {
      setDialog(null);
      setNotice({ versionId, text: isFeedback ? "Feedback saved for this photo." : "Creating a new photo. You can keep browsing." });
    }
  };
  const undo = async () => {
    if (busy || remaining <= 0) return;
    const restoredVersionId = photo.undo.previousVersionId;
    if (await collection.act("undo", { mode, expectedVersionId: versionId })) setNotice({ versionId: restoredVersionId, text: "Previous photo restored." });
  };

  return (
    <section className="photo-actions" aria-label="Photo feedback and regeneration">
      <div className="photo-actions__heading">
        <h2 className="photo-actions__title">{title}</h2>
        <div className="photo-actions__tools" role="group" aria-label="Photo actions">
          <button type="button" className={photo?.feedback?.rating === "up" ? "is-selected" : ""} disabled={!available || busy} onClick={() => giveFeedback("up")} aria-label="Like this photo" aria-pressed={photo?.feedback?.rating === "up"} title={disabledReason || "Like this photo"}><ThumbsUp size={15} weight={photo?.feedback?.rating === "up" ? "fill" : "regular"} aria-hidden="true" /></button>
          <button type="button" className={photo?.feedback?.rating === "down" ? "is-selected" : ""} disabled={!available || busy} onClick={() => giveFeedback("down")} aria-label="Dislike this photo" aria-pressed={photo?.feedback?.rating === "down"} title={disabledReason || "Dislike this photo"}><ThumbsDown size={15} weight={photo?.feedback?.rating === "down" ? "fill" : "regular"} aria-hidden="true" /></button>
          <span className="photo-actions__separator" aria-hidden="true" />
          <button type="button" className={`photo-actions__regenerate${photo?.generating ? " is-generating" : ""}`} disabled={!available || busy} onClick={() => openDialog("regenerate")} aria-label={photo?.generating ? "Creating photo" : "Regenerate photo"} title={disabledReason || (photo?.generating ? "Creating photo…" : "Regenerate photo")}><ArrowClockwise size={15} aria-hidden="true" /></button>
        </div>
      </div>
      {remaining > 0 && !photo?.generating && <div className="photo-actions__undo">
        <button type="button" disabled={busy} onClick={undo} aria-label="Undo photo regeneration" title="Restore the previous photo"><ArrowCounterClockwise size={13} aria-hidden="true" /> Undo</button>
        <span className="photo-actions__countdown" aria-hidden="true">{remaining}s</span>
        <span className="photo-actions__announcement" role="status">New photo ready. Undo is available for one minute.</span>
      </div>}
      {notice && notice.versionId === versionId && <p className="photo-actions__announcement" role="status">{notice.text}</p>}
      {(collection.error || photo?.error) && <div className="photo-actions__error" role="alert"><p>{collection.error || photo.error}</p>{collection.error && <button type="button" disabled={collection.pending} onClick={collection.refresh}>Try again</button>}</div>}
      {dialog && <PhotoDialog title={isFeedback ? (rating === "up" ? "What works well?" : "What could be better?") : "Create a new photo"} busy={collection.pending} onClose={() => setDialog(null)}>
        <form onSubmit={submit}>
          <p className="photo-dialog__intro">{isFeedback ? "Your feedback stays with this exact photo. Add a note to help improve future styling." : "Suggest a change, or leave this blank for another take. Your previous photo is kept, and you can undo for one minute after the new photo is ready."}</p>
          <label className="field photo-dialog__field">
            <span>{isFeedback ? "Comment (optional)" : "What would you like to change? (optional)"}</span>
            <textarea rows={4} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} placeholder={isFeedback ? "Fit, proportions, colors, or anything else…" : "For example, use a simpler inner layer or improve the fit…"} disabled={collection.pending} />
          </label>
          {collection.error && <p className="photo-actions__error" role="alert">{collection.error}</p>}
          <div className="photo-dialog__footer">
            <button type="button" className="secondary-button" disabled={collection.pending} onClick={() => setDialog(null)}>Cancel</button>
            <button type="submit" className="primary-button" disabled={collection.pending}>{collection.pending ? (isFeedback ? "Saving…" : "Starting…") : isFeedback ? "Save feedback" : "Regenerate photo"}</button>
          </div>
        </form>
      </PhotoDialog>}
    </section>
  );
}
