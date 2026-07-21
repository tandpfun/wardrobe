import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ImageSquare, MagnifyingGlass, SpinnerGap } from "@phosphor-icons/react";
import "./immich-picker.css";

const ASSETS_API = "/api/immich/assets";

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Immich request failed.");
  return value;
}

function dateLabel(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

export function ImmichPicker({ mode, onClose, onImport, onReferenceSaved }) {
  const [assets, setAssets] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState("outfit");
  const [searchMode, setSearchMode] = useState("smart");
  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState(null);
  const [years, setYears] = useState(4);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedAssets = useMemo(() => assets.filter((asset) => selected.has(asset.id)), [assets, selected]);

  const load = async ({ requestedPage = 1, requestedMode = searchMode, requestedQuery = query } = {}) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: String(requestedPage), size: "30", mode: requestedMode, query: requestedQuery });
      const result = await request(`${ASSETS_API}?${params}`);
      setAssets(result.items || []);
      setNextPage(result.nextPage || null);
      setYears(result.years || 4);
      setPage(requestedPage);
      setSelected(new Set());
    } catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load({ requestedPage: 1, requestedMode: "smart", requestedQuery: "outfit" }); }, []);

  const toggle = (asset) => {
    setSelected((current) => {
      if (mode === "reference") return new Set(current.has(asset.id) ? [] : [asset.id]);
      const next = new Set(current);
      if (next.has(asset.id)) next.delete(asset.id);
      else if (next.size < 5) next.add(asset.id);
      return next;
    });
  };

  const useReference = async () => {
    const asset = selectedAssets[0];
    if (!asset) return;
    setBusy(true); setError("");
    try {
      await request("/api/immich/reference", { method: "POST", body: JSON.stringify({ assetId: asset.id }) });
      await onReferenceSaved?.(asset);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };

  const submitImport = async () => {
    if (!selectedAssets.length) return;
    setBusy(true); setError("");
    try { await onImport(selectedAssets); }
    catch (requestError) { setError(requestError.message); setBusy(false); }
  };

  return (
    <div className="immich-picker">
      <div className="immich-picker__heading">
        <button className="import-icon-button" type="button" onClick={onClose} aria-label="Back to import"><ArrowLeft size={18} /></button>
        <div><p className="import-popover__eyebrow">Immich · last {years} years</p><h3>{mode === "reference" ? "Choose your reference portrait" : "Choose outfit photos"}</h3></div>
      </div>
      <p className="immich-picker__intro">{mode === "reference" ? "Choose a clear photograph of yourself. It stays local and becomes the identity reference for modeled looks." : "Smart search scans your Immich index locally. Select up to five useful outfit photos per batch; only selected photos are sent to Codex for clothing analysis."}</p>
      <form className="immich-search" onSubmit={(event) => { event.preventDefault(); setSearchMode("smart"); load({ requestedPage: 1, requestedMode: "smart", requestedQuery: query }); }}>
        <label><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="outfit, full body, jacket…" /></label>
        <button className="import-button" type="submit" disabled={loading}>Search</button>
        <button className="import-button" type="button" disabled={loading} onClick={() => { setSearchMode("recent"); load({ requestedPage: 1, requestedMode: "recent", requestedQuery: "" }); }}>Recent</button>
      </form>
      {loading ? <div className="immich-picker__loading"><SpinnerGap className="import-spinner" size={25} /> Searching Immich…</div> : assets.length ? (
        <div className="immich-grid">
          {assets.map((asset) => <button type="button" className={`immich-card${selected.has(asset.id) ? " is-selected" : ""}`} key={asset.id} onClick={() => toggle(asset)} aria-pressed={selected.has(asset.id)}>
            <img src={asset.thumbnailUrl} alt="" loading="lazy" />
            <span className="immich-card__check">{selected.has(asset.id) ? <Check size={14} weight="bold" /> : <ImageSquare size={14} />}</span>
            <span className="immich-card__date">{dateLabel(asset.localDateTime || asset.fileCreatedAt)}</span>
          </button>)}
        </div>
      ) : <p className="immich-picker__empty">No matching photos were found. Try another search or open Recent.</p>}
      <div className="immich-picker__footer">
        <div className="immich-pagination"><button className="import-button" disabled={loading || page <= 1} onClick={() => load({ requestedPage: page - 1 })}>Previous</button><span>Page {page}</span><button className="import-button" disabled={loading || !nextPage} onClick={() => load({ requestedPage: Number(nextPage) || page + 1 })}>Next</button></div>
        {mode === "reference"
          ? <button className="import-button import-button--primary" disabled={busy || selectedAssets.length !== 1} onClick={useReference}>{busy ? <SpinnerGap className="import-spinner" size={15} /> : <Check size={15} />} Use as reference</button>
          : <button className="import-button import-button--primary" disabled={busy || !selectedAssets.length} onClick={submitImport}>{busy ? <SpinnerGap className="import-spinner" size={15} /> : <ImageSquare size={15} />} Import {selectedAssets.length || ""}</button>}
      </div>
      {error && <p className="import-status is-error" role="alert">{error}</p>}
    </div>
  );
}
