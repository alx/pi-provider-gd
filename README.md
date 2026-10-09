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
- **OpenAI-compatible streaming** — requests go to `https://api.girard-davila.net/api/llm/v1/chat/completions` with tool-call, thinking, and streaming support via pi-ai's `openai-completions` transport.
- **Fallbacks** — `GD_API_KEY` env var is honored as an ambient credential; SSO login times out cleanly and re-running `/login gd` resumes.

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

A brand-new session that has no model yet is pointed at the default gd model automatically (default `qwen3.8-primary`, override with the `GD_DEFAULT_MODEL` env var, validated against the live catalog). If pi reports that the model catalog could not be refreshed, check that the machine can reach `https://api.girard-davila.net` (e.g. `curl -I https://api.girard-davila.net/api/llm/v1/models`) — an empty `gd` list is almost always a connectivity or key problem, not an empty proxy.

## How it works

- `extensions/index.ts` registers one native provider: `createGdProvider()` → `pi.registerProvider(...)`, and on `session_start` lands model-less sessions on the default gd model when a credential is stored.
- `src/provider.ts` builds the provider with `createProvider` (pi-ai) + `openAICompletionsApi()`; `auth.apiKey.login` offers pasting a key or the SSO browser flow, `fetchModels` polls `/v1/models` with the resolved key (strict: network/auth failures surface as refresh errors; limits lookup stays best-effort).
- `src/core.ts` holds the pure, testable logic: SSO start/poll (`/sso/cli/start`, `/sso/cli/poll/{id}` with the `x-litellm-cli-poll-secret` header), model listing, auth.json read/store.
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
