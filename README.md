# Model Router

Explicit TypeScript CLI that selects an eligible subscription, model, and reasoning
effort. TypeSafe ranks only the closed candidate set. Deterministic code enforces
quota, reserve, freshness, activity, privacy, and launch policy.

```sh
npm install
npm run verify
```

```sh
router run "<task>" --dry-run
router status
router session
router accounts
router usage refresh --dry-run
```

Do not deploy the Cloudflare coordinator, write into an external Hermes checkout,
install the skill globally, or consume live provider quota without explicit approval.
