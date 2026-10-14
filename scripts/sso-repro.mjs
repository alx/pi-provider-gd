#!/usr/bin/env node
// SSO reproduction/debug for pi-provider-gd (org-gxn.4 / SSO login).
//
// Faithfully reproduces the /login gd SSO flow with verbose logging of EVERY
// /sso/cli/poll response, so the "auth ok in browser but terminal keeps
// waiting" bug can be diagnosed: if the server returns {key:...} -> the bug is
// in pi-provider-gd; if it keeps returning {status:"pending"} after a real
// Google login -> it's a server/LiteLLM CLI-SSO handoff issue.
//
// Run:  node scripts/sso-repro.mjs [--seconds N] [--no-open]
// It prints the browser URL, opens it if possible, then polls and logs.
import { spawn } from "node:child_process";

const BASE = "https://api.girard-davila.net/api/llm";
const sec = parseInt(process.argv.find((a) => a.startsWith("--seconds"))?.split("=")[1] ?? "180", 10);
const openBrowser = !process.argv.includes("--no-open");

const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

const t0 = Date.now();
try {
  const res = await fetch(`${BASE}/sso/cli/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const raw = await res.text();
  log(`START status=${res.status}`);
  log(`START body=${raw}`);
  const start = JSON.parse(raw);
  if (res.status !== 200 || !start.login_id || !start.poll_secret) throw new Error("bad /sso/cli/start");

  const url =
    start.verification_uri_complete?.length > 0
      ? start.verification_uri_complete
      : `${BASE}/sso/key/generate?` + new URLSearchParams({ source: "litellm-cli", key: start.login_id });
  log(`login_id=${start.login_id}  user_code=${start.user_code || "(none)"}  expires_in=${start.expires_in ?? "?"}`);
  log(`verification_uri_complete=${start.verification_uri_complete ?? "(none - using fallback)"}`);
  log(`BROWSER URL >>> ${url}`);

  if (openBrowser) {
    try {
      // Windows: rundll32 passes the URL as ONE argv, so '&' in the query is
      // not split by cmd (cmd /c start "" <url> drops key/user_code after '&').
      const [file, ...a] =
        process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : process.platform === "darwin"
            ? ["open", url]
            : ["xdg-open", url];
      spawn(file, a, { stdio: "ignore", detached: true }).unref();
    } catch { /* no opener - user opens the printed URL */ }
  }

  const deadline = Date.now() + sec * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    i++;
    try {
      const r = await fetch(`${BASE}/sso/cli/poll/${encodeURIComponent(start.login_id)}`, {
        headers: { "x-litellm-cli-poll-secret": start.poll_secret },
      });
      const text = await r.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      log(`POLL#${i} status=${r.status} elapsed=${Math.round((Date.now() - t0) / 1000)}s body=${JSON.stringify(body)}`);
      if (r.status === 400) { log("EXPIRED/INVALID - the login is not being satisfied"); break; }
      if (body && typeof body.key === "string" && body.key) { log(`GOT KEY >>> ${body.key}`); break; }
    } catch (e) {
      log(`POLL#${i} network-err ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (Date.now() >= deadline) log("TIMEOUT - no key within window");
} catch (e) {
  log("FATAL " + e.message);
}
