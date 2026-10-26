#!/usr/bin/env node
/**
 * SSO flow verifier for pi-provider-gd  (org-gxn.4 / org-wfx.2)
 *
 * End-to-end verification of the `/login gd` browser-SSO flow against the
 * CUSTOMER GATEWAY (provider.girard-davila.net, org-gxn.18.5), runnable from
 * Windows PowerShell, macOS, or Linux. NO build step and NO dependencies -
 * plain Node >= 18 (global fetch). It reproduces exactly what pi does, and
 * then VALIDATES the issued key against the LiteLLM proxy, so a green run
 * proves the flow.
 *
 * Usage (PowerShell):
 *     node .\scripts\sso-verify.mjs
 *     node .\scripts\sso-verify.mjs --provider https://provider.girard-davila.net
 *     node .\scripts\sso-verify.mjs --seconds 300 --no-open
 *
 * Steps + what to do:
 *   1. starts a CLI device-flow session (POST /api/cli/start, anonymous)
 *   2. prints + opens the verification URL -> sign in with GOOGLE (the gateway
 *      bounces you through its own SSO); the /verify page confirms
 *   3. polls /api/cli/poll/{id} (poll-secret header) until the key is issued
 *   4. VALIDATES the key against the proxy: GET /v1/models + a tiny completion
 *   5. prints PASS/FAIL and exits 0 / non-zero
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.split("=").slice(1).join("=") : def;
};
const BASE = (opt("--provider", process.env.GD_PROVIDER_URL || "https://provider.girard-davila.net")).replace(/\/+$/, "");
const PROXY = (opt("--proxy", process.env.GD_PROXY_URL || "https://api.girard-davila.net/api/llm")).replace(/\/+$/, "");
const SECONDS = parseInt(opt("--seconds", "300"), 10);
const OPEN = !args.includes("--no-open");
const POLL_MS = 3000;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);
const ok = (m) => console.log(`[${ts()}] \x1b[32mOK\x1b[0m   ${m}`);
const bad = (m) => console.log(`[${ts()}] \x1b[31mFAIL\x1b[0m ${m}`);
const step = (m) => console.log(`\n[${ts()}] == ${m} ==`);

function openBrowser(url) {
  if (!OPEN) return;
  try {
    // Windows: use rundll32 (passes the URL as ONE argv, so '&' in the query is
    // NOT split by cmd - `cmd /c start "" <url>` drops everything after '&',
    // which silently lost key/user_code and caused 'Invalid CLI login session id').
    const [file, ...a] =
      process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    spawn(file, a, { stdio: "ignore", detached: true }).unref();
    ok("opened the verification URL in your browser");
  } catch (e) {
    log(`could not auto-open (${e.message}) - open the URL above manually (copy it exactly)`);
  }
}

async function main() {
  console.log(`SSO verifier  provider=${BASE}  proxy=${PROXY}`);
  step("1/4  start CLI device-flow session (POST /api/cli/start)");
  let start;
  {
    const res = await fetch(`${BASE}/api/cli/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    if (res.status !== 200) { bad(`/api/cli/start HTTP ${res.status}: ${text.slice(0, 200)}`); return 1; }
    start = JSON.parse(text);
    if (!start.login_id || !start.poll_secret) { bad(`unexpected /api/cli/start body: ${text.slice(0, 200)}`); return 1; }
    ok(`login_id=${start.login_id}`);
    ok(`user_code=${start.user_code || "(none)"}`);
  }

  const url =
    (typeof start.verification_uri_complete === "string" && start.verification_uri_complete.length > 0)
      ? start.verification_uri_complete
      : `${BASE}/verify?login_id=${encodeURIComponent(start.login_id)}&user_code=${encodeURIComponent(start.user_code || "")}`;

  step("2/4  sign in with GOOGLE in the browser");
  console.log(`\n   >>> OPEN: ${url}\n`);
  console.log("   Sign in with Google; the /verify page confirms the CLI login.\n");
  openBrowser(url);

  step("3/4  waiting for the issued key (poll /api/cli/poll/{id})");
  const deadline = Date.now() + SECONDS * 1000;
  let key = "";
  let n = 0;
  while (Date.now() < deadline && !key) {
    n++;
    try {
      const r = await fetch(`${BASE}/api/cli/poll/${encodeURIComponent(start.login_id)}`, {
        headers: { "poll-secret": start.poll_secret },
      });
      const body = await r.text();
      log(`poll#${n} HTTP ${r.status} ${body.slice(0, 140)}`);
      if (r.status === 404) { bad("login expired (600s TTL) - re-run the verifier"); return 2; }
      if (r.status === 403) { bad("poll secret rejected - re-run the verifier"); return 2; }
      if (r.ok) {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        if (j && j.status === "error") { bad(`gateway said error: ${j.error || "unknown"}`); return 3; }
        if (j && typeof j.key === "string" && j.key) { key = j.key; break; }
      }
    } catch (e) {
      log(`poll#${n} network error: ${e.message}`);
    }
    if (!key) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!key) { bad(`no key within ${SECONDS}s - did you press Confirm/Continue (and pick a team)?`); return 3; }
  ok(`key issued: ${key.slice(0, 8)}... (${key.length} chars)`);

  step("4/4  validate the key against the proxy");
  {
    const r = await fetch(`${PROXY}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.text();
    if (r.status !== 200) { bad(`GET /v1/models HTTP ${r.status}: ${body.slice(0, 200)}`); return 4; }
    let ids = [];
    try { ids = (JSON.parse(body).data || []).map((m) => m.id).slice(0, 5); } catch {}
    ok(`/v1/models OK - e.g. ${ids.join(", ") || "(no ids)"}`);

    const model = ids[0];
    if (model) {
      const c = await fetch(`${PROXY}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "reply with ok" }], max_tokens: 4 }),
      });
      const ct = await c.text();
      if (c.status === 200) ok(`chat OK via ${model}`);
      else log(`chat via ${model} -> HTTP ${c.status} (not fatal): ${ct.slice(0, 160)}`);
    }
  }

  console.log(`\n\x1b[32m== SSO VERIFY: PASS ==\x1b[0m  the /login gd browser flow works.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { bad(`unexpected error: ${e && e.stack ? e.stack : e}`); process.exit(1); });
