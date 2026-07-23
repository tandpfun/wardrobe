// Shared demo wardrobe + outfit definitions and garment-cutout drawing, used by
// both the local filesystem seeder (`seed-demo.mjs`) and the static/browser
// deployment seeder (`seed-demo-static.mjs`). Every asset is drawn locally with
// `sharp`; no model or network call is involved.
import sharp from "sharp";

// Stable ids keep outfit -> garment references intact across reseeds.
export const GARMENTS = [
  { id: "import-demo-0000-0000-0000-000000000001", name: "Ecru Cotton Tee", part: "upperbody", color: "#e7e0d2", tags: ["cotton", "casual", "crewneck"], shape: "tee" },
  { id: "import-demo-0000-0000-0000-000000000002", name: "Faded Indigo Tee", part: "upperbody", color: "#3f4d6b", tags: ["cotton", "relaxed"], shape: "tee" },
  { id: "import-demo-0000-0000-0000-000000000003", name: "Olive Overshirt", part: "wholebody_up", color: "#5c5a3a", tags: ["cotton", "layer", "utility"], shape: "jacket" },
  { id: "import-demo-0000-0000-0000-000000000004", name: "Camel Wool Coat", part: "wholebody_up", color: "#b08a54", tags: ["wool", "outer", "tailored"], shape: "jacket" },
  { id: "import-demo-0000-0000-0000-000000000005", name: "Charcoal Trousers", part: "lowerbody", color: "#3a3a3c", tags: ["wool", "tapered"], shape: "trousers" },
  { id: "import-demo-0000-0000-0000-000000000006", name: "Stone Chinos", part: "lowerbody", color: "#c9bfa5", tags: ["cotton", "straight"], shape: "trousers" },
  { id: "import-demo-0000-0000-0000-000000000007", name: "White Leather Sneakers", part: "shoes", color: "#efe9dd", tags: ["leather", "minimal"], shape: "shoes" },
  { id: "import-demo-0000-0000-0000-000000000008", name: "Tan Suede Boots", part: "shoes", color: "#9c7748", tags: ["suede", "chelsea"], shape: "shoes" },
];

export const OUTFITS = [
  {
    id: "camel-neutral-layer",
    name: "Camel Neutral Layer",
    occasion: ["smart-casual", "weekend"],
    styleDirection: "Warm neutral tailoring with a relaxed drape.",
    reason: "Camel coat over an ecru tee keeps the palette tonal while the charcoal trousers ground it.",
    setting: "a quiet warm-stone courtyard with restrained greenery",
    garmentIds: [
      "import-demo-0000-0000-0000-000000000001",
      "import-demo-0000-0000-0000-000000000004",
      "import-demo-0000-0000-0000-000000000005",
      "import-demo-0000-0000-0000-000000000008",
    ],
  },
  {
    id: "indigo-olive-utility",
    name: "Indigo & Olive Utility",
    occasion: ["casual", "everyday"],
    styleDirection: "Muted cool-warm contrast with an easy utility edge.",
    reason: "Faded indigo under an olive overshirt reads relaxed; stone chinos and white sneakers lighten it.",
    setting: "a sunlit concrete walkway with soft afternoon shadows",
    garmentIds: [
      "import-demo-0000-0000-0000-000000000002",
      "import-demo-0000-0000-0000-000000000003",
      "import-demo-0000-0000-0000-000000000006",
      "import-demo-0000-0000-0000-000000000007",
    ],
  },
  {
    id: "clean-monochrome-basics",
    name: "Clean Monochrome Basics",
    occasion: ["everyday", "minimal"],
    styleDirection: "Pared-back light-on-dark with no visual noise.",
    reason: "An ecru tee and charcoal trousers is the simplest reliable base; white sneakers keep it fresh.",
    setting: "a bright minimal studio corner with a warm paper backdrop",
    garmentIds: [
      "import-demo-0000-0000-0000-000000000001",
      "import-demo-0000-0000-0000-000000000005",
      "import-demo-0000-0000-0000-000000000007",
    ],
  },
];

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function shade(hex, delta) {
  const { r, g, b } = hexToRgb(hex);
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r + delta, g + delta, b + delta].map((channel) => clamp(channel).toString(16).padStart(2, "0")).join("")}`;
}

// Draw a simple, recognizable flat garment silhouette as a transparent PNG so
// the demo wardrobe has real cutouts to show and compose.
function garmentSvg({ color, shape }) {
  const outline = shade(color, -34);
  const size = 1024;
  const body = {
    tee: `<path d="M312 300 L392 232 Q512 300 632 232 L712 300 L672 404 L616 372 L616 800 L408 800 L408 372 L352 404 Z" />`,
    jacket: `<path d="M300 292 L404 232 Q512 300 620 232 L724 292 L690 430 L636 400 L636 812 L512 812 L512 420 L512 812 L388 812 L388 400 L334 430 Z" /><line x1="512" y1="300" x2="512" y2="812" stroke="${outline}" stroke-width="6" />`,
    trousers: `<path d="M392 320 L632 320 L648 812 L548 812 L512 452 L476 812 L376 812 Z" />`,
    shoes: `<path d="M300 604 Q300 560 356 560 L452 560 Q476 620 560 648 L700 688 Q724 700 724 724 L724 760 L300 760 Z" />`,
  };
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<g fill="${color}" stroke="${outline}" stroke-width="8" stroke-linejoin="round">`
    + (body[shape] || body.tee)
    + `</g></svg>`,
  );
}

export async function garmentPng(garment) {
  return sharp(garmentSvg(garment)).png().toBuffer();
}
