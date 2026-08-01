# LangGraph Head Transition v0.1

Status: spike contract
Date: 2026-07-31

## Decision

OpenClaw remains the edge runtime. LangGraph Head becomes the single conversation,
judgment, and canonical state owner behind a typed contract boundary.

## Current Attachment Points

- Discord ingress preflight:
  - `extensions/discord/src/monitor/message-handler.preflight.ts`
  - `extensions/discord/src/monitor/message-handler.preflight-context.ts`
- Discord queue and replay guard:
  - `extensions/discord/src/monitor/message-handler.ts`
  - `extensions/discord/src/monitor/inbound-job.ts`
  - `extensions/discord/src/monitor/inbound-dedupe.ts`
- Discord delivery receipt correlation:
  - `extensions/discord/src/inbound-event-delivery.ts`
- Gateway agent dispatch:
  - `src/commands/agent-via-gateway.ts`
- Existing approval boundary:
  - `src/agents/bash-tools.exec-approval-request.ts`
  - `src/agents/bash-tools.exec-approval-followup.ts`
  - `extensions/discord/src/approval-runtime.ts`

## v0.1 Contract Types

The initial contract validation lives in:

- `src/head-transition/contracts.ts`
- `src/head-transition/contracts.test.ts`
- `src/head-transition/ledger.ts`
- `src/head-transition/ledger.test.ts`

The contract names intentionally match the mixed-framework planning vocabulary:

- `HeadTransitionInboundEvent`
- `HeadTransitionDecision`
- `HeadTransitionWorkerCommand`
- `HeadTransitionWorkerResult`
- `HeadTransitionDeliveryReceipt`

## Minimal Flow

```text
Discord message
  -> Discord preflight keeps channel auth, context visibility, mention policy
  -> build HeadTransitionInboundEvent
  -> validate contract version and shape
  -> append inbound event to Head transition ledger
  -> LangGraph Head decides
  -> validate HeadTransitionDecision
  -> append decision / worker command / worker result / delivery receipt events
  -> reply, approval interrupt, or typed worker command
  -> delivery receipt recorded by existing delivery correlation path
```

## What OpenClaw Still Owns

- Discord connection and message hydration.
- Channel/group/DM access checks.
- Mention policy and context visibility.
- Session key resolution.
- Typing feedback and status.
- Delivery and retry mechanics.
- Device bridge and external side-effect execution.

## What Head Owns

- User intent interpretation.
- Plan and execution state.
- Worker selection.
- Approval request semantics.
- Final answer content.
- Ledger replay interpretation.
- Worker result acceptance or rejection.

## Ledger v0.1

The current ledger implementation is intentionally in-memory and append-only.
It is a contract spike, not the durable production store.

Required behavior already covered by focused tests:

- Invalid payloads fail before append.
- Replay validates every event again before rebuilding canonical state.
- Duplicate idempotency keys are harmless and do not replace the first payload.
- Inbound events, decisions, worker commands, worker results, and delivery
  receipts replay into separate canonical maps.

## First Integration Patch

Add a Discord adapter beside the existing preflight/queue flow:

```text
DiscordMessagePreflightContext
  -> HeadTransitionInboundEvent
```

The adapter must not bypass existing preflight. It should consume the already
authorized, already-normalized context and convert it into the typed Head
contract.

## Required Gates

- Contract version compatibility.
- Idempotency key presence.
- Route/session ownership preservation.
- Worker command lease expiry.
- Worker result schema validation.
- Delivery receipt dedupe.
- Approval scope, expiry, one-time use, cancel semantics.

## Explicit Non-Goals

- No LangChain Supervisor.
- No second Team Lead Planner.
- No LLM Dispatch Broker agent.
- No Kafka or RabbitMQ in v0.1.
- No vector DB in v0.1.
- No always-on reviewer/tester chain.
- No Claude/Copilot recovery work in this branch.

## Verification

Focused contract and ledger proof:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/head-transition
```

If using a clean worktree without local dependencies, install dependencies or
temporarily point the worktree at an existing compatible `node_modules` only for
the test run. Do not update the lockfile as part of this spike.
