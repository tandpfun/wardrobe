// Frontend private-access gate for the deployed app.
//
// Only relevant in server data mode (the static "browser" demo build has no
// backend and no auth, so the gate is a no-op there and children render
// immediately). On load we ask the backend whether a session exists; if auth
// is configured but we are not signed in, we show a passcode login screen. A
// 401 from any later API call flips us back to the login screen via a window
// event dispatched from apiFetch.

import React, { useCallback, useEffect, useState } from "react";
import { DATA_MODE, apiUrl, UNAUTHORIZED_EVENT } from "./api.js";

async function fetchSession() {
  const response = await fetch(apiUrl("/api/auth/session"), { credentials: "same-origin" });
  if (!response.ok) {
    // No auth layer in front of us (e.g. local Vite middleware) — treat as open.
    return { authenticated: true, configured: false, unavailable: true };
  }
  return response.json();
}

async function postLogin(passcode) {
  const response = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ passcode }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* ignore body parse errors */
  }
  return { ok: response.ok, status: response.status, error: data.error };
}

export async function logout() {
  try {
    await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "same-origin" });
  } catch {
    /* best-effort */
  }
}

function LoginScreen({ onAuthenticated }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !passcode) return;
    setBusy(true);
    setError(null);
    const result = await postLogin(passcode);
    setBusy(false);
    if (result.ok) {
      setPasscode("");
      onAuthenticated();
    } else if (result.status === 429) {
      setError("Too many attempts. Wait a moment and try again.");
    } else {
      setError(result.error || "Incorrect passcode.");
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">Wardrobe</h1>
        <p className="auth-subtitle">Enter the app passcode to continue.</p>
        <input
          type="password"
          className="auth-input"
          value={passcode}
          onChange={(event) => setPasscode(event.target.value)}
          placeholder="Passcode"
          autoFocus
          autoComplete="current-password"
          aria-label="App passcode"
        />
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <button type="submit" className="primary-button auth-submit" disabled={busy || !passcode}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

export function AuthGate({ children }) {
  // Browser demo build: no backend, never gate.
  const [state, setState] = useState(() => (DATA_MODE === "browser" ? "authed" : "loading"));

  const refresh = useCallback(async () => {
    try {
      const session = await fetchSession();
      setState(session.authenticated ? "authed" : "login");
    } catch {
      setState("login");
    }
  }, []);

  useEffect(() => {
    if (DATA_MODE === "browser") return;
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (DATA_MODE === "browser") return undefined;
    const onUnauthorized = () => setState("login");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (state === "loading") {
    return <div className="auth-screen"><div className="auth-card auth-loading">Loading…</div></div>;
  }
  if (state === "login") {
    return <LoginScreen onAuthenticated={() => setState("authed")} />;
  }
  return children;
}
