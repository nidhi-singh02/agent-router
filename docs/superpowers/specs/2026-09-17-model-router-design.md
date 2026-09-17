# Model Router v1 Design

**Date:** 2026-09-17  
**Status:** Approved  
**Product boundary:** Explicit CLI invoked from a Herdr session

## 1. Objective

Build a per-session model router that chooses the best eligible AI subscription, model, and reasoning effort for a task, then launches that agent in a separate Herdr pane with a structured handoff.

The router optimizes for output quality without wastefully exhausting subscriptions. It understands task type and workflow phase, preserves model-cache continuity when useful, protects shared subscriptions, and exposes why it made each decision.

TypeSafe supplies semantic judgment. Deterministic application code owns facts, policy, arithmetic, security, and side effects.

## 2. V1 Scope

V1 is a TypeScript/Node.js CLI with these user-facing commands:

```text
router run "<task>"
router status
router session
router accounts
router usage refresh
```

The primary flow is explicit. The router does not intercept ordinary prompts. Packaging as a native Herdr plugin or more implicit experience is deferred until the routing core is stable.

V1 supports accounts used through Cursor, Claude Code, ChatGPT/Codex, and providers configured behind OpenCode. OpenCode is modeled as an agent harness, not as a subscription: quota belongs to its underlying provider account.

## 3. Product Principles

1. Prefer the best eligible model for the task, not a fixed provider preference.
2. Use strong models where judgment matters and efficient models where an approved plan makes execution mechanical.
3. Default to medium reasoning, but let TypeSafe select lower or higher when justified. Ultra is excluded unless the user explicitly requests it.
4. Keep a route stable within a phase. Reconsider it at phase boundaries or when availability materially changes.
5. Never allow an AI judgment to override quota, authentication, freshness, privacy, or reserve policies.
6. Explain every route with operational facts and TypeSafe judgments.
7. Fail conservatively when shared-account state is stale or unavailable.

## 4. System Architecture

```text
router run "<task>"
        |
        +-- usage collectors
        |     official API/CLI -> local session -> browser dashboard
        |
        +-- Hermes activity adapter
        |     -> hosted heartbeat coordinator
        |     -> owner-visible "shared subscription currently active"
        |
        +-- deterministic eligibility engine
        |     authentication, freshness, quota, resets, 40% reserve,
        |     active reservations, supported models
        |
        +-- TypeSafe decision engine
        |     task family, phase, complexity, creativity, risk,
        |     model ranking, reasoning effort, cache tradeoff
        |
        +-- deterministic revalidation and reservation
        |
        +-- Herdr launcher
              separate pane -> selected agent/model -> structured handoff
```

The implementation is a small monorepo containing a reusable router core, CLI, provider adapters, Herdr adapter, and hosted coordinator. A thin global skill may teach supported agents how to invoke the CLI, but the skill does not duplicate routing logic.

## 5. Trust Boundary: Code Versus TypeSafe

### Deterministic code owns

- Account authentication and model availability.
- Usage parsing, normalization, arithmetic, reset windows, and freshness.
- The 40% reserve floor for shared accounts.
- Active heartbeat leases and capacity reservations.
- Candidate exclusion and final-choice validation.
- Secret handling, storage, logging, pane creation, and agent launch.
- Duplicate-launch prevention and failure recovery.

### TypeSafe owns

- Task-family classification.
- Workflow-phase detection.
- Complexity, creativity, ambiguity, and consequence scoring.
- Required reasoning strength.
- Cache-continuity value.
- Ranking only the candidate IDs supplied by deterministic code.
- Selecting a supported reasoning effort.
- Deciding whether a phase transition justifies switching models.

TypeSafe receives normalized account and model facts, opaque candidate IDs, and the task text required to classify the work. It never receives credentials, cookies, Telegram identifiers, raw heartbeat records, or provider session tokens.

Each TypeSafe unit uses a closed answer set (`Choice`), ordered scoring (`Score`), or calibrated yes/no probability (`Noul`). Independent questions may be batched. Confidence thresholds are applied according to consequence: a low-confidence choice that may affect quality or shared quota presents the top two eligible routes to the user; low-risk ambiguity uses the conservative default.

If TypeSafe is unavailable, trivial work may use a documented deterministic fallback. Consequential routing asks the user instead of silently inventing a semantic judgment.

## 6. Domain Model

### Account

```ts
type Ownership = "personal" | "shared";

interface Account {
  id: string;
  label: string;
  provider: ProviderId;
  ownership: Ownership;
  reserveFloor: number; // shared default 0.40
  collectorPreference: CollectorKind[];
  enabledModels: ModelId[];
  enabled: boolean;
}
```

