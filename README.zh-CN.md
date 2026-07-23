<div align="center">

# Wardrobe

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

使用 gpt-image 提取并整理你的衣物。

[![许可证：MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[查看原始帖子 →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe 衣橱图库](docs/screenshots/gallery.png)

![模特衣橱编辑器](docs/screenshots/editor.png)

## 快速开始

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ 在你将 `OPENAI_API_KEY` 添加到 `.env`，并把自己的 PNG 参考照片放在 `data/model-reference.png` 之前，导入功能会一直处于禁用状态。

打开 [localhost:5173](http://localhost:5173)。

## 使用 Codex 导入

本仓库包含两个 Codex 技能：一个用于导入衣物并生成模特展示图，另一个用于搭配完整造型并生成模特造型册。

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

在 Codex 中打开克隆后的仓库，然后运行其中任一提示词。导入技能会在需要时要求提供一张本地模特参考 PNG，审查每张抠图和模特展示图，再将结果写入 `data/library.json` 和 `data/imported/`。造型技能会询问要创建多少套造型，然后完成挑选、生成和验证，并将完整集合保存到 `data/` 下。

### 供智能体使用

如果你正在为用户设置 Wardrobe，请询问他们希望如何导入衣物：

- **Codex：** 要求用户提供一个文件夹或相机胶卷位置以及一张模特参考 PNG，然后按照[内置导入技能](.agents/skills/import-clothes/SKILL.md)提取、生成模特展示图并导入单件衣物。完成后，主动询问是否要使用[造型生成技能](.agents/skills/generate-outfits/SKILL.md)创建用户指定数量的模特造型。
- **Web UI：** 帮助用户配置自己的 `OPENAI_API_KEY` 和 `data/model-reference.png`，然后让他们通过应用导入。

## 功能

- 使用 OpenAI Responses API 检测照片中的每件衣物
- 使用 OpenAI Images API 提取干净的商品抠图
- 生成可选的模特风格编辑预览图
- 将原始文件、任务、生成的图片和 JSON 数据库保存在本地 `data/` 中
- 支持拖放、粘贴、编辑、审查、重新生成和批准

## 配置

| 变量 | 默认值 |
| --- | --- |
| `OPENAI_API_KEY` | 必填 |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

## 许可证

[MIT](LICENSE)
