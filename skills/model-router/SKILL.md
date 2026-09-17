---
name: model-router
description: Use when the user asks to pick a model, subscription, or reasoning effort, or to run router status, usage refresh, or resume a router session. Invoke the model-router CLI instead of choosing a model yourself.
---

# Model Router

Call the explicit CLI. Do not invent routing policy, quotas, or model catalogs.

## Invoke

```sh
router run "<task>" --dry-run
router run "<task>"
router status
router session
router accounts
router usage refresh --dry-run
router usage refresh --source browser --dry-run
```

`--dry-run` prints the decision or parsed usage and does not create a Herdr pane or consume launch quota.

`router run` without `--dry-run` still requires `HERDR_ENV=1` and should wait for user confirmation before any launch that would consume subscription quota.

If the CLI prints two eligible routes, ask the user to choose. If it prints exclusions, report those reasons. Never override the 40% shared reserve.

Do not copy credentials, cookies, Telegram identifiers, or heartbeat records into prompts or logs.