Account labels are arbitrary and user-defined. Ownership is explicit. Personal accounts may consume all available quota; shared accounts must remain above their reserve floor after estimated task cost and active reservations.

### Model profile

```ts
interface ModelProfile {
  id: ModelId;
  provider: ProviderId;
  agent: "cursor" | "claude-code" | "codex" | "opencode";
  launchName: string;
  supportedEfforts: ReasoningEffort[];
  capabilities: {
    planning: number;
    coding: number;
    debugging: number;
    creativity: number;
    research: number;
  };
  relativeQuotaCost: number;
  relativeLatency: number;
}
```

Catalog data is configuration with provenance and update timestamps. It is not inferred at route time.

### Normalized usage snapshot

```ts
interface UsageWindow {
  kind: "five-hour" | "daily" | "weekly" | "monthly" | "provider-defined";
  remainingRatio?: number;
  usedRatio?: number;
  resetsAt?: string;
}

interface UsageSnapshot {
  accountId: string;
  windows: UsageWindow[];
  collectedAt: string;
  source: CollectorKind;
  certainty: "exact" | "estimated" | "unknown";
  expiresAt: string;
  activeReservationRatio: number;
}
```

Unknown is distinct from zero. Every snapshot records its source, certainty, and freshness. Eligibility uses the most restrictive relevant window.

### Router session

```ts
interface RouterSession {
  id: string;
  task: string;
  phase: WorkflowPhase;
  route?: RouteDecision;
  cacheAffinity?: CacheAffinity;
  reservations: Reservation[];
  handoffs: Handoff[];
  paneId?: string;
  createdAt: string;
  updatedAt: string;
}
```

Session data contains task context only as long as needed for routing and handoff. Long-lived diagnostics retain privacy-safe decision summaries rather than full task content.

## 7. Usage Collection

Each provider adapter implements:

```ts
interface UsageCollector {
  detectAccounts(): Promise<DetectedAccount[]>;
  collectUsage(account: Account): Promise<UsageSnapshot>;
  listAvailableModels(account: Account): Promise<ModelAvailability[]>;
}
```

Collection priority is:

1. Official provider API or CLI.
2. Locally authenticated account/session data.
3. Read-only collection from an already authenticated local browser dashboard.
4. Unknown usage with conservative routing.

Dashboard collectors are isolated adapters because page structure can change. They do not copy or persist browser cookies. Their fixtures are sanitized, and broken selectors degrade to `unknown`, never a fabricated percentage.

Provider limitations are surfaced honestly. If a provider does not expose an exact five-hour window, the router shows that the value is estimated or unavailable rather than pretending it is exact.

## 8. Shared Subscription Activity

The subscription owner runs the router. Friends use the subscription indirectly through Hermes Telegram and do not receive provider credentials or access to the router.

Hermes sends a short-lived heartbeat around provider requests:

```ts
interface HeartbeatLease {
  accountFingerprint: string; // keyed HMAC, never a raw account identifier
  modelFamily?: string;
  state: "active";
  reservedCapacity?: number;
  lastSeenAt: string;
  expiresAt: string;
}
```

The hosted coordinator supports only authenticated create/renew, normalized status read, release, and automatic expiry. Hermes and the owner router use separate credentials. The router UI displays only:

```text
shared subscription currently active
```

No Telegram identity, personal label, task content, prompt, message, filename, credential, or device identity is transmitted. The coordinator does not expose raw lease inspection through the client API.

The account fingerprint is derived locally with a shared secret using HMAC. It is not a plain hash of an email address, account label, or provider ID, which prevents the coordinator from testing predictable identifiers offline.

If the heartbeat service is unreachable, shared accounts become conservatively constrained or ineligible according to configured policy. If Hermes cannot emit a heartbeat, quota deltas may provide delayed inference but are never presented as confirmed live activity.

## 9. Routing Algorithm

1. Create or resume a router session.
2. Collect usage snapshots, model availability, and shared activity concurrently.
3. Reject unauthenticated, disabled, unsupported, or stale candidates.
4. For each candidate, estimate task cost and calculate projected remaining quota across all relevant windows.
5. Reject shared candidates whose projected remaining quota would fall below 40%, including active reservations.
6. Ask TypeSafe to classify the task and phase and score complexity, creativity, consequence, and cache value.
7. Construct a closed set of eligible route candidates with opaque IDs and normalized facts.
8. Ask TypeSafe to rank candidates and select a supported reasoning effort.
9. Revalidate the returned candidate deterministically against current usage and activity.
10. If confidence is below the consequence-specific threshold, present the top two eligible options.
11. Create a capacity reservation and prepare a structured handoff.
12. Immediately revalidate, create a separate Herdr pane, start the selected agent/model, and send the handoff.
13. Record the pane ID and launch token to prevent duplicates.
14. Refresh usage after completion or at the next phase boundary, reconcile the estimate, and release reservations.

