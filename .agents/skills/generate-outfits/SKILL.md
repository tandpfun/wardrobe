---
name: generate-outfits
description: Curate complete outfits from the local Wardrobe database and generate identity-preserving square modeled photos for every selected look end to end. Use when a user asks Codex for outfit ideas, combinations, looks, styling suggestions, a lookbook, or modeled outfit images based on clothes already imported into this Wardrobe.
---

# Generate Outfits

Create a complete local outfit collection: select strong combinations, generate a square modeled image for each, verify every result, and save the finished manifest and images in the configured local wardrobe directory.

## Begin with the count

Ask `How many outfits would you like me to generate?` unless the user already provided a positive count. Do not choose a default silently.

Preserve a count or range the user already authorized, including during corrections or regeneration. Item-preview pairs for layerable pieces do not increase the requested lookbook count.

Also obtain the intended season, occasions, dress codes, or styling direction when the user named them. Otherwise create a balanced everyday mix without blocking on more questions.

Do the workflow end to end after receiving the count. Do not stop after returning suggestions, a manifest, or prompts.

## Requirements

- Read and follow the built-in `imagegen` skill before generating images.
- Resolve `$DATA` using [the shared directory instructions](../../../docs/image-history-for-agents.md#wardrobe-directory). Require `$DATA/library.json`, enough tops and bottoms for the requested count, and a local identity reference at `data/model-reference.png` or `WARDROBE_MODEL_REFERENCE`.
- Keep every source garment and identity image local and unchanged.
- Keep `$DATA`, the identity reference, garment images, and generated photos out of Git.
- Use only wardrobe items that exist in the current database and whose local assets resolve successfully.
- Generate exactly the requested number of unique outfits and exactly one accepted modeled photo for each.

## Parallel work

Use subagents when the user requests more than eight outfits or explicitly asks for parallel generation. Keep one main agent responsible for the complete wardrobe inventory, global combination uniqueness, garment-usage balance, manifest reconciliation, and final QA.

Assign each worker a disjoint set of outfit IDs plus the exact identity and garment reference paths. Require every worker to return the outfit ID, filled prompt, reference list, generated path, status, and visual-review notes. Never allow two workers to generate or write the same outfit ID. Run workers in waves when concurrency is limited, reconcile results after every wave, and resume only missing or failed IDs.

## 1. Inspect the wardrobe

Read `$DATA/library.json`. Resolve `/api/import/library/FILENAME` assets to `$DATA/imported/FILENAME`. Group items by:

- `upperbody` — tops
- `wholebody_up` — jackets and outer layers
- `lowerbody` — bottoms
- `accessories_up` — optional accessories
- `shoes` — optional shoes

Read `canLayer` and `layeringSource` independently of category and respect saved manual choices. A suitable item with `canLayer: true` may fill an outer-layer role while retaining its original category and physical ID. Do not assume every jacket qualifies or restrict layers to shirts. Older items without layer suitability remain in their normal role until assessed or edited.

Create checkerboard contact sheets of at most 12 garment cutouts and inspect them. Use both metadata and visual evidence; do not style from filenames or colors alone.

If the wardrobe cannot support the requested number of genuinely distinct outfits, tell the user the maximum useful count and ask whether to continue with that number.

## 2. Curate the combinations

Regeneration of an existing outfit keeps its exact selected pieces.

Each outfit must contain exactly one inner or standalone top and one bottom, with an optional suitable outer layer, shoes and restrained accessory. Style with the judgment of an experienced menswear stylist: choose combinations for their fit, proportion, color, texture and occasion. The aim is fashionable, well-balanced layering.

A layerable piece can appear in its normal role (`default`) or as an outer layer (`layer`) over a distinct, compatible inner piece from the wardrobe. An inner piece can be a T-shirt, hoodie or another appropriate top: match its bulk and neckline to the outer piece, and make both recognizable. Use only the garment’s real construction and closures. Keep one physical garment ID and select it at most once per outfit. Include layered and normal combinations where the available wardrobe and requested count support them.

- Favor tonal or analogous color harmony for cohesion.
- Use complementary contrast selectively and keep one color or garment dominant.
- Let one graphic, pattern, texture, or saturated piece carry the statement.
- Balance visual weight and silhouette: pair fuller bottoms with a cleaner top; keep heavier layers over a simple base.
- Use outer layers to frame the base look, repeat a present color, or add one controlled contrast.
- Keep layered looks physically plausible and make every selected garment visibly identifiable.
- Diversify garment usage instead of repeatedly leaning on the easiest neutral pieces.

Cover a useful mix of the user’s requested contexts. Without specific direction, balance casual, smart-casual, warm-weather, layered, dark-tonal, and statement looks as the wardrobe permits.

Build `$WORK/outfits.json` with the final target count:

```json
{
  "version": 1,
  "outfits": [
    {
      "id": "navy-camel-classic",
      "name": "Navy & Camel Classic",
      "occasion": ["smart-casual", "office"],
      "garmentIds": ["import-...", "import-..."],
      "garmentModes": [
        { "garmentId": "import-...", "role": "top", "mode": "default" },
        { "garmentId": "import-...", "role": "bottom", "mode": "default" }
      ],
      "reason": "Deep navy and camel create controlled warm-cool contrast.",
      "setting": "a quiet warm-stone courtyard with restrained greenery",
      "image": "outfit-images/navy-camel-classic.png",
      "status": "planned"
    }
  ]
}
```

Use stable lowercase hyphenated IDs and actual distinct wardrobe IDs in `garmentIds` and `garmentModes`. Record every garment's role and mode (`default` or `layer`); a layerable piece in the outer slot has `role: "outer"`, `mode: "layer"`. The sorted garment-ID/role/mode assignments define uniqueness, so the same piece in its normal and layered presentation can form different looks while renaming a combination cannot.

## 3. Prepare references and prompts

Create one generation package per outfit:

1. Identity reference
2. Exact top cutout
3. Exact bottom cutout
4. Optional exact outer layer
5. Optional exact shoes or accessory only when deliberately selected

The primary identity reference controls the face. If present, include `model-reference-2.png` and `model-reference-3.png` beside it for body proportions and apply the user's current model direction or configured `WARDROBE_MODEL_DIRECTION`. Otherwise preserve the identity proportions. When the tool's reference limit requires it, make a temporary labeled identity board with the untouched face and body references; keep every selected garment reference in the generation package.

Read [references/outfit-image-prompt.md](references/outfit-image-prompt.md) and fill its template from the exact outfit record. Follow [the shared image-history instructions](../../../docs/image-history-for-agents.md) to record the exact prompt/context and retain every generated attempt. Inspect every outer-layer reference before choosing the layered clause; never infer a zipper, buttons, placket, opening, or closure.

Use the recorded garment roles/modes explicitly: `default` is the normal presentation; `layer` places the piece over the exact selected inner top, keeping both visibly identifiable. A real button or zip opening may be open or partly open; pullovers remain closed. Keep true garment lengths, proportions and construction.

Rotate restrained warm, natural settings across the collection while keeping one cohesive editorial art direction.

## 4. Generate every outfit

Create one square 1:1 modeled PNG per outfit with Imagegen. Save each attempt to a fresh working filename outside `$DATA`; archive returned rejected or invalid images with their prompt/context before correcting them. Keep failed attempts inactive, and archive accepted outputs at delivery. Use the smallest valid set of references for each call and never omit a selected garment.

Generate in bounded batches when the collection is large. Track every outfit as `planned`, `generated`, `accepted`, or `failed`; resume only missing or failed IDs.

## 5. Verify and correct

Compare every output against the identity and all garment references. Inspect contact sheets of at most 12 modeled outfits, then open questionable images individually.

Require:

- recognizable identity, face, hair, age, build, and body proportions
- every selected garment present and recognizable
- exact garment color, material, fit, construction, graphics, logos, text, proportions, and closures
- complete head-to-shoes framing with readable outfit and realistic anatomy
- natural layering without invented openings or hidden inner pieces
- every piece in its recorded default or layer mode, with a visible distinct wardrobe inner top for layer mode
- no unselected visible garments except plain neutral shoes or invisible basics when no shoes were selected
- no extra person, text overlay, watermark, product mockup, or synthetic AI polish

Regenerate identity drift, missing or redesigned garments, fake closures or text, anatomy failures, or cropped feet. Do not mark an outfit accepted based on plausibility alone.

## 6. Deliver locally

After all requested outfits pass:

1. Archive every accepted outfit with `scripts/archive-modeled-photos.mjs`, `kind: "outfit"`, its stable outfit ID, `mode: "default"`, the exact prompt/context and `activate: true`, following [the shared image-history instructions](../../../docs/image-history-for-agents.md). The CLI preserves existing legacy current photos first.
2. Set each accepted outfit's `image` to the immutable `/api/import/photo-history/...png` URL returned for that attempt. Do not overwrite or delete an earlier outfit image.
3. Atomically write the exact requested current collection to `$DATA/outfits.json` under the shared library lock. All old versions and their feedback remain in the separate history ledger.
4. Reopen every archived current PNG and verify that current unique outfit IDs, accepted manifest records and requested count agree. Also verify failed attempts remain inactive.

Verify the outfit view after the manifest change. The current collection supports per-image regeneration and feedback while keeping every original generation and prompt unchanged.

## Finish

Report the requested and completed count, output paths, any regenerated failures, and the styling mix. Display up to 12 modeled outfits in chat and point the user to the local folder for the rest.
