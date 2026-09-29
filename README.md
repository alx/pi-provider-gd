# pi-provider-gd

One-command connect for the **api.girard-davila.net** LLM endpoint from
[Pi](https://pi.dev): the endpoint as a single `gd` provider, preset.

A thin preset layer over [`pi-provider-litellm`](https://www.npmjs.com/package/pi-provider-litellm) —
all model discovery, auth storage, and transport come from that package. This
one adds the `/gd-register` command, which registers the endpoint as the named
provider **`gd`** so the model is addressed as `gd/<model-id>` —
where `<model-id>` is discovered live from the endpoint's `/v1/models`
(which mirrors the alias llama.cpp advertises, derived from the GGUF
filename — currently `Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller`) — instead of a
`litellm/…` path.

## Install

```bash
pi install npm:pi-provider-litellm            # dependency: provider machinery
pi install git:github.com/alx/pi-provider-gd   # this package: the /gd-register preset
```

(Local dev: `pi install ./path/to/pi-provider-gd`)

## Use

In Pi, run:

```
/gd-register
```

If no credential is found yet, add your endpoint API key to
`~/.pi/agent/auth.json`, restart Pi, then:

```
/model gd/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller
```

That's it. The model (currently Qwen3.8-27B on a 3090, 180k context)
streams through `https://api.girard-davila.net/api/llm` → LiteLLM (spend
tracked per account) → the inference node. The exact id is printed by
`/gd-register` — it fetches `/v1/models` and lists every model the endpoint
offers, so no name is hardcoded in the extension.

## What /gd-register does

1. Confirms `pi-provider-litellm` is loaded (else: print the install line, stop).
2. Merges `litellm.providers.gd = { displayName: "Girard", baseUrl: https://api.girard-davila.net/api/llm }`
   into `~/.pi/agent/settings.json` (never clobbers other settings).
3. Checks `~/.pi/agent/auth.json` for a `"gd"` entry:
   - present → query `/v1/models` and list every model as
     `/model gd/<id>` (falling back to the known id if the endpoint is
     unreachable);
   - missing → print the exact auth.json snippet to add, then the model line.

Re-running `/gd-register` is idempotent.

## Notes

- Keys are issued by the endpoint operator (invitation/onboarding flow, or
  LiteLLM Web UI) and stored in `auth.json` (mode 0600).
- Optional: `litellm.mcp = { enabled: false }` in settings silences the
  extension's MCP tool discovery (the endpoint does not expose MCP).
- The endpoint is personal; expect friendly rate limits.
