# pi-provider-girard

One-command connect for the **api.girard-davila.net** LLM endpoint from
[Pi](https://pi.dev): the endpoint as a single `girard` provider, preset.

A thin preset layer over [`pi-provider-litellm`](https://www.npmjs.com/package/pi-provider-litellm) —
all model discovery, auth storage, and transport come from that package. This
one adds the `/girard` command, which registers the endpoint as the named
provider **`girard`** so the model is addressed as `girard/qwen3.8-coder`
instead of a `litellm/…` path.

## Install

```bash
pi install npm:pi-provider-litellm            # dependency: provider machinery
pi install git:github.com/alx/pi-provider-girard   # this package: the /girard preset
```

(Local dev: `pi install ./path/to/pi-provider-girard`)

## Use

In Pi, run:

```
/girard
```

If no credential is found yet, add your endpoint API key to
`~/.pi/agent/auth.json`, restart Pi, then:

```
/model girard/qwen3.8-coder
```

That's it. `girard/qwen3.8-coder` (Qwen3.8-27B on a 3090, 180k context)
streams through `https://api.girard-davila.net/api/llm` → LiteLLM (spend
tracked per account) → the inference node.

## What /girard does

1. Confirms `pi-provider-litellm` is loaded (else: print the install line, stop).
2. Merges `litellm.providers.girard = { displayName: "Girard", baseUrl: https://api.girard-davila.net/api/llm }`
   into `~/.pi/agent/settings.json` (never clobbers other settings).
3. Checks `~/.pi/agent/auth.json` for a `"girard"` entry:
   - present → just tell you to `/model girard/qwen3.8-coder`;
   - missing → print the exact auth.json snippet to add, then the model line.

Re-running `/girard` is idempotent.

## Notes

- Keys are issued by the endpoint operator (invitation/onboarding flow, or
  LiteLLM Web UI) and stored in `auth.json` (mode 0600).
- Optional: `litellm.mcp = { enabled: false }` in settings silences the
  extension's MCP tool discovery (the endpoint does not expose MCP).
- The endpoint is personal; expect friendly rate limits.
