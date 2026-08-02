import { describe, expect, it } from "vitest";
import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  type HeadTransitionDecision,
  type HeadTransitionDeliveryReceipt,
  type HeadTransitionInboundEvent,
  type HeadTransitionWorkerResult,
} from "./contracts.js";
import {
  appendHeadTransitionLedgerEntry,
  createHeadTransitionLedger,
  ledgerHasSeen,
  replayHeadTransitionLedger,
  type HeadTransitionLedgerEntry,
} from "./ledger.js";

// ── Fixtures ──────────────────────────────────────────────────────────

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
  return {
    kind: "inbound_event",
    idempotencyKey: key,
    recordedAtMs,
    payload: makeInbound(key),
  };
}

function decisionEntry(key: string, recordedAtMs = 11): HeadTransitionLedgerEntry {
  return {
    kind: "decision",
    idempotencyKey: key,
    recordedAtMs,
    payload: makeDecision(key),
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

describe("appendHeadTransitionLedgerEntry", () => {
  it("appends a valid inbound event and returns the new array", () => {
    const ledger = createHeadTransitionLedger();
    const entry = inboundEntry("evt-1");

    const result = appendHeadTransitionLedgerEntry(ledger, entry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toBe(false);
      expect(result.events).toHaveLength(1);
    }
    // Original array is not mutated.
    expect(ledger).toHaveLength(0);
  });

  it("skips duplicate idempotencyKeys without error", () => {
    const entry = inboundEntry("evt-1");
    const ledger = [entry];

    const result = appendHeadTransitionLedgerEntry(ledger, entry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toBe(true);
      expect(result.events).toHaveLength(1);
    }
  });

  it("rejects invalid payloads without appending", () => {
    const ledger = createHeadTransitionLedger();
    const badEntry: HeadTransitionLedgerEntry = {
      kind: "decision",
      idempotencyKey: "decision:bad",
      recordedAtMs: 1,
      payload: {
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "decision:bad",
        sessionKey: "agent:main:main",
        status: "reply",
        // Missing replyText — should fail validation.
      } as HeadTransitionDecision,
    };

    const result = appendHeadTransitionLedgerEntry(ledger, badEntry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("reply decisions require replyText");
    }
    expect(result.events).toHaveLength(0);
  });

  it("rejects entries where ledger key does not match payload key", () => {
    const entry: HeadTransitionLedgerEntry = {
      kind: "inbound_event",
      idempotencyKey: "wrong-key",
      recordedAtMs: 1,
      payload: makeInbound("correct-key"),
    };

    const result = appendHeadTransitionLedgerEntry([], entry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must match payload key");
    }
  });

  it("appends all four event kinds", () => {
    let ledger = createHeadTransitionLedger();

    const entries = [
      inboundEntry("inbound-1"),
      decisionEntry("decision-1"),
      workerResultEntry("cmd-1"),
      deliveryReceiptEntry("receipt-1"),
    ];

    for (const entry of entries) {
      const result = appendHeadTransitionLedgerEntry(ledger, entry);
      expect(result.ok).toBe(true);
      if (result.ok) {
        ledger = result.events;
      }
    }

    expect(ledger).toHaveLength(4);
    expect(ledgerHasSeen(ledger, "inbound-1")).toBe(true);
    expect(ledgerHasSeen(ledger, "decision-1")).toBe(true);
    expect(ledgerHasSeen(ledger, "cmd-1:glm")).toBe(true);
    expect(ledgerHasSeen(ledger, "receipt-1")).toBe(true);
  });
});

describe("replayHeadTransitionLedger", () => {
  it("replays a clean sequence into a snapshot with zero duplicates", () => {
    const events: HeadTransitionLedgerEntry[] = [
      inboundEntry("evt-1"),
      decisionEntry("decision-1"),
      workerResultEntry("cmd-1"),
      deliveryReceiptEntry("receipt-1"),
    ];

    const snapshot = replayHeadTransitionLedger(events);

    expect(snapshot.duplicateEventCount).toBe(0);
    expect(snapshot.inboundEvents).toHaveProperty("size", 1);
    expect(snapshot.decisions).toHaveProperty("size", 1);
    expect(snapshot.workerResults).toHaveProperty("size", 1);
    expect(snapshot.deliveryReceipts).toHaveProperty("size", 1);
    expect(snapshot.inboundEvents.get("evt-1")).toBeDefined();
    expect(snapshot.decisions.get("decision-1")?.replyText).toBe("ack");
  });

  it("skips duplicate keys and counts them", () => {
    const first = inboundEntry("evt-1", 10);
    const duplicate = inboundEntry("evt-1", 20);

    const snapshot = replayHeadTransitionLedger([first, duplicate]);

    expect(snapshot.duplicateEventCount).toBe(1);
    // First-writer-wins: the original payload is preserved.
    expect(snapshot.inboundEvents.get("evt-1")?.body).toBe("hello");
  });

  it("throws on validation failure during replay", () => {
    const badEntry: HeadTransitionLedgerEntry = {
      kind: "inbound_event",
      idempotencyKey: "evt-bad",
      recordedAtMs: 1,
      payload: { ...makeInbound("evt-bad"), version: 999 as never },
    };

    expect(() => replayHeadTransitionLedger([badEntry])).toThrow("replay validation failure");
  });

  it("replay is idempotent: replaying the same entry sequence twice produces the same snapshot", () => {
    const events: HeadTransitionLedgerEntry[] = [
      inboundEntry("evt-1"),
      decisionEntry("decision-1"),
      workerResultEntry("cmd-1"),
      deliveryReceiptEntry("receipt-1"),
    ];

    const snapshot1 = replayHeadTransitionLedger(events);
    const snapshot2 = replayHeadTransitionLedger(events);

    expect(snapshot2.duplicateEventCount).toBe(snapshot1.duplicateEventCount);
    expect(snapshot2.inboundEvents.size).toBe(snapshot1.inboundEvents.size);
    expect(snapshot2.decisions.size).toBe(snapshot1.decisions.size);
    expect(snapshot2.workerResults.size).toBe(snapshot1.workerResults.size);
    expect(snapshot2.deliveryReceipts.size).toBe(snapshot1.deliveryReceipts.size);
    // Same first-writer-wins payload.
    expect(snapshot2.inboundEvents.get("evt-1")).toEqual(snapshot1.inboundEvents.get("evt-1"));
  });

  it("handles worker_result dedupe by commandIdempotencyKey:workerId", () => {
    const result = makeWorkerResult("cmd-1");
    const entry: HeadTransitionLedgerEntry = {
      kind: "worker_result",
      idempotencyKey: "cmd-1:glm",
      recordedAtMs: 12,
      payload: result,
    };

    const snapshot = replayHeadTransitionLedger([entry, entry]);

    expect(snapshot.duplicateEventCount).toBe(1);
    expect(snapshot.workerResults.size).toBe(1);
  });
});

describe("ledgerHasSeen", () => {
  it("returns true for existing keys", () => {
    const events: HeadTransitionLedgerEntry[] = [inboundEntry("evt-1")];
    expect(ledgerHasSeen(events, "evt-1")).toBe(true);
  });

  it("returns false for missing keys", () => {
    const events: HeadTransitionLedgerEntry[] = [inboundEntry("evt-1")];
    expect(ledgerHasSeen(events, "evt-2")).toBe(false);
  });
});
