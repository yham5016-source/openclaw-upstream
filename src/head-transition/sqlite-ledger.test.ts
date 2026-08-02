import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  type HeadTransitionDecision,
  type HeadTransitionDeliveryReceipt,
  type HeadTransitionInboundEvent,
  type HeadTransitionWorkerCommand,
  type HeadTransitionWorkerResult,
} from "./contracts.js";
import type { HeadTransitionLedgerEntry } from "./ledger.js";
import {
  appendHeadTransitionLedgerEntrySqlite,
  ledgerHasSeenSqlite,
  openHeadTransitionSqliteLedger,
  replayHeadTransitionLedgerSqlite,
} from "./sqlite-ledger.js";

// ── Fixtures (mirrors ledger.test.ts so both backends prove the same contract) ──

function makeInbound(key: string): HeadTransitionInboundEvent {
  return {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    idempotencyKey: key,
    channel: "discord",
    accountId: "default",
    sessionKey: "agent:main:discord:default:channel:channel-1",
    messageId: `message-${key}`,
    senderId: "user-1",
    occurredAtMs: 1,
    body: "hello",
  };
}

function makeDecision(key: string): HeadTransitionDecision {
  return {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    idempotencyKey: key,
    sessionKey: "agent:main:discord:default:channel:channel-1",
    status: "reply",
    replyText: "ack",
  };
}

function makeWorkerCommand(key: string): HeadTransitionWorkerCommand {
  return {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    idempotencyKey: key,
    workerId: "glm",
    kind: "code",
    body: "run tests",
    leaseExpiresAtMs: 100,
  };
}

function makeWorkerResult(commandKey: string): HeadTransitionWorkerResult {
  return {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    commandIdempotencyKey: commandKey,
    workerId: "glm",
    status: "ok",
    body: "done",
    completedAtMs: 3,
  };
}

function makeDeliveryReceipt(key: string): HeadTransitionDeliveryReceipt {
  return {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    idempotencyKey: key,
    sessionKey: "agent:main:discord:default:channel:channel-1",
    deliveredAtMs: 4,
    target: {
      channel: "discord",
      to: "channel-1",
      accountId: "default",
    },
  };
}

function inboundEntry(key: string, recordedAtMs = 10): HeadTransitionLedgerEntry {
  return { kind: "inbound_event", idempotencyKey: key, recordedAtMs, payload: makeInbound(key) };
}

function decisionEntry(key: string, recordedAtMs = 11): HeadTransitionLedgerEntry {
  return { kind: "decision", idempotencyKey: key, recordedAtMs, payload: makeDecision(key) };
}

function workerCommandEntry(key: string, recordedAtMs = 11): HeadTransitionLedgerEntry {
  return {
    kind: "worker_command",
    idempotencyKey: key,
    recordedAtMs,
    payload: makeWorkerCommand(key),
  };
}

function workerResultEntry(commandKey: string, recordedAtMs = 12): HeadTransitionLedgerEntry {
  return {
    kind: "worker_result",
    idempotencyKey: `${commandKey}:glm`,
    recordedAtMs,
    payload: makeWorkerResult(commandKey),
  };
}

