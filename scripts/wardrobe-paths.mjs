import path from "node:path";
import { loadEnv } from "vite";

// Agent tools and the development app must resolve the same local wardrobe.
export function resolveWardrobeDataDir(repo = process.cwd(), explicitValue) {
  const root = path.resolve(repo);
  const configured = explicitValue || process.env.WARDROBE_DATA_DIR
    || loadEnv("development", root, "WARDROBE_").WARDROBE_DATA_DIR || "data";
  return path.resolve(root, configured);
}
