import assert from "node:assert/strict";
import { computeCost } from "./import-job-api.mjs";

// gpt-image-2: 1000 text-in @ $5/M + 2000 image-in @ $10/M + 4000 out @ $40/M
assert.equal(
  computeCost("gpt-image-2", { input_tokens: 3000, output_tokens: 4000, input_tokens_details: { image_tokens: 2000 } }),
  (1000 * 5 + 2000 * 10 + 4000 * 40) / 1e6,
);
// dated snapshot resolves by prefix
assert.equal(computeCost("gpt-5.4-mini-2026-01-01", { input_tokens: 1_000_000, output_tokens: 0 }), 0.25);
// unknown model or missing usage → null, never a fake number
assert.equal(computeCost("some-future-model", { input_tokens: 10 }), null);
assert.equal(computeCost("gpt-image-2", undefined), null);
console.log("usage-cost checks passed");
