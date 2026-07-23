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

// Data mode is chosen at build time. The default ("server") talks to the Vite
// middleware backend over HTTP. The "browser" build (VITE_DATA_MODE=browser,
// used for static hosts like Vercel where no backend runs) routes the same
// `/api/import/...` requests to an in-browser adapter backed by a bundled demo
// bundle + localStorage. See src/data-browser.js.
export const DATA_MODE = import.meta.env.VITE_DATA_MODE === "browser" ? "browser" : "server";

// Dispatched on the window whenever a server request comes back 401, so the
// auth gate can drop the user back to the login screen without every caller
// needing to handle it.
export const UNAUTHORIZED_EVENT = "wardrobe:unauthorized";

// Single entry point for all app data requests. Callers use the same
// `/api/import/...` paths regardless of mode; only the transport differs.
export async function apiFetch(path, options) {
  if (DATA_MODE === "browser") {
    const { handleBrowserRequest } = await import("./data-browser.js");
    return handleBrowserRequest(path, options);
  }
  const response = await fetch(apiUrl(path), { credentials: "same-origin", ...options });
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return response;
}
