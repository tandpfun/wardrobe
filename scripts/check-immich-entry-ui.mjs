import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/import-flow.jsx", import.meta.url), "utf8");
const required = [
  '"Choose reference from Immich"',
  'openImmich("reference")',
  '<button className="import-tray__label"',
  'aria-label={setupRequired && immich?.ready ? "Choose reference from Immich"',
];
for (const marker of required) {
  if (!source.includes(marker)) throw new Error(`Missing Immich setup entry-point marker: ${marker}`);
}
if (source.includes('<span className="import-tray__label">')) {
  throw new Error("Setup label is still non-interactive");
}
console.log("immich_setup_entrypoint=ok");
