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

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and either place a PNG reference photo at `data/model-reference.png` or choose one through an optional Immich connection.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Optionally browses a rolling date window from Immich with smart search and explicit, bounded selection
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `OPENAI_OMIT_IMAGE_OUTPUT_FORMAT` | `false` |
| `IMMICH_BASE_URL` | Optional; for example `https://photos.example.com` |
| `IMMICH_API_KEY_FILE` | `.secrets/immich-api-key` |
| `IMMICH_YEARS` | `4` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

### Immich photo picker

Create a dedicated Immich API key with only `asset.read`, `asset.view`, and `asset.download`, save the raw key in the gitignored path configured by `IMMICH_API_KEY_FILE`, and set `IMMICH_BASE_URL`. Wardrobe then offers smart search and recent browsing over a rolling `IMMICH_YEARS` window.

The integration does not bulk-process the library. It proxies thumbnails and Immich-transcoded processing previews on demand, stores only the reference portrait you explicitly choose, and limits outfit imports to five selected photos per batch. Immich originals are never modified.

Wardrobe itself does not provide user authentication. Keep it on localhost or a trusted network, or place it behind an authenticated reverse proxy before exposing the Immich picker to other networks.

## License

[MIT](LICENSE)
