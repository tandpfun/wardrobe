// Centralized API URL construction.
//
// Locally (`npm run dev` / `npm run preview`) the backend is same-origin, so
// requests go to `/api/import/...` unchanged. When `dist` is hosted from a
// nested URL (e.g. sites.pplx.app/.../dist/index.html), the deploy pipeline
// rewrites the literal token below to the proxy prefix that reaches the
// backend running on port 4173. If the token is still present, we are running
// locally and use no prefix.
const DEPLOY_PROXY_TOKEN = "__PORT_4173__";

// Untouched token => local dev/preview => same-origin, no prefix. Otherwise the
// token was rewritten to the proxy prefix; strip any trailing slash so joins
// don't double up.
export function normalizePrefix(token) {
  if (typeof token !== "string" || token.startsWith("__PORT_")) return "";
  return token.replace(/\/+$/, "");
}

// Prefix only root-relative paths ("/api/...", "/_ipx/..."), preserving any
// query string. Absolute URLs and data:/blob: sources are returned untouched,
// so re-applying the helper to an already-prefixed value is a no-op.
export function joinApiPath(prefix, path) {
  if (typeof path !== "string" || path[0] !== "/") return path;
  return `${prefix}${path}`;
}

export const API_PREFIX = normalizePrefix(DEPLOY_PROXY_TOKEN);

export function apiUrl(path) {
  return joinApiPath(API_PREFIX, path);
}
