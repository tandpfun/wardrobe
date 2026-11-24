<div align="center">

# Wardrobe

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

あなたの服を gpt-image で抽出し、整理します。

[![ライセンス：MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[元の投稿を見る →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe ギャラリー](docs/screenshots/gallery.png)

![モデル着用イメージ付き Wardrobe エディター](docs/screenshots/editor.png)

## クイックスタート

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ `OPENAI_API_KEY` を `.env` に追加し、自分の PNG 参照写真を `data/model-reference.png` に配置するまで、インポーターは無効のままです。

[localhost:5173](http://localhost:5173) を開きます。

## Codex でインポート

このリポジトリには 2 つの Codex スキルが含まれています。1 つは服をインポートしてモデル着用の商品写真を生成し、もう 1 つはコーディネート一式を組んでモデル着用のルックブックを生成します。

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

クローンしたリポジトリを Codex で開き、どちらかのプロンプトを実行します。インポートスキルは、必要に応じてローカルのモデル参照 PNG を求め、切り抜きとモデル着用写真をすべて確認してから、`data/library.json` と `data/imported/` に書き込みます。コーディネートスキルは作成するルック数を尋ね、選定、生成、検証を行い、完成したコレクションを `data/` 配下に保存します。

### エージェント向け

ユーザーのために Wardrobe をセットアップする場合は、服をどのようにインポートしたいか確認してください。

- **Codex：** フォルダーまたはカメラロールの場所とモデル参照 PNG を求め、[同梱のインポートスキル](.agents/skills/import-clothes/SKILL.md)に従って各アイテムを抽出し、モデル着用イメージを生成してインポートします。その後、[コーディネート生成スキル](.agents/skills/generate-outfits/SKILL.md)で指定された数のモデル着用ルックを作成することを提案します。
- **Web UI：** ユーザー自身の `OPENAI_API_KEY` と `data/model-reference.png` の設定を支援し、アプリからインポートしてもらいます。

## 機能

- OpenAI Responses API で写真内のすべての衣類を検出
- OpenAI Images API で背景のないきれいな商品画像を抽出
- 任意でモデル着用のエディトリアルプレビューを生成
- 元画像、ジョブ、生成画像、JSON データベースをローカルの `data/` に保存
- ドラッグ＆ドロップ、貼り付け、編集、レビュー、再生成、承認に対応

## 設定

| 変数 | デフォルト |
| --- | --- |
| `OPENAI_API_KEY` | 必須 |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

## ライセンス

[MIT](LICENSE)
