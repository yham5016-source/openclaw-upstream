import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  validateHeadTransitionDecision,
  validateHeadTransitionDeliveryReceipt,
  validateHeadTransitionInboundEvent,
  validateHeadTransitionWorkerCommand,
  validateHeadTransitionWorkerResult,
  type HeadTransitionDecision,
  type HeadTransitionDeliveryReceipt,
  type HeadTransitionInboundEvent,
  type HeadTransitionWorkerCommand,
  type HeadTransitionWorkerResult,
} from "./contracts.js";

// ── Types ─────────────────────────────────────────────────────────────

type ValidationResult = { ok: true } | { ok: false; reason: string };

export type HeadTransitionLedgerEntryKind =
  | "inbound_event"
  | "decision"
  | "worker_command"
  | "worker_result"
  | "delivery_receipt";

export type HeadTransitionLedgerEntry =
  | {
      kind: "inbound_event";
      idempotencyKey: string;
      recordedAtMs: number;
      payload: HeadTransitionInboundEvent;
    }
  | {
      kind: "decision";
      idempotencyKey: string;
      recordedAtMs: number;
      payload: HeadTransitionDecision;
    }
  | {
      kind: "worker_command";
      idempotencyKey: string;
      recordedAtMs: number;
      payload: HeadTransitionWorkerCommand;
    }
  | {
      kind: "worker_result";
      idempotencyKey: string;
      recordedAtMs: number;
      payload: HeadTransitionWorkerResult;
    }
  | {
      kind: "delivery_receipt";
      idempotencyKey: string;
      recordedAtMs: number;
      payload: HeadTransitionDeliveryReceipt;
    };

export type HeadTransitionLedgerSnapshot = {
  inboundEvents: Map<string, HeadTransitionInboundEvent>;
  decisions: Map<string, HeadTransitionDecision>;
  workerCommands: Map<string, HeadTransitionWorkerCommand>;
  workerResults: Map<string, HeadTransitionWorkerResult>;
  deliveryReceipts: Map<string, HeadTransitionDeliveryReceipt>;
  duplicateEventCount: number;
};

export type AppendOutcome = { ok: true; duplicate: boolean } | { ok: false; reason: string };

// ── Append ────────────────────────────────────────────────────────────

/**
 * Append a single validated entry to an immutable ledger array.
 * Returns `duplicate: true` if the idempotencyKey was already present.
 *
 * This is the core append-only primitive: it never mutates the input array
 * and always validates before appending.
 */
export function appendHeadTransitionLedgerEntry(
  events: readonly HeadTransitionLedgerEntry[],
  event: HeadTransitionLedgerEntry,
): AppendOutcome & { events: HeadTransitionLedgerEntry[] } {
  const validation = validateLedgerEntry(event);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, events: [...events] };
  }

  // Check for duplicate idempotencyKey.
  const exists = events.some((e) => e.idempotencyKey === event.idempotencyKey);
  if (exists) {
    return { ok: true, duplicate: true, events: [...events] };
  }

  return { ok: true, duplicate: false, events: [...events, event] };
}

// ── Replay ────────────────────────────────────────────────────────────

/**
 * Replay a sequence of ledger entries into a snapshot.
 *
 * - Duplicate idempotencyKeys are silently skipped and counted.
 * - Validation failures throw immediately (fail-closed).
 * - First-writer-wins: the first payload for a given key is canonical.
 */
export function replayHeadTransitionLedger(
  events: readonly HeadTransitionLedgerEntry[],
): HeadTransitionLedgerSnapshot {
  const snapshot: HeadTransitionLedgerSnapshot = {
    inboundEvents: new Map(),
    decisions: new Map(),
    workerCommands: new Map(),
    workerResults: new Map(),
    deliveryReceipts: new Map(),
    duplicateEventCount: 0,
  };

  for (const event of events) {
    const validation = validateLedgerEntry(event);
    if (!validation.ok) {
      throw new Error(`replay validation failure: ${validation.reason}`);
    }

    const target = targetMapForKind(snapshot, event.kind);
    if (target.has(event.idempotencyKey)) {
      snapshot.duplicateEventCount++;
      continue;
    }
    target.set(event.idempotencyKey, event.payload);
  }

  return snapshot;
}

// ── Validation ────────────────────────────────────────────────────────

/** Exported so alternate ledger backends (e.g. SQLite) share one validation rule. */
export function validateLedgerEntry(entry: HeadTransitionLedgerEntry): ValidationResult {
  if (!Number.isFinite(entry.recordedAtMs) || entry.recordedAtMs < 0) {
    return { ok: false, reason: "recordedAtMs must be a non-negative finite number" };
  }
  if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.trim().length === 0) {
    return { ok: false, reason: "idempotencyKey must be a non-empty string" };
  }

  const payloadValidation = validatePayload(entry);
  if (!payloadValidation.ok) {
    return payloadValidation;
  }

  // Ensure the ledger-level idempotencyKey matches the payload's key.
  const payloadKey = payloadKeyForEntry(entry);
  if (entry.idempotencyKey !== payloadKey) {
    return {
      ok: false,
      reason: `ledger idempotencyKey "${entry.idempotencyKey}" must match payload key "${payloadKey}"`,
    };
  }

  return { ok: true };
}

function validatePayload(entry: HeadTransitionLedgerEntry): ValidationResult {
  switch (entry.kind) {
    case "inbound_event":
      return validateHeadTransitionInboundEvent(entry.payload);
    case "decision":
      return validateHeadTransitionDecision(entry.payload);
    case "worker_command":
      return validateHeadTransitionWorkerCommand(entry.payload);
    case "worker_result":
      return validateHeadTransitionWorkerResult(entry.payload);
    case "delivery_receipt":
      return validateHeadTransitionDeliveryReceipt(entry.payload);
  }
}

/** Exported so alternate ledger backends can enforce the same key-match rule. */
export function payloadKeyForEntry(entry: HeadTransitionLedgerEntry): string {
  if (entry.kind === "worker_result") {
    return `${entry.payload.commandIdempotencyKey}:${entry.payload.workerId}`;
  }
  return entry.payload.idempotencyKey;
}

/** Exported so alternate ledger backends bucket replayed rows into the same maps. */
export function targetMapForKind(
  snapshot: HeadTransitionLedgerSnapshot,
  kind: HeadTransitionLedgerEntryKind,
):
  | Map<string, HeadTransitionInboundEvent>
  | Map<string, HeadTransitionDecision>
  | Map<string, HeadTransitionWorkerCommand>
  | Map<string, HeadTransitionWorkerResult>
  | Map<string, HeadTransitionDeliveryReceipt> {
  switch (kind) {
    case "inbound_event":
      return snapshot.inboundEvents;
    case "decision":
      return snapshot.decisions;
    case "worker_command":
      return snapshot.workerCommands;
    case "worker_result":
      return snapshot.workerResults;
    case "delivery_receipt":
      return snapshot.deliveryReceipts;
  }
}

// ── Convenience ───────────────────────────────────────────────────────

/** Create an empty ledger array (alias for readability at call sites). */
export function createHeadTransitionLedger(): HeadTransitionLedgerEntry[] {
  return [];
}

/** Returns true if the ledger already contains the given idempotencyKey. */
export function ledgerHasSeen(
  events: readonly HeadTransitionLedgerEntry[],
  idempotencyKey: string,
): boolean {
  return events.some((e) => e.idempotencyKey === idempotencyKey);
}
