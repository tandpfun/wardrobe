import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUTFITS_API_ROOT = "/api/import/outfits";
const OUTFITS_IMAGE_ROOT = "/api/import/outfits/images";

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

/**
 * Build the outfit image prompt from the SKILL reference template.
 * @param {object} opts
 * @param {string} opts.name - Outfit name
 * @param {Array} opts.garments - Array of garment records with name, part, tags
 * @param {string} [opts.setting] - Optional scene description
 */
function buildOutfitPrompt({ name, garments, setting }) {
  const tops = garments.filter((g) => g.part === "upperbody" || g.part === "wholebody_up");
  const bottoms = garments.filter((g) => g.part === "lowerbody");
  const outer = garments.filter((g) => g.part === "wholebody_up");
  const shoes = garments.filter((g) => g.part === "shoes");
  const accessories = garments.filter((g) => g.part === "accessories_up");

  const topDesc = tops.map((g) => `${g.name} (${g.color})`).join(", ") || "the top";
  const bottomDesc = bottoms.map((g) => `${g.name} (${g.color})`).join(", ") || "the bottom";
  const outerDesc = outer.length ? ` plus the exact outer-layer reference (${outer.map((g) => g.name).join(", ")})` : "";
  const shoeClause = shoes.length ? ` and the exact selected shoes/accessory (${shoes.map((g) => g.name).join(", ")})` : "";

  const scene = setting || "a clean, restrained real-world setting with warm natural light";

  const layeredClause = outer.length
    ? `\n\nLayered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural 2-4 cm untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband.`
    : "";

  return `Use case: identity-preserve
Asset type: square outfit gallery photograph

Image 1: identity reference for the exact person to preserve.
Image 2: exact top garment reference.
Image 3: exact bottom garment reference.${outer.length ? "\nImage 4: exact outer-layer reference." : ""}${shoes.length || accessories.length ? `\nImage ${outer.length ? 5 : 4}: exact shoe or accessory reference.` : ""}

Primary request: Create a professional square editorial fashion photograph of the person from Image 1 wearing all of the exact referenced garments, and only those garments.

Outfit: ${name}
Scene/backdrop: ${scene}.

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions. Dress them in the exact top and bottom references${outerDesc}${shoeClause}. Plain understated shoes and invisible basics such as socks are allowed only where needed when no shoe reference is provided. Do not add, replace, or invent any other visible clothing or accessory.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, distinctive details, and real closure construction. Keep the top and bottom recognizable without changing their natural length, tuck, or construction.${layeredClause}

Avoid: Completely hidden selected garments, invented zippers, buttons, openings or plackets, unnatural layering, extra layers, hats, bags, scarves, jewelry, visible unreferenced undershirts, crossed arms, hands blocking clothing, garment redesign, changed logos or text, cropped feet, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.`;
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, quality }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

/**
 * Use the vision model to write an editorial style note + 2-3 uppercase style
 * tags for an outfit, given the generated photo and the garment list.
 */
async function openAIAnalyzeOutfit({ key, baseUrl, model, image, mime, garments }) {
  const garmentList = garments
    .map((g, i) => `${i + 1}. ${g.name} (${g.part}, ${g.color})${g.tags?.length ? ` — ${g.tags.join(", ")}` : ""}`)
    .join("\n");

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: `You are a fashion editor. Look at this outfit photo and the garment list below. Write a one-sentence style note (max 30 words, English) describing how the pieces work together — trim, editorial, no marketing fluff. Then suggest 2-3 uppercase style tags capturing the look's mood and occasion (e.g. SMART CASUAL, OFFICE, STATEMENT, STREETWEAR, MINIMAL, CREATIVE).\n\nGarments:\n${garmentList}` },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "outfit_metadata", strict: true, schema: { type: "object", additionalProperties: false, properties: { description: { type: "string" }, tags: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 4 } }, required: ["description", "tags"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI outfit analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI outfit analysis returned no result");
  const parsed = JSON.parse(outputText);
  return {
    description: String(parsed.description || "").slice(0, 300),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).toUpperCase().slice(0, 24)).slice(0, 4) : [],
  };
}

