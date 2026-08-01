// SQLite-backed sibling of ledger.ts's in-memory ledger. Same append/replay
// contract, durable storage. Spike: a dedicated file, not the shared
// OpenClaw state DB or an agent DB -- see docs/architecture/langgraph-head-transition-v01.md
// Open Questions for the still-undecided checkpoint-store home.
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { HeadTransitionInboundEvent } from "./contracts.js";
import {
  targetMapForKind,
  validateLedgerEntry,
  type AppendOutcome,
  type HeadTransitionLedgerEntry,
  type HeadTransitionLedgerEntryKind,
  type HeadTransitionLedgerSnapshot,
} from "./ledger.js";

interface HeadTransitionLedgerRow {
  idempotency_key: string;
  kind: HeadTransitionLedgerEntryKind;
  recorded_at_ms: number;
  payload: string;
}

interface HeadTransitionLedgerDatabase {
  head_transition_ledger: HeadTransitionLedgerRow;
}

function getLedgerKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<HeadTransitionLedgerDatabase>(db);
}

/** Open (creating if needed) a SQLite-backed Head transition ledger. */
export function openHeadTransitionSqliteLedger(location: string): DatabaseSync {
  const db = new NodeSqliteDatabaseSync(location);
  db.exec(`
    CREATE TABLE IF NOT EXISTS head_transition_ledger (
      idempotency_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  return db;
}

/**
 * Append one validated entry. Duplicate idempotencyKeys are a no-op at the
 * storage layer (`ON CONFLICT DO NOTHING`), matching the in-memory ledger's
 * global (not per-kind) duplicate check.
 */
export function appendHeadTransitionLedgerEntrySqlite(
  db: DatabaseSync,
  entry: HeadTransitionLedgerEntry,
): AppendOutcome {
  const validation = validateLedgerEntry(entry);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const result = executeSqliteQuerySync(
    db,
    getLedgerKysely(db)
      .insertInto("head_transition_ledger")
      .values({
        idempotency_key: entry.idempotencyKey,
        kind: entry.kind,
        recorded_at_ms: entry.recordedAtMs,
        payload: JSON.stringify(entry.payload),
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing()),
  );

  return { ok: true, duplicate: (result.numAffectedRows ?? 0n) === 0n };
}

/** Rebuild a canonical snapshot from every row currently in the ledger table. */
export function replayHeadTransitionLedgerSqlite(db: DatabaseSync): HeadTransitionLedgerSnapshot {
  const snapshot: HeadTransitionLedgerSnapshot = {
    inboundEvents: new Map(),
    decisions: new Map(),
    workerCommands: new Map(),
    workerResults: new Map(),
    deliveryReceipts: new Map(),
    duplicateEventCount: 0,
  };

  const rows = executeSqliteQuerySync(
    db,
    getLedgerKysely(db)
      .selectFrom("head_transition_ledger")
      .selectAll()
      .orderBy("recorded_at_ms", "asc"),
  ).rows;

  for (const row of rows) {
    const entry = rowToLedgerEntry(row);
    const validation = validateLedgerEntry(entry);
    if (!validation.ok) {
      throw new Error(`replay validation failure: ${validation.reason}`);
    }
    // The idempotency_key primary key already guarantees no duplicate rows
    // exist in storage, so duplicateEventCount stays 0 for this backend.
    targetMapForKind(snapshot, entry.kind).set(entry.idempotencyKey, entry.payload as never);
  }

  return snapshot;
}

/** Returns true if the ledger already contains the given idempotencyKey. */
export function ledgerHasSeenSqlite(db: DatabaseSync, idempotencyKey: string): boolean {
  const rows = executeSqliteQuerySync(
    db,
    getLedgerKysely(db)
      .selectFrom("head_transition_ledger")
      .select("idempotency_key")
      .where("idempotency_key", "=", idempotencyKey)
      .limit(1),
  ).rows;
  return rows.length > 0;
}

function rowToLedgerEntry(row: HeadTransitionLedgerRow): HeadTransitionLedgerEntry {
  const base = { idempotencyKey: row.idempotency_key, recordedAtMs: Number(row.recorded_at_ms) };
  const payload: unknown = JSON.parse(row.payload);
  switch (row.kind) {
    case "inbound_event":
      return { ...base, kind: "inbound_event", payload: payload as HeadTransitionInboundEvent };
    case "decision":
      return { ...base, kind: "decision", payload } as HeadTransitionLedgerEntry;
    case "worker_command":
      return { ...base, kind: "worker_command", payload } as HeadTransitionLedgerEntry;
    case "worker_result":
      return { ...base, kind: "worker_result", payload } as HeadTransitionLedgerEntry;
    case "delivery_receipt":
      return { ...base, kind: "delivery_receipt", payload } as HeadTransitionLedgerEntry;
  }
}
