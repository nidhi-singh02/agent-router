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
    "apiKeyRef": "env:TYPESAFE_API_KEY"
  }
}
```

Credential values stay in the environment or keychain. The router stores references
only (`env:NAME` or `keychain:NAME`). Shared `reserveFloor` cannot be set below `0.40`.
`MODEL_ROUTER_COORDINATOR_URL` overrides the file URL.