export function wardrobeOutfitsApi(options = {}) {
  let root;
  let dataDir;
  let outfitsFile;
  let outfitImageDir;
  let importedDir;
  let libraryFile;
  let modelReferencePath;
  const running = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  async function loadOutfits() {
    try { return JSON.parse(await readFile(outfitsFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function saveOutfits(outfits) {
    await atomicJson(outfitsFile, outfits);
  }

  async function loadLibrary() {
    try { return JSON.parse(await readFile(libraryFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  function publicOutfit(outfit) {
    return {
      id: outfit.id,
      name: outfit.name,
      garmentIds: outfit.garmentIds || [],
      garments: outfit.garments || [],
      status: outfit.status,
      image: outfit.image || null,
      error: outfit.error || null,
      description: outfit.description || null,
      tags: Array.isArray(outfit.tags) ? outfit.tags : [],
      createdAt: outfit.createdAt,
      updatedAt: outfit.updatedAt,
    };
  }

  async function resolveGarmentImage(garmentId) {
    const library = await loadLibrary();
    const item = library.find((entry) => entry.id === garmentId);
    if (!item) throw new Error(`Wardrobe item not found: ${garmentId}`);
    // item.image is like "/api/import/library/import-xxx-garment.png"
    const filename = path.basename(new URL(item.image, "http://localhost").pathname);
    const filepath = path.join(importedDir, filename);
    await stat(filepath);
    return { data: await readFile(filepath), mime: "image/png", name: `${garmentId}.png` };
  }

  async function generateOutfitImage(outfit) {
    const key = setting("OPENAI_API_KEY");
    if (!key) throw new Error("OPENAI_API_KEY is not configured");

    // Build image references: model first, then garments in order
    const modelData = await readFile(modelReferencePath);
    const images = [{ data: modelData, mime: "image/png", name: "model.png" }];

    const library = await loadLibrary();
    const garments = [];
    for (const garmentId of outfit.garmentIds) {
      const item = library.find((entry) => entry.id === garmentId);
      if (!item) throw new Error(`Wardrobe item not found: ${garmentId}`);
      const garmentImage = await resolveGarmentImage(garmentId);
      images.push(garmentImage);
      garments.push(item);
    }

    const prompt = buildOutfitPrompt({
      name: outfit.name,
      garments,
      setting: outfit.setting,
    });

    const bytes = await openAIEdit({
      key,
      baseUrl: apiBaseUrl(),
      model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
      quality: setting("OPENAI_IMAGE_QUALITY", "high"),
      size: "1024x1024",
      images,
      prompt,
    });

    const imageName = `${outfit.id}.png`;
    await writeFile(path.join(outfitImageDir, imageName), bytes);
    return `${OUTFITS_IMAGE_ROOT}/${imageName}`;
  }

  async function runGeneration(outfitId) {
    if (running.has(outfitId)) return running.get(outfitId);
    const task = (async () => {
      try {
        const outfits = await loadOutfits();
        const outfit = outfits.find((o) => o.id === outfitId);
        if (!outfit) return;
        outfit.status = "generating";
        outfit.error = null;
        outfit.updatedAt = new Date().toISOString();
        await saveOutfits(outfits);

        const imageUrl = await generateOutfitImage(outfit);

        const fresh = await loadOutfits();
        const freshOutfit = fresh.find((o) => o.id === outfitId);
        if (!freshOutfit) return;
        freshOutfit.status = "ready";
        freshOutfit.image = imageUrl;
        freshOutfit.error = null;
        freshOutfit.updatedAt = new Date().toISOString();

        // Generate editorial description + style tags (non-fatal; failure leaves them empty)
        try {
          const library = await loadLibrary();
          const garments = (freshOutfit.garmentIds || [])
            .map((id) => library.find((item) => item.id === id))
            .filter(Boolean);
          const imageBytes = await readFile(path.join(outfitImageDir, `${outfitId}.png`));
          const meta = await openAIAnalyzeOutfit({
            key: setting("OPENAI_API_KEY"),
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
            image: imageBytes,
            mime: "image/png",
            garments,
          });
          freshOutfit.description = meta.description;
          freshOutfit.tags = meta.tags;
        } catch (metaError) {
          freshOutfit.description = freshOutfit.description || null;
          freshOutfit.tags = Array.isArray(freshOutfit.tags) ? freshOutfit.tags : [];
        }

        await saveOutfits(fresh);
      } catch (error) {
        const fresh = await loadOutfits();
        const freshOutfit = fresh.find((o) => o.id === outfitId);
        if (!freshOutfit) return;
        freshOutfit.status = "failed";
        freshOutfit.error = error.message;
        freshOutfit.updatedAt = new Date().toISOString();
        await saveOutfits(fresh);
      }
    })().finally(() => running.delete(outfitId));
    running.set(outfitId, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/outfits")) return next();

    try {
      // Serve outfit images
      const imageMatch = url.pathname.match(/^\/api\/import\/outfits\/images\/([\w.-]+)$/i);
      if (imageMatch && req.method === "GET") {
        const file = path.join(outfitImageDir, path.basename(imageMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }

      // List all outfits
      if (url.pathname === OUTFITS_API_ROOT && req.method === "GET") {
        const outfits = await loadOutfits();
        // Attach garment metadata for display
        const library = await loadLibrary();
        const enriched = outfits.map((o) => {
          const garments = (o.garmentIds || []).map((id) => library.find((item) => item.id === id)).filter(Boolean);
          return { ...publicOutfit(o), garments };
        });
        return json(res, 200, enriched);
      }

      // Create new outfit
      if (url.pathname === OUTFITS_API_ROOT && req.method === "POST") {
        const input = await body(req);
        const { name, garmentIds, setting } = input;

        if (!Array.isArray(garmentIds) || garmentIds.length < 2) {
          throw Object.assign(new Error("Select at least 2 garments"), { status: 400 });
        }
        if (garmentIds.length > 6) {
          throw Object.assign(new Error("Select at most 6 garments"), { status: 400 });
        }

        // Validate all garment IDs exist
        const library = await loadLibrary();
        const validGarments = garmentIds.every((id) => library.some((item) => item.id === id));
        if (!validGarments) throw Object.assign(new Error("One or more garments not found"), { status: 400 });

        const id = randomUUID();
        const now = new Date().toISOString();
        const outfit = {
          id,
          name: typeof name === "string" ? name.trim().slice(0, 120) || "New Outfit" : "New Outfit",
          garmentIds,
          setting: typeof setting === "string" ? setting.trim().slice(0, 300) || null : null,
          status: "generating",
          image: null,
          error: null,
          description: null,
          tags: [],
          createdAt: now,
          updatedAt: now,
        };

        const outfits = await loadOutfits();
        outfits.push(outfit);
        await saveOutfits(outfits);

        // Trigger async generation
        void runGeneration(id);

        const garments = garmentIds.map((gid) => library.find((item) => item.id === gid)).filter(Boolean);
        return json(res, 202, publicOutfit({ ...outfit, garments }));
      }

      // Delete outfit
      const deleteMatch = url.pathname.match(/^\/api\/import\/outfits\/([a-f0-9-]{36})$/i);
      if (deleteMatch && req.method === "DELETE") {
        const id = deleteMatch[1];
        const outfits = await loadOutfits();
        const outfit = outfits.find((o) => o.id === id);
        if (!outfit) return json(res, 404, { error: "Outfit not found" });

        const next = outfits.filter((o) => o.id !== id);
        await saveOutfits(next);

        // Delete image file
        if (outfit.image) {
          const imageName = path.basename(new URL(outfit.image, "http://localhost").pathname);
          await rm(path.join(outfitImageDir, imageName), { force: true });
        }
        return json(res, 200, { deleted: true, id });
      }

      // Regenerate outfit image
      const regenerateMatch = url.pathname.match(/^\/api\/import\/outfits\/([a-f0-9-]{36})\/regenerate$/i);
      if (regenerateMatch && req.method === "POST") {
        const id = regenerateMatch[1];
        const outfits = await loadOutfits();
        const outfit = outfits.find((o) => o.id === id);
        if (!outfit) return json(res, 404, { error: "Outfit not found" });

        outfit.status = "generating";
        outfit.error = null;
        outfit.image = null;
        // Clear stale editorial metadata so the viewer doesn't show the
        // previous look's description/tags while a new image is generating.
        outfit.description = null;
        outfit.tags = [];
        outfit.updatedAt = new Date().toISOString();
        await saveOutfits(outfits);

        void runGeneration(id);
        return json(res, 202, publicOutfit(outfit));
      }

      return next();
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-outfits-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      outfitsFile = path.join(dataDir, "outfits.json");
      outfitImageDir = path.join(dataDir, "outfit-images");
      importedDir = path.join(dataDir, "imported");
      libraryFile = path.join(dataDir, "library.json");
      modelReferencePath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
      await mkdir(outfitImageDir, { recursive: true });

      // Outfits left "generating" from a previous (crashed/killed) process
      // are in an unknown state. Do NOT auto-resume — that would risk a
      // duplicate, re-billed OpenAI request (the in-memory `running` Map is
      // empty on a fresh process, so runGeneration() would always fire a new
      // API call). Mark them as "stalled" so the UI can prompt the user to
      // explicitly regenerate from the viewer.
      const existing = await loadOutfits();
      let changed = false;
      for (const outfit of existing) {
        if (outfit.status === "generating") {
          outfit.status = "stalled";
          outfit.error = "Generation was interrupted. Tap regenerate to try again.";
          outfit.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await saveOutfits(existing);
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
