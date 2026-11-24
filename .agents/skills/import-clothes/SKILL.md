---
name: import-clothes
description: Extract unique garments from outfit or model photos, reconstruct clean transparent clothing cutouts, generate identity-preserving modeled editorial photos, and import approved items directly into this Wardrobe project's local JSON database. Use when a user asks Codex to add, ingest, extract, or import clothes from a folder of photos into Wardrobe, wants modeled photos for imported pieces, or wants finished wardrobe PNGs without using the in-app OpenAI import flow.
---

# Import Clothes

Turn photos of worn clothing into source-faithful transparent catalog PNGs and modeled editorial photos, then add the approved results to the local Wardrobe database.

## Inputs

Obtain the source-image folder unless the user already supplied it. Resolve relative paths from the repository root. Confirm this is the Wardrobe repository by checking for `package.json`, `scripts/import-job-api.mjs`, and `data/` in `.gitignore`.

Resolve the configured wardrobe directory as `$DATA` using [the shared directory instructions](../../../docs/image-history-for-agents.md#wardrobe-directory) before reading or importing catalog items. Keep all catalog and image-history operations in that directory.

At the start, check for the identity reference at `data/model-reference.png` or the local path configured by `WARDROBE_MODEL_REFERENCE`. If neither exists, ask: `Please provide a clear PNG reference photo of yourself for the modeled wardrobe images. What is its local path?` Do not begin modeled generation until the user supplies it. Keep the image local and never add it to Git.

When present, use `model-reference-2.png` and `model-reference-3.png` beside the selected primary reference for body proportions, with the primary reference controlling the face. Apply the user's current modeled-photo direction or `WARDROBE_MODEL_DIRECTION` when configured (for example, longer-leg male-model styling); otherwise preserve the supplied body proportions. Include all applicable local references without changing the originals.

Default to direct database import when the user asks to add clothes to Wardrobe. If they only request cutouts, ask for a new output-folder name instead and skip the database step.

## Rules

- Read and follow the built-in `imagegen` skill before generating or editing an image.
- Preserve every source image unchanged.
- Produce one clothing item per PNG, except an established matching pair such as shoes.
- Remove the wearer, skin, hair, mannequin, hanger, props, other layers, and scene.
- Preserve only source-supported color, material, silhouette, construction, pattern, and legible marks.
- Prefer omission over invented logos, text, pockets, seams, fasteners, hardware, or trim.
- Deduplicate only when source photographs establish that two appearances are the same physical item.
- Hold items whose defining construction cannot be recovered without substantial invention.
- Keep temporary crops, prompts, manifests, and QA files outside `$DATA`.

## Parallel work

Use subagents for large source folders or more than eight generated items when the current environment supports them. Give each worker a disjoint set of source files or manifest slugs and require it to return the slug, prompt, reference paths, chroma path, modeled path, and visual-review notes.

Keep one main agent responsible for the global item inventory, physical-identity deduplication, manifest reconciliation, database write, and final contact-sheet QA. Never let two workers generate or write the same slug. Run batches in waves when concurrency is limited, and resume only missing or failed slugs.

## Temporary workspace

Work outside the repository data directory:

```bash
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-import.XXXXXX")"
mkdir -p "$WORK"/{source-jpg,crops,chroma,items,modeled,qa}
```

Keep all intermediate files under `$WORK`. Delete it only after delivery succeeds.

## Workflow

### 1. Inventory sources

Use `rg --files` first. Include JPEG, PNG, WebP, HEIC/HEIF, TIFF, BMP, and AVIF. Exclude the configured wardrobe directory, `dist/`, `node_modules/`, and `.git/`.

Create upright RGB JPEG working copies at quality 95 or better without upscaling. Make labeled contact sheets of at most 12 photos and inspect every sheet. Inventory every deliberately worn top, jacket, bottom, accessory, and pair of shoes.

Read `$DATA/library.json` before generating: consolidate confirmed physical duplicates with existing items and honor their saved layer suitability. Reuse the existing accepted cutout for a confirmed existing item so its content-derived ID remains unchanged. Keep the original category and one physical item ID even when an item also works as a layer.

### 2. Build the manifest

Write `$WORK/manifest.json` using this final shape:

```json
{
  "items": [
    {
      "slug": "navy-flannel-shirt",
      "file": "navy-flannel-shirt.png",
      "modeledFiles": [
        { "mode": "default", "file": "navy-flannel-shirt.png" },
        { "mode": "layer", "file": "navy-flannel-shirt-layer.png" }
      ],
      "name": "Navy Flannel Shirt",
      "part": "upperbody",
      "canLayer": true,
      "layeringSource": "ai",
      "color": "#172033",
      "secondaryColor": "#f2efe6",
      "tags": ["flannel", "plaid", "button-front"],
      "status": "accepted",
      "sourceRefs": ["IMG_1284.jpg", "IMG_1289.jpg"],
      "unknowns": []
    }
  ]
}
```

Use only these `part` values:

- `upperbody` — tops
- `wholebody_up` — jackets and outerwear
- `lowerbody` — bottoms
- `accessories_up` — accessories
- `shoes` — shoes

Use lowercase hyphenated slugs, six-digit hex colors, at most 12 short lowercase tags, and `null` when there is no genuinely distinct secondary color. Keep working records as `status: "generate"` or `status: "hold"`; change a record to `accepted` only after final QA. The import script ignores every non-accepted record.

Infer `canLayer` independently of category from the visible construction, weight and fit: can this piece serve as a visible outer layer over another garment in a plausible outfit? Casual flannels, textured shirts, roomy overshirts and zip-up jackets can qualify. Pullovers can qualify when their fit supports an inner piece; keep their real closed construction. Fitted formal dress shirts, ordinary bottoms, shoes and uncertain cases usually do not qualify. Do not equate layer suitability with a front opening, or require a shirt classification.

Set `layeringSource: "ai"` for new judgments. A saved `layeringSource: "manual"` choice takes precedence over an AI reclassification; carry it into the working manifest before selecting modeled modes.

Use `modeledFiles` for new modeled output: exactly `default` and `layer` when `canLayer` is true, and exactly `default` otherwise. The legacy `modeledFile` input remains supported for older single-photo manifests. All filenames are local PNG basenames.

### 3. Prepare focused references

For each generated item, crop the strongest view with about 12% padding and preserve enough context to distinguish the target from underlayers. Add at most one complementary crop when it shows important construction unavailable in the primary view. Inspect labeled crop contact sheets before generation.

### 4. Generate evidence-bound cutouts

Use Imagegen with the primary crop and only a genuinely complementary second crop. Ask for the complete empty item centered on a perfectly uniform chroma background with generous padding and no shadow. State the exact source-supported construction and all uncertain details that must be omitted.

Default to `#00ff00`; use `#ff00ff` for green garments unless magenta is prominent. Otherwise choose a maximally distant saturated RGB key. Never use a key color present in the garment.

Save generated chroma images to `$WORK/chroma/SLUG.png`. Compare every result against its source before accepting it.

### 5. Remove the chroma background

Prefer the helper bundled with the built-in Imagegen skill:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/remove_chroma_key.py" \
  --input "$WORK/chroma/SLUG.png" \
  --out "$WORK/items/SLUG.png" \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill \
  --force
```

If removal damages the item, regenerate with a more distant key instead of forcing the matte.

### 6. Verify

For every final PNG, verify:

- PNG format with an RGBA alpha channel
- transparent corners and border
- visible content with padding and no clipped extremity
- no body part, underlayer, adjacent garment, prop, shadow, or chroma halo
- source-faithful category, proportions, color, material, construction, pattern, and marks
- exactly one output for every accepted manifest record

Inspect checkerboard contact sheets of at most 12 items and compare sensitive results individually with their source crops. Regenerate critical or major failures. Mark only passing records `accepted`.

### 7. Generate modeled photos

Use `data/model-reference.png` as the identity reference unless `WARDROBE_MODEL_REFERENCE` points to another local PNG. If neither exists, ask the user for a clear reference photo before continuing. Never add that photo to Git.

Read [the shared image-history instructions](../../../docs/image-history-for-agents.md) before modeled generation: derive stable item IDs for failed-attempt archival and record the exact prompt/context.

For every accepted cutout, use Imagegen with the face identity first, any applicable body references next, then the exact garment PNG. Name the reference roles explicitly in the prompt. Save horizontal 3:2 PNGs in `$WORK/modeled/` and list them in `modeledFiles`:

- Layerable piece: exactly two photos, `SLUG.png` in its normal featured-item presentation (`default`) and `SLUG-layer.png` worn as a visible outer layer over an appropriate inner piece (`layer`). A button-front shirt can be buttoned in its default view and open in the layer view; a zip-up jacket can be closed and open. Use only real closures and keep pullovers closed.
- Every other piece: exactly one `SLUG.png` in `default` mode.

One physical item keeps one cutout, manifest record and database ID. These are item previews; create a separate full outfit collection only when the user requests it.

When adding layer suitability to an existing piece, reuse its accepted normal photo after checking its current garment, identity and styling. Copy that photo into the temporary modeled folder as `SLUG.png`, generate only the missing layered photo, and import the complete two-mode set with its existing cutout. In the web UI, saving **Can wear as a layer** exposes **Create layer look** for eligible items with a single accepted photo; it creates the missing view without reimporting or duplicating the item.

Use this generation brief:

```text
Create a professional horizontal 3:2 editorial fashion photograph. The first reference controls the person's face; supplied body references control proportions subject to the user's explicitly requested model direction. The garment reference is the exact featured item.

Preserve the person's recognizable face, hair, age, build, and skin texture. [Apply the supplied body proportions and configured model direction.] Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure, and distinctive details. Do not redesign, simplify, replace, or reinterpret it.

Wearing mode: [default: natural featured-item presentation, using its normal construction; layer: featured piece worn over an appropriate, visibly distinct inner garment, using only its real construction and closures].

Style with the judgment of an experienced menswear stylist: balance fit, proportion, color and texture for the occasion. Choose an appropriate inner piece, such as a simple T-shirt or a hoodie where the outer garment has enough room, and keep the featured item readable. Use understated supporting clothes that complete the outfit without covering or competing with the featured item. Keep the full featured item and every important detail visible. Use a natural pose with arms and accessories away from it.

Place the person in a tasteful real-world setting with warm professional natural light, realistic shadows, authentic skin and fabric texture, and restrained editorial color grading. Leave environmental breathing room for flexible cropping.

Avoid hidden garment details, invented closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, or synthetic AI polish.
```

Add the complete final prompt and optional generation `context` to each accepted `modeledFiles` entry; the importer archives those accepted files. Use fresh working filenames and archive every returned failed modeled attempt as rejected or invalid with `activate: false` before correcting it, following the shared instructions. Never discard or overwrite a previous modeled generation.

Vary understated settings across a batch while keeping the identity and art direction cohesive. Compare every photo against its identity, body and garment references, and check the selected wearing mode and the exact one-or-two count. Regenerate identity drift, garment redesign, blocked inner tops, invented openings, anatomy failures, or incorrect framing.

### 8. Import into Wardrobe

Show the user the accepted item count and names before writing when their original request did not explicitly authorize direct import. When direct import was requested, proceed after QA.

Run the bundled deterministic importer from the repository root:

```bash
node .agents/skills/import-clothes/scripts/import-to-wardrobe.mjs \
  --items "$WORK/items" \
  --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json"
```

The script validates the cutouts and exact modeled modes, copies cutouts into `$DATA/imported/`, archives accepted modeled files and their supplied prompt/context in `$DATA/photo-history/` (the record's modeled images point there), preserves previous current photos, and updates `$DATA/library.json` under the same library lock as the web UI. Stable UUIDs from cutout content keep identical imports under one item; physical matching across different cutouts still requires source review. Saved manual layer suitability survives reimport. Metadata-only reimports preserve existing modeled images.

The database stores `modeledImages: [{id, mode, image}]` and keeps `modeledImage` as the first-image cover for compatibility. The side-panel carousel reads that image list. Validate the copied image count and one physical record per accepted item before declaring delivery complete.

Restart the dev server only if the running app does not pick up the database change, then verify the new item count at `/api/import/wardrobe` and visually inspect the gallery.

For cutout-only delivery, create the requested new child folder under the repository root and copy only accepted PNGs into it. Do not write the database.

## Finish

Return the imported count, skipped/held items, absolute database path, and gallery verification result. Display up to 12 final cutouts in chat. Mention any unrecoverable fragments briefly.
