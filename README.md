# pi-provider-gd

A **native `gd` provider** for [api.girard-davila.net](https://api.girard-davila.net) for the [pi coding agent](https://github.com/badlogic/pi-mono). One install, one command, zero hand-editing.

```
pi install git:github.com/alx/pi-provider-gd
/login gd
/model
```

## Features

- **Self-contained** — no `pi-provider-litellm`, no other installs. `pi-provider-gd` registers its own native pi provider (`createProvider` + OpenAI-compatible streaming from `@earendil-works/pi-ai`).
- **Native `/login gd`** — pick how to sign in:
  - **Paste API key** — paste a key created at [https://api.girard-davila.net/api/llm/ui/](https://api.girard-davila.net/api/llm/ui/).
  - **Sign in with GitHub (browser SSO)** — a browser opens, you sign in with GitHub, the proxy issues a key.
  Either way pi stores the key in `~/.pi/agent/auth.json` under `gd`. No manual key handling. If the SSO endpoint is unreachable (offline, firewall, …) the flow falls back to pasting the key instead of failing.
- **`gd/<model-id>`** — models surface under the `gd` provider id in `/model` and `/login`, refreshed live from the proxy's `/v1/models`. No pi restart needed.
- **Sensible default model** — a new session with no model selected automatically lands on the default gd model (first live model, or `GD_DEFAULT_MODEL` if you set it) once a credential exists. No "no model" dead-end after install + login.
- **Honest failures** — if the proxy is unreachable or the key is rejected, `/model` refresh surfaces an error ("model discovery request failed … check network connectivity to the proxy") instead of silently showing zero models.
- **`/gd-doctor`** — in-pi diagnostics: shows the exact cause when a catalog refresh fails (credential state, network error, HTTP status, model list), since pi's `/model` screen hides the underlying error.
- **OpenAI-compatible streaming** — requests go to `https://api.girard-davila.net/api/llm/v1/chat/completions` with tool-call, thinking, and streaming support via pi-ai's `openai-completions` transport.
- **Fallbacks** — `GD_API_KEY` env var is honored as an ambient credential; SSO login times out cleanly and re-running `/login gd` resumes.
- **GPU overflow control** — `/gd-gpu-on [params]` / `/gd-gpu-off [instance_id]` / `/gd-gpu` status, `gd_deploy_gpu`/`gd_gpu_model` tools, and a live `[gd <ledger €> ●● <burn €/h>]` powerline footer (`/gd-footer on`). See below.

## GPU overflow: `/deploy-gpu` + powerline footer

The proxy's dedicated GPU is primary; a rented VAST.ai 3090 is the overflow ("slow mode"), routed through the same LiteLLM group. This package drives the rental end-to-end:

- **`/deploy-gpu [max $/hr]`** (prompt template) — checks the gd VAST user's money (balance **and** credit — either one pays), reuses a running instance or launches one via `vast/scripts/launch.py` (datacenter-only by default; a cold launch takes 10–20 min including the model download), waits until the model is loaded, then switches **this pi session** to `gd/qwen3.8-primary` — the LiteLLM group that includes the VAST overflow row — and finishes. A settle beep (pi-beep) marks readiness.
- **`gd_deploy_gpu` / `gd_gpu_model`** — the same as tools, for agents.
- **`/gd-gpu-on [standard|premium] [--price <max $/hr>] [--home-ok]`** — creates a VAST GPU instance with sensible defaults (datacenter-only, no price cap = top candidate rate, reuses a running instance, $1.00 min-balance floor). Tier: `standard` = RTX 3090 24 GB (default, `$VAST_TIER` wins), `premium` = RTX 5090 32 GB. Runs detached (10–20 min) and messages back when READY. `--home-ok` is a test-only override allowing non-datacenter hosts.
- **`/gd-gpu-off [instance_id]`** — destroys the instance (stops billing) and blocks the litellm VAST row (down first). No id = the current instance from state/label.
- **`/gd-gpu`** — status: ledger money, VAST account (balance + credit), running instances with burn rate, local state, and what the footer is showing.

**Powerline footer segment** (via the bundled `pi-powerline-footer` dependency) — run **`/gd-footer on`** once; the bar then shows, e.g.:

```
gd 8.22€ ● 0.23€/h
gd -0.00€ ●● 0.68€/h
gd 8.22€ !
```

- **money** = the api.girard-davila.net **ledger** of your gd customer key (LiteLLM `/key/info`): `budget − spend` when a budget is set (red under 10%), or `−spend` in grey when the key has no budget. Never raw VAST funds.
- **● per VAST GPU** — the dot tracks the GPU readiness lifecycle: **yellow** = launch started, waiting for a GPU (offer/creation); **grey** = instance up, model downloading/loading; **green** = ready (model loaded, serving); **red** = last launch failed (or the failed instance is still running and billing). Multiple servers: dots and burn aggregate over *all* running VAST instances, plus synthetic dots for waiting/failed states driven by `state/launching.json` and `state/last_failure.json`.
- **burn** = summed $/h of the running instances; turns **red** when a burn alert is active.
- **burn alerts** (read-only, they never tear anything down):
  - **`⏱x.xh`** (red) = the tracked instance has been rented for **≥ 3 h** (uptime from `state/current.json` `launched_at`).
  - **`⚠x.xh`** (red) = remaining VAST money (balance + credit) buys **less than one workday of work** at the current burn: `money ÷ (burn × GD_DAY_HOURS) < 1`. `GD_DAY_HOURS` defaults to **8**, env-overridable. The number is hours of work left.
- **`!`** (red) = last refresh failed (stale data still shown if any).

`/gd-footer off|status` manage it; the entry is `powerline.customItems` in `~/.pi/agent/settings.json` (id `gd-gpu`, `selfColorize`). Polling is 30 s, best-effort, and silent when no VAST/ledger credentials are present.

## Install

```bash
pi install git:github.com/alx/pi-provider-gd
```

That's the only step. Restart pi (or `/reload`) if you installed it mid-session.

## Log in

Run `/login gd` in pi's interactive mode and pick **api.girard-davila.net**. Choose **Paste API key** (enter a key created at the proxy's [UI](https://api.girard-davila.net/api/llm/ui/)) or **Sign in with GitHub** (a browser opens → sign in → the issued key is polled). Either way the key appears stored in the terminal. Then:

```
/model
```

Pick any `gd/<model-id>`.

A brand-new session that has no model yet is pointed at the default gd model automatically (default `qwen3.8-primary`, override with the `GD_DEFAULT_MODEL` env var, validated against the live catalog). If pi reports that the model catalog could not be refreshed (`Could not refresh gd; showing cached models`), run **`/gd-doctor`** in pi — it reports the exact cause (missing credential, network failure, HTTP error, or the model list), since pi's `/model` screen hides the underlying error. As a shell check, verify the machine can reach the proxy at all:

```
curl -I https://api.girard-davila.net/api/llm/v1/models
```

A failure there means a connectivity/VPN problem on that machine, not a pi problem. `/gd-doctor` includes the exact failure and a contact for the maintainer (Alexandre Girard, <git@alexgirard.com>) — include its output when reporting a problem.

## How it works

- `extensions/index.ts` registers one native provider: `createGdProvider()` → `pi.registerProvider(...)`, and on `session_start` lands model-less sessions on the default gd model when a credential is stored.
- `src/provider.ts` builds the provider with `createProvider` (pi-ai) + `openAICompletionsApi()`; `auth.apiKey.login` offers pasting a key or the SSO browser flow, `fetchModels` polls `/v1/models` with the resolved key (strict: network/auth failures surface as refresh errors; limits lookup stays best-effort).
- `src/core.ts` holds the pure, testable logic: SSO start/poll (`/sso/cli/start`, `/sso/cli/poll/{id}` with the `x-litellm-cli-poll-secret` header), model listing, auth.json read/store.
- `src/gpu.ts` holds the VAST orchestration: balance gate (`decideBalance` — balance **or** credit pays), running-instance reuse, `scripts.launch` spawn with progress, READY from `state/current.json`. `src/gpu-status.ts` holds the footer: ledger lookup (`/key/info`), instance polling (v1 API), and the ANSI `formatGdStatus` renderer. Keys come from `vast/config.env` (`VAST_API_KEY`, `LITELLM_OPS_KEY`) next to the launcher.
- Credentials live in `~/.pi/agent/auth.json` under `gd` — the same file pi uses for every provider.

## Testing

```bash
npm install
npm test          # node --test, hermetic (globalThis.fetch stubbed)
npx tsc --noEmit  # type-check src + extension + tests
```

CI (`.github/workflows/ci.yml`) runs both on every push/PR.

## Endpoint

- Proxy root: `https://api.girard-davila.net/api/llm` (OpenAI-compatible `/v1/*`)
- SSO page: `https://api.girard-davila.net/auth/sso`

## License

MIT