function deliveryReceiptEntry(key: string, recordedAtMs = 13): HeadTransitionLedgerEntry {
  return {
    kind: "delivery_receipt",
    idempotencyKey: key,
    recordedAtMs,
    payload: makeDeliveryReceipt(key),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("appendHeadTransitionLedgerEntrySqlite", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("appends a valid inbound event and persists it", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const result = appendHeadTransitionLedgerEntrySqlite(db, inboundEntry("evt-1"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toBe(false);
    }
    expect(ledgerHasSeenSqlite(db, "evt-1")).toBe(true);
  });

  it("skips duplicate idempotencyKeys without error", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const entry = inboundEntry("evt-1");
    appendHeadTransitionLedgerEntrySqlite(db, entry);

    const result = appendHeadTransitionLedgerEntrySqlite(db, entry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toBe(true);
    }
    expect(replayHeadTransitionLedgerSqlite(db).inboundEvents.size).toBe(1);
  });

  it("rejects invalid payloads without appending", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const badEntry: HeadTransitionLedgerEntry = {
      kind: "decision",
      idempotencyKey: "decision:bad",
      recordedAtMs: 1,
      payload: {
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "decision:bad",
        sessionKey: "agent:main:main",
        status: "reply",
        // Missing replyText -- should fail validation.
      } as HeadTransitionDecision,
    };

    const result = appendHeadTransitionLedgerEntrySqlite(db, badEntry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("reply decisions require replyText");
    }
    expect(ledgerHasSeenSqlite(db, "decision:bad")).toBe(false);
  });

  it("rejects entries where ledger key does not match payload key", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const entry: HeadTransitionLedgerEntry = {
      kind: "inbound_event",
      idempotencyKey: "wrong-key",
      recordedAtMs: 1,
      payload: makeInbound("correct-key"),
    };

    const result = appendHeadTransitionLedgerEntrySqlite(db, entry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must match payload key");
    }
  });

  it("appends all five event kinds", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const entries = [
      inboundEntry("inbound-1"),
      decisionEntry("decision-1"),
      workerCommandEntry("command-1"),
      workerResultEntry("cmd-1"),
      deliveryReceiptEntry("receipt-1"),
    ];

    for (const entry of entries) {
      const result = appendHeadTransitionLedgerEntrySqlite(db, entry);
      expect(result.ok).toBe(true);
    }

    expect(ledgerHasSeenSqlite(db, "inbound-1")).toBe(true);
    expect(ledgerHasSeenSqlite(db, "decision-1")).toBe(true);
    expect(ledgerHasSeenSqlite(db, "command-1")).toBe(true);
    expect(ledgerHasSeenSqlite(db, "cmd-1:glm")).toBe(true);
    expect(ledgerHasSeenSqlite(db, "receipt-1")).toBe(true);
  });

  it("survives reopening the same file-backed database (durability across restarts)", () => {
    // node:sqlite requires a real filesystem path for this proof; :memory: does
    // not survive a close/reopen cycle by design.
    const path = `${globalThis.process.env.TMPDIR ?? "/tmp"}/head-transition-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const first = openHeadTransitionSqliteLedger(path);
    appendHeadTransitionLedgerEntrySqlite(first, inboundEntry("evt-restart"));
    first.close();

    // Reassign the shared `db` so the describe-level afterEach owns cleanup;
    // a second local handle here would double-close and throw.
    db = openHeadTransitionSqliteLedger(path);
    try {
      expect(ledgerHasSeenSqlite(db, "evt-restart")).toBe(true);
    } finally {
      unlinkSync(path);
    }
  });
});

describe("replayHeadTransitionLedgerSqlite", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("replays a clean sequence into a snapshot with zero duplicates", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    for (const entry of [
      inboundEntry("evt-1"),
      decisionEntry("decision-1"),
      workerResultEntry("cmd-1"),
      deliveryReceiptEntry("receipt-1"),
    ]) {
      appendHeadTransitionLedgerEntrySqlite(db, entry);
    }

    const snapshot = replayHeadTransitionLedgerSqlite(db);

    expect(snapshot.duplicateEventCount).toBe(0);
    expect(snapshot.inboundEvents.size).toBe(1);
    expect(snapshot.decisions.size).toBe(1);
    expect(snapshot.workerResults.size).toBe(1);
    expect(snapshot.deliveryReceipts.size).toBe(1);
    expect(snapshot.decisions.get("decision-1")?.replyText).toBe("ack");
  });

  it("first-writer-wins: replay keeps the original payload for a duplicate key", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    appendHeadTransitionLedgerEntrySqlite(db, inboundEntry("evt-1", 10));
    // Second append with the same key is a no-op duplicate at the store layer;
    // replay must still report the original body.
    appendHeadTransitionLedgerEntrySqlite(db, inboundEntry("evt-1", 20));

    const snapshot = replayHeadTransitionLedgerSqlite(db);

    expect(snapshot.inboundEvents.get("evt-1")?.body).toBe("hello");
  });

  it("handles worker_result dedupe by commandIdempotencyKey:workerId", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    const entry = workerResultEntry("cmd-1");
    appendHeadTransitionLedgerEntrySqlite(db, entry);
    appendHeadTransitionLedgerEntrySqlite(db, entry);

    const snapshot = replayHeadTransitionLedgerSqlite(db);

    expect(snapshot.workerResults.size).toBe(1);
  });

  it("replay is idempotent: replaying twice produces the same snapshot", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    for (const entry of [inboundEntry("evt-1"), decisionEntry("decision-1")]) {
      appendHeadTransitionLedgerEntrySqlite(db, entry);
    }

    const snapshot1 = replayHeadTransitionLedgerSqlite(db);
    const snapshot2 = replayHeadTransitionLedgerSqlite(db);

    expect(snapshot2.inboundEvents.size).toBe(snapshot1.inboundEvents.size);
    expect(snapshot2.decisions.size).toBe(snapshot1.decisions.size);
    expect(snapshot2.inboundEvents.get("evt-1")).toEqual(snapshot1.inboundEvents.get("evt-1"));
  });
});

describe("ledgerHasSeenSqlite", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("returns true for existing keys and false for missing ones", () => {
    db = openHeadTransitionSqliteLedger(":memory:");
    appendHeadTransitionLedgerEntrySqlite(db, inboundEntry("evt-1"));

    expect(ledgerHasSeenSqlite(db, "evt-1")).toBe(true);
    expect(ledgerHasSeenSqlite(db, "evt-2")).toBe(false);
  });
});
