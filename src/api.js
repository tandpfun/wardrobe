// Centralized API URL construction.
//
// Locally (`npm run dev` / `npm run preview`) the backend is same-origin, so
// requests go to `/api/import/...` unchanged. When `dist` is hosted from a
// nested URL (e.g. sites.pplx.app/.../dist/index.html), the deploy pipeline
// rewrites the literal token below to the proxy prefix that reaches the
// backend running on port 4173. If the token is still present, we are running
// locally and use no prefix.
const DEPLOY_PROXY_TOKEN = "__PORT_4173__";

function resolvePrefix() {
  const token = DEPLOY_PROXY_TOKEN;
  // Untouched token => local dev/preview => same-origin, no prefix.
  if (token.startsWith("__PORT_")) return "";
  return token.replace(/\/+$/, "");
}

export const API_PREFIX = resolvePrefix();

// Prefix only root-relative paths ("/api/...", "/_ipx/..."). Absolute URLs and
// data:/blob: sources are returned untouched.
export function apiUrl(path) {
  if (typeof path !== "string" || path[0] !== "/") return path;
  return `${API_PREFIX}${path}`;
}
