<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes Codex skills to import clothes and generate complete outfits.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run a prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

The original **Tops, Jackets, Bottoms, Accessories and Shoes** categories stay unchanged. AI prepopulates **Can wear as a layer** independently of category during import, using the piece’s construction, weight and fit. Casual flannels, textured shirts and zip-up jackets can qualify; uncertain cases default to false. You can edit this choice, and saved manual choices take precedence on reimport. When modeled previews are requested, a layerable piece gets exactly two images—its normal presentation and a layered look—and other pieces get one. Hover over the side-panel photo to reveal arrows, or use the focused carousel's keyboard controls, to browse the pair. Each physical piece still counts as one wardrobe item.

For an existing piece with one accepted modeled photo, save **Can wear as a layer**, then choose **Create layer look**. Wardrobe keeps the accepted normal photo and generates only the missing layered view for review, without reimporting the piece.

Complete outfits use thoughtful menswear styling: fit, proportion, color, texture and occasion guide the choice of actual wardrobe inner pieces, including T-shirts or hoodies when appropriate.

### Regenerate and give feedback

Modeled clothing previews and complete outfits support **Regenerate** and image-specific thumbs up/down with a comment. After a successful regeneration, **Undo** remains available for one minute, including after a page reload. Reverting restores the previous image without deleting the new version. Every generated version and its available prompt/context stay in `data/photo-history/`, alongside ratings, comments, regeneration and undo events.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates optional modeled editorial previews: two for a layerable piece, one for other pieces
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_MODEL_DIRECTION` | Optional modeled-photo styling direction |
| `WARDROBE_DATA_DIR` | `data` |

If `model-reference-2.png` and `model-reference-3.png` are beside the primary reference, modeled generation uses them for body proportions while the primary reference controls the face.

## License

[MIT](LICENSE)
