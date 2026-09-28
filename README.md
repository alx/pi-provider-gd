# pi-provider-girard

One-command connect for the **api.girard-davila.net** LiteLLM endpoint from
[Pi](https://pi.dev): GitHub SSO login and the coding model, preset.

A thin preset layer over [`pi-provider-litellm`](https://www.npmjs.com/package/pi-provider-litellm) —
all model discovery, SSO login, token refresh, and auth storage come from that
package. This one adds the `/girard` command, which writes the proxy base URL
into Pi settings so login has nothing to fill in.

## Install

```bash
pi install npm:pi-provider-litellm            # dependency: provider + /login litellm
pi install git:github.com/alx/pi-provider-girard   # this package: the /girard preset
```

(Local dev: `pi install ./path/to/pi-provider-girard`)

## Use

In Pi, run:

```
/girard
```

Then follow the two prompts it prints:

```
/login litellm          → "Sign in with LiteLLM SSO" (browser opens on GitHub)
/model litellm/qwen3.8-coder
```

That's it. `litellm/qwen3.8-coder` (Qwen3.8-27B on a 3090, 180k context)
streams through `https://api.girard-davila.net/api/llm` → LiteLLM (spend
tracked per GitHub account) → the inference node.

## What /girard does

1. Confirms `pi-provider-litellm` is loaded (else: print the install line, stop).
2. Merges `litellm.providers.litellm.baseUrl = https://api.girard-davila.net/api/llm`
   into `~/.pi/agent/settings.json` (never clobbers other settings).
3. Checks `~/.pi/agent/auth.json`:
   - already logged in here → just tell you to `/model litellm/qwen3.8-coder`;
   - not logged in (or logged in elsewhere) → the two-step login/model path.

Re-running `/girard` is idempotent.

## Notes

- Login is GitHub SSO through the LiteLLM proxy; your virtual key is issued by
  the proxy and stored in `auth.json` (mode 0600) by `pi-provider-litellm`.
- Re-login is just `/login litellm` again — the base URL is now remembered in
  settings, so nothing to retype.
- The endpoint is personal; expect friendly rate limits.
