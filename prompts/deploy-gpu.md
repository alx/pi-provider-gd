---
description: Deploy the gd VAST overflow GPU; switch this session to it when ready (settle beep = ready)
argument-hint: "[max $/hr]"
---
Deploy the gd overflow GPU and switch this session onto it.

1. Call the `gd_deploy_gpu` tool (max-price: `${1:-none}` — omit the parameter when "none"). It checks the gd VAST user's money (balance + credit), reuses a running instance if there is one, otherwise launches and WAITS until the model is loaded. A fresh launch takes 10–20 minutes — this is normal; do not interrupt, re-invoke, or "speed it up".
2. If it reports READY: call `gd_gpu_model` with the exact model id it returned so this session routes through the group that now includes the GPU row.
3. End your reply with ONE line: instance id, $/hr, and the model this session now uses. The pi-beep settle beep is the readiness signal — stop there; no further steps.

If `gd_deploy_gpu` fails, report its error verbatim (including the launcher tail) and do NOT switch the model.
