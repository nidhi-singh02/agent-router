# Configuration

Local state lives under the platform config directory, or `MODEL_ROUTER_HOME`.

`MODEL_ROUTER_HOME/config.json` example:

```json
{
  "accounts": [
    {
      "id": "acct_personal_cursor",
      "label": "personal cursor",
      "provider": "cursor",
      "agent": "cursor",
      "ownership": "personal",
      "collectorPreference": ["official-cli", "local-session", "browser-dashboard"],
      "enabledModels": ["cursor:grok-4.6"],
      "enabled": true,
      "credentialRef": "env:CURSOR_API_KEY"
    }
  ],
  "coordinator": {
    "url": "https://example.invalid",
    "readerCredentialRef": "env:COORDINATOR_READER_TOKEN"
  },
  "typesafe": {
    "apiKeyRef": "keychain:model-router-typesafe"
  }
}
```

Credential values stay in the environment or keychain. The router stores references
only (`env:NAME` or `keychain:NAME`). `keychain:NAME` reads the macOS login Keychain
generic password with service `NAME` (`security find-generic-password -s NAME -w`); add
one with `security add-generic-password -a "$USER" -s NAME -w`. For `typesafe.apiKeyRef`,
`TYPESAFE_API_KEY` is used when the reference has no value. Shared `reserveFloor` cannot be set below `0.40`.
`collectorPreference` lists collector kinds in preference order. `router run` uses only
`local-session` collectors unless you pass `--usage`, which runs the full chain
(official-cli/api, local-session, browser).
`MODEL_ROUTER_COORDINATOR_URL` overrides the file URL.
Coordinator URLs must use HTTPS; HTTP is accepted only for `localhost`, `127.0.0.1`, or
`[::1]` during local development.
