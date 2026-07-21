import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/import-flow.jsx", import.meta.url), "utf8");
const required = [
  '"Choose reference from Immich"',
  'openImmich("reference")',
  '<button className="import-tray__label"',
  'aria-label={setupRequired && immich?.ready ? "Choose reference from Immich"',
  'immich?.years || 4',
  'fetch(asset.imageUrl)',
];
for (const marker of required) {
  if (!source.includes(marker)) throw new Error(`Missing Immich setup entry-point marker: ${marker}`);
}
if (source.includes('<span className="import-tray__label">')) {
  throw new Error("Setup label is still non-interactive");
}
if (source.includes("Codex OAuth provider")) {
  throw new Error("Setup instructions mention an OAuth flow that is not part of this repository");
}
console.log("immich_setup_entrypoint=ok");
