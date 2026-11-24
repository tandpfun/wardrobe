// Browser-local data adapter for static deployments (e.g. Vercel) where the
// Vite middleware backend does not run. It mimics the `/api/import/...`
// responses the app expects, seeding from the bundled `demo-data.json` and
// persisting user changes in localStorage.
//
// IMPORTANT: persistence here is per-browser only. There is no server store, so
// outfits/edits live in localStorage and are not shared across devices. This is
// the documented demo fallback; the configured local production path (Vite
// backend + filesystem) is untouched.

const OUTFITS_KEY = "wardrobe-demo-outfits-v1";
const WARDROBE_OVERLAY_KEY = "wardrobe-demo-overlay-v1";

let demoPromise;

function loadDemo() {
  demoPromise ??= fetch(`${import.meta.env.BASE_URL}demo-data.json`, { cache: "force-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => data || { garments: [], outfits: [] })
    .catch(() => ({ garments: [], outfits: [] }));
  return demoPromise;
}

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: changes simply won't persist across reloads */
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slugify(value, fallback = "outfit") {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function toList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function normalizeOutfit(raw, takenIds) {
  const input = raw && typeof raw === "object" ? raw : {};
  const name = String(input.name ?? "").trim() || "Untitled outfit";
  const now = new Date().toISOString();
  const id = uniqueSlug(slugify(input.id || name), takenIds);
  return {
    id,
    name,
    occasion: [...new Set(toList(input.occasion))],
    styleDirection: String(input.styleDirection ?? "").trim(),
    setting: String(input.setting ?? "").trim(),
    reason: String(input.reason ?? "").trim(),
    garmentIds: [...new Set(toList(input.garmentIds))],
    status: "draft",
    imageMode: null,
    image: null,
    source: "builder",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

const EDITABLE = ["name", "occasion", "styleDirection", "setting", "reason", "garmentIds"];

async function seededOutfits() {
  const stored = readStore(OUTFITS_KEY, null);
  if (stored) return stored;
  const demo = await loadDemo();
  const seed = Array.isArray(demo.outfits) ? demo.outfits : [];
  writeStore(OUTFITS_KEY, seed);
  return seed;
}

function saveOutfits(outfits) {
  writeStore(OUTFITS_KEY, outfits);
}

function sortOutfits(outfits) {
  return [...outfits].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function wardrobeItems() {
  const demo = await loadDemo();
  const overlay = readStore(WARDROBE_OVERLAY_KEY, { edits: {}, deleted: [] });
  const deleted = new Set(overlay.deleted || []);
  return (Array.isArray(demo.garments) ? demo.garments : [])
    .filter((item) => !deleted.has(item.id))
    .map((item) => ({ ...item, ...(overlay.edits?.[item.id] || {}) }));
}

// Compose a flat-lay preview from the selected garment cutouts using an HTML
// canvas (the browser-side analogue of the server's sharp compositor).
async function composePreview(images, size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f0e8";
  ctx.fillRect(0, 0, size, size);

  const loaded = await Promise.all(
    images.map((src) => new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    })),
  );
  const usable = loaded.filter(Boolean);
  if (usable.length) {
    const columns = usable.length === 1 ? 1 : 2;
    const rows = Math.ceil(usable.length / columns);
    const cellW = size / columns;
    const cellH = size / rows;
    usable.forEach((img, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const scale = Math.min(cellW / img.width, cellH / img.height) * 0.9;
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, col * cellW + (cellW - w) / 2, row * cellH + (cellH - h) / 2, w, h);
    });
  }
  return canvas.toDataURL("image/png");
}

async function generatePreview(outfit) {
  const items = await wardrobeItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  const images = (outfit.garmentIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((item) => item.image || item.thumbnail);
  return composePreview(images);
}

function segments(pathname) {
  return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

export async function handleBrowserRequest(rawPath, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const [pathname] = String(rawPath).split(/[?#]/, 1);
  const parts = segments(pathname); // ["api","import", ...rest]
  const rest = parts.slice(2);
  const body = options.body ? JSON.parse(options.body) : null;

  // Config: always unconfigured demo/static mode.
  if (rest[0] === "config") {
    return json({ ready: false, demo: true, static: true, modelReference: null });
  }

  // Import jobs never run in static mode.
  if (rest[0] === "jobs" && method === "GET" && rest.length === 1) {
    return json([]);
  }

  if (rest[0] === "wardrobe") {
    const id = rest[1] ? decodeURIComponent(rest[1]) : null;
    if (!id && method === "GET") return json(await wardrobeItems());
    if (id) {
      const overlay = readStore(WARDROBE_OVERLAY_KEY, { edits: {}, deleted: [] });
      overlay.edits ??= {};
      overlay.deleted ??= [];
      if (method === "PATCH") {
        const fields = body?.metadata || {};
        overlay.edits[id] = { ...(overlay.edits[id] || {}), ...fields };
        writeStore(WARDROBE_OVERLAY_KEY, overlay);
        const item = (await wardrobeItems()).find((entry) => entry.id === id);
        return json(item || { id, ...fields });
      }
      if (method === "DELETE") {
        if (!overlay.deleted.includes(id)) overlay.deleted.push(id);
        delete overlay.edits[id];
        writeStore(WARDROBE_OVERLAY_KEY, overlay);
        return json({ ok: true });
      }
    }
  }

  if (rest[0] === "outfits") {
    const outfits = await seededOutfits();
    const id = rest[1] ? decodeURIComponent(rest[1]) : null;
    const action = rest[2] || null;

    if (!id) {
      if (method === "GET") return json(sortOutfits(outfits));
      if (method === "POST") {
        const created = normalizeOutfit(body, new Set(outfits.map((outfit) => outfit.id)));
        saveOutfits([created, ...outfits]);
        return json(created, 201);
      }
    } else {
      const index = outfits.findIndex((outfit) => outfit.id === id);
      if (index === -1) return json({ error: "Outfit not found." }, 404);
      const outfit = outfits[index];

      if (action === "generate" && method === "POST") {
        const image = await generatePreview(outfit);
        const updated = { ...outfit, image, status: "ready", imageMode: "demo", error: null, updatedAt: new Date().toISOString() };
        outfits[index] = updated;
        saveOutfits(outfits);
        return json(updated);
      }
      if (!action && method === "GET") return json(outfit);
      if (!action && method === "PATCH") {
        const patch = {};
        for (const field of EDITABLE) {
          if (body && field in body) {
            patch[field] = field === "occasion" || field === "garmentIds"
              ? [...new Set(toList(body[field]))]
              : typeof body[field] === "string" ? body[field].trim() : body[field];
          }
        }
        const updated = { ...outfit, ...patch, updatedAt: new Date().toISOString() };
        outfits[index] = updated;
        saveOutfits(outfits);
        return json(updated);
      }
      if (!action && method === "DELETE") {
        outfits.splice(index, 1);
        saveOutfits(outfits);
        return json({ ok: true });
      }
    }
  }

  return json({ error: `Unsupported demo request: ${method} ${pathname}` }, 404);
}