When no candidate is safe, the router reports the precise exclusions and asks the user to wait, override an explicitly overridable policy, or configure another account. The 40% shared reserve is not silently overridden.

## 10. Phase-Sticky Routing and Cache Policy

The router does not switch models per message. A route remains sticky within a workflow phase unless it becomes unavailable.

Typical coding flow:

- Planning/specification: strongest justified reasoning model.
- Implementation: efficient coding model when the specification is approved and sufficiently precise.
- Review/debugging: stronger model when uncertainty, risk, or failures warrant it.

At a phase boundary, TypeSafe evaluates the expected quality benefit of switching against cache affinity, handoff quality, quota cost, and latency. A switch creates a structured handoff containing the approved specification, current state, relevant files, constraints, completed checks, and remaining acceptance tests.

Changing model, reasoning effort, or agent may reduce provider-specific prompt-cache reuse. The router therefore explains every switch and its cache tradeoff.

## 11. Herdr Launch Contract

The Herdr adapter performs these steps:

1. Confirm execution is inside Herdr.
2. Inspect the current layout and create a separate pane without stealing focus prematurely.
3. Start the chosen agent with the exact supported model and reasoning-effort arguments.
4. Send a structured handoff only after the agent is ready.
5. Record pane and agent identifiers.
6. Detect blocked or failed launches without blindly resending the task.

V1 is invoked explicitly through the CLI. A future native plugin may call the same core API.

## 12. User-Facing Explanation

Before launch, `router run` prints a concise decision card:

```text
Selected: Cursor / Grok 4.6 / medium
Phase: implementation
Why: approved specification makes execution well-bounded
Shared activity: active
Reserve policy: 40% protected
Cache decision: phase change justifies a structured handoff
Usage source: exact CLI snapshot, refreshed 12s ago
```

`router status` shows configured accounts, snapshot freshness, reset windows, active shared status, reservations, and the current route without exposing secrets.

## 13. Persistence and Security

- Local structured state uses SQLite with schema migrations.
- Provider credentials remain in provider-owned stores, the system keychain, or environment variables.
- Coordinator credentials are separate for the Hermes writer and owner reader.
- Logs are structured and redact task text by default.
- TypeSafe audit records retain question IDs, answer values, confidence, candidate IDs, and policy exclusions, not secrets.
- Heartbeats have short TTLs and are deleted after expiry.
- The router never exports browser cookies or local provider tokens.

## 14. Failure Modes

- **Stale shared usage:** candidate is ineligible by default.
- **Heartbeat outage:** shared account is treated conservatively.
- **Broken dashboard collector:** result becomes unknown; other collectors or safe fallback apply.
- **TypeSafe outage:** trivial deterministic fallback or explicit user choice.
- **Low semantic confidence:** show the top two eligible routes for consequential choices.
- **Usage race:** revalidate immediately before launch.
- **Pane/agent failure:** report the exact failure and retain a retryable session without duplicate launch.
- **Process crash:** TTLs clear remote leases; local launch tokens make restart recovery idempotent.

## 15. Verification Strategy

- Unit tests for quota arithmetic, all reset windows, freshness, reservations, 40% shared reserve, and cache affinity.
- Contract tests for provider collectors using sanitized fixtures.
- TypeSafe evaluation cases covering coding phases, creative work, research, routine transformations, and ambiguity.
- Confidence tests proving consequential uncertainty asks the user.
- Coordinator tests for authentication, TTL renewal/expiry, privacy, and outages.
- Herdr adapter tests for command construction, handoff delivery, readiness, and duplicate prevention.
- End-to-end dry runs that do not consume quota or create panes.
- Explicitly approved live smoke test for each configured agent.

## 16. Delivery Sequence

1. CLI foundation, schemas, configuration, and local persistence.
2. Deterministic policy and candidate engine.
3. TypeSafe semantic units and evaluation fixtures.
4. Provider collector framework and concrete adapters.
5. Hosted coordinator and Hermes integration contract.
6. Herdr launcher and structured handoffs.
7. Status, audit, and recovery commands.
8. End-to-end tests and live smoke tests.
9. Thin global invocation skill.

The first implementation session will run in a separate Herdr pane using Cursor with Grok 4.6 at medium reasoning.

## 17. Deferred Work

- Native Herdr plugin packaging.
- Invisible prompt interception.
- Automatic task-phase transitions without an explicit command.
- Identity-level shared activity reporting.
- Provider-specific billing optimization beyond available subscription windows.
- Cross-device task-content synchronization.
