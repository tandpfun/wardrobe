// Report whether the caller currently holds a valid session. Used by the
// frontend on load to decide between the login screen and the app. Never
// reveals the passcode or any secret; only a boolean and whether auth is
// configured at all.

import { isAuthenticated, authConfigured } from "../_lib/auth.mjs";
import { sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  const env = process.env;
  const configured = authConfigured(env);
  const authenticated = configured && isAuthenticated(req, env);
  return sendJson(res, 200, { authenticated, configured });
}
