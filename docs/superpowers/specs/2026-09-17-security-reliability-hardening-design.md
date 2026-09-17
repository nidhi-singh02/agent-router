# Model Router Security and Reliability Hardening

**Date:** 2026-09-17  
**Status:** Approved design; awaiting implementation-plan review  
**Product boundary:** Local router CLI, coordinator source, and Hermes heartbeat package. No deployment or external Hermes checkout changes.

## Objective

Close the seven verified audit findings without weakening the router's conservative shared-account policy or making heartbeat failures fatal to provider requests. The result must preserve privacy, work correctly across concurrent processes and overlapping provider requests, and be proven with regression tests plus runtime probes.

## 1. Persistent coordinator leases

The Cloudflare Worker entrypoint must stop constructing an in-memory `Map`. Production request handling will use the configured D1 binding through a lease-repository interface; tests may use an in-memory implementation of the same interface.

Every lease row is identified by both an HMAC account fingerprint and a unique lease ID. D1 operations must support:

- create or renew one lease;
- release one lease without affecting sibling leases;
- delete expired leases;
- return only normalized account activity, never raw lease records.

The Worker must fail closed when the D1 binding or credentials are absent. Deployment remains explicitly out of scope.

## 2. Heartbeat lifecycle and HTTP contract

`createHeartbeatClient` will generate a unique opaque lease ID for each wrapped provider operation. `create` returns that lease handle; `renew` and `release` require the handle. `wrapProviderRequest` will:

1. attempt lease creation;
2. run the provider operation even if creation fails;
3. renew a successfully created lease before its TTL expires while the operation is running;
4. stop renewal and release only that lease in `finally`;
5. report sanitized diagnostics without response bodies, tokens, fingerprints, or account IDs.

All non-2xx coordinator responses are failures. Base URLs are normalized so either trailing-slash form reaches the same endpoint. Tests cover 401/403/404/429/500, overlapping operations, an operation longer than one TTL, and failure diagnostics.

## 3. Atomic local reservations

Capacity reservations move from a process-local `Map` to SQLite. The schema stores reservation ID, account ID, ratio, creation time, and expiry time.

For shared accounts, final eligibility revalidation and reservation acquisition occur inside one `BEGIN IMMEDIATE` transaction. The transaction deletes expired reservations, sums active reservations for the account, re-evaluates the selected route against current usage, and inserts the reservation only if the reserve floor remains satisfied. A competing router process therefore observes the first reservation before it can commit its own.

Failed launches release their reservation immediately. Successful reservations remain until explicit reconciliation/release or TTL expiry. Session records retain the reservation metadata for audit and recovery.

## 4. Local state permissions

The router home directory must be `0700`. SQLite database, WAL, and SHM files must be `0600`. `openDatabase` repairs existing overly broad modes each time it opens the state store and reapplies file permissions after enabling WAL. Permission failures are surfaced rather than ignored.

Tests use a temporary directory and assert the effective modes on supported POSIX platforms.

## 5. TypeSafe sensitive-task gate

The CLI continues to disclose that routing sends task text to TypeSafe, but deterministic code must reject task state containing recognizable sensitive material before any external call.

The detector covers, at minimum:

- bearer tokens and common API-token prefixes;
- explicit password, secret, cookie, and authorization assignments;
- PEM private keys;
- credential-bearing database and service URLs;
- Telegram bot tokens and comparable structured credentials.

Errors identify only the category and never echo the matched value. The same gate runs before classification, ranking, and effort calls. This change does not attempt to identify arbitrary health, legal, or personal prose; callers remain responsible for not sending sensitive narrative content. A future local-only semantic classifier is outside this hardening scope.

## 6. Child-process environment isolation

The Herdr command adapter receives an explicit environment. Runtime construction passes an allowlist containing only variables required for executable discovery, terminal operation, locale, temporary files, user/home resolution, and Herdr session control. Credential-like variables and unrelated application variables are excluded.

Tests execute a real child process that prints selected variables and prove a supplied secret is absent while required execution variables remain available.

## 7. Transport security

Coordinator URLs must use HTTPS. Plain HTTP is allowed only for loopback development hosts (`localhost`, `127.0.0.1`, and `[::1]`). Validation occurs both when loading configuration and immediately before a request so programmatic client construction cannot bypass it.

Tests reject remote HTTP URLs and accept HTTPS plus explicit loopback development URLs.

## Error handling hardening

Authenticated coordinator requests with malformed JSON, malformed percent encoding, invalid lease IDs, invalid fingerprints, or out-of-range TTLs return stable `400` responses rather than uncaught exceptions. Unknown routes remain `404`; authentication failures remain `403`.

## Compatibility and migration

- Add a forward-only SQLite migration for local reservations.
- Update the D1 lease migration for unique lease IDs. Because the coordinator is documented as local-only and not approved for deployment, no production-data migration is required.
- Keep public heartbeat construction source-compatible where practical, but allow the internal `HeartbeatClient` interface to change to carry lease handles.
- Update README, privacy, operations, configuration, and package documentation to match the implemented guarantees and limitations.

## Verification

Implementation follows red-green-refactor for every behavior. Completion requires:

- focused unit and integration tests for each of the seven findings;
- a separate-request coordinator integration test using a D1-compatible test binding;
- multi-connection SQLite contention tests proving only safe reservations commit;
- real child-process environment and filesystem-permission probes;
- heartbeat overlap and renewal tests using controlled time;
- `npm audit`;
- `npm run verify` with typecheck, lint, formatting, all tests, and builds;
- `git diff --check` and confirmation that pre-existing untracked files remain untouched.

No Cloudflare deployment, live provider request, subscription-consuming launch, or external checkout mutation is part of verification.

## Success criteria

1. Coordinator state survives separate Worker requests through D1.
2. HTTP failures produce sanitized heartbeat diagnostics while provider work continues.
3. Overlapping and long-running provider operations remain active until their own lease ends.
4. Concurrent router processes cannot jointly cross the configured shared reserve floor.
5. Router state is not group- or world-readable.
6. Recognizable credentials never reach TypeSafe state.
7. Herdr subprocesses do not inherit credential-bearing environment variables.
8. Remote plaintext coordinator URLs are rejected.
9. The complete repository verification gate passes.

## Out of scope

- Deploying the coordinator or configuring a Cloudflare account
- Modifying an external Hermes checkout
- Encrypting local SQLite contents at rest
- A fully local replacement for TypeSafe semantic routing
- General-purpose PII or sensitive-narrative classification
- Automatic completion callbacks from launched agents
