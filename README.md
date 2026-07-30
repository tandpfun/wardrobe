<div align="center">

# Wardrobe

Your clothes, extracted and organized with Claude and OpenAI.

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

⚠️ The importer stays disabled until you add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

- Get an Anthropic API key (pay-as-you-go, separate from a Claude Pro/Max subscription) at [console.anthropic.com](https://console.anthropic.com).
- Get an OpenAI API key (pay-as-you-go) at [platform.openai.com](https://platform.openai.com/api-keys).

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
- **Web UI:** Help the user configure their own `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the Claude Messages API (vision + structured output)
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview with OpenAI
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required |
| `ANTHROPIC_VISION_MODEL` | `claude-opus-5` (use `claude-haiku-4-5` for a much cheaper/faster option) |
| `OPENAI_API_KEY` | Required |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

## License

[MIT](LICENSE)
