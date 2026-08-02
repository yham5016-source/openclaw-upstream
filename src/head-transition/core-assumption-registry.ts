// SQLite-backed core_assumption_ids registry (ASC §3). Separate from and
// simpler than head-transition's ledger: this module owns duplicate-premise
// rejection and normalization-version migration, not event replay.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";

export type CoreAssumptionKind = "causal" | "constraint" | "environment" | "data" | "method";
export type CoreAssumptionStatus = "proposed" | "active" | "challenged" | "retired" | "superseded";
export type CoreAssumptionScopeType = "task" | "project" | "global";

export interface CoreAssumptionRecord {
  assumptionId: string;
  scopeType: CoreAssumptionScopeType;
  scopeId: string;
  kind: CoreAssumptionKind;
  canonicalStatement: string;
  normalizedText: string;
  normalizationVersion: number;
  normalizedHash: string;
  status: CoreAssumptionStatus;
  supersedesId?: string;
  createdBy: string;
  createdAt: number;
  retiredAt?: number;
  retirementReason?: string;
  version: number;
}

interface CoreAssumptionRow {
  assumption_id: string;
  scope_type: string;
  scope_id: string;
  kind: string;
  canonical_statement: string;
  normalized_text: string;
  normalization_version: number;
  normalized_hash: string;
  status: string;
  supersedes_id: string | null;
  created_by: string;
  created_at: number;
  retired_at: number | null;
  retirement_reason: string | null;
  version: number;
}

interface CoreAssumptionRegistryMetaRow {
  scope_type: string;
  scope_id: string;
  normalization_version: number;
}

interface CoreAssumptionDatabase {
  core_assumptions: CoreAssumptionRow;
  core_assumption_registry_meta: CoreAssumptionRegistryMetaRow;
}

function getRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CoreAssumptionDatabase>(db);
}

/** ASC §3, e.g. whitespace/case folding. */
export function normalizeAssumptionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Hash of normalizedText scoped to the normalizationVersion that produced it. */
export function computeNormalizedHash(
  normalizedText: string,
  normalizationVersion: number,
): string {
  return createHash("sha256").update(`v${normalizationVersion}:${normalizedText}`).digest("hex");
}

export function openCoreAssumptionRegistry(location: string): DatabaseSync {
  const db = openNodeSqliteDatabase(location);
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_assumptions (
      assumption_id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      canonical_statement TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      normalization_version INTEGER NOT NULL,
      normalized_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER,
      retirement_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(scope_type, scope_id, normalized_hash)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_assumption_aliases (
      assumption_id TEXT NOT NULL,
      alias_text TEXT NOT NULL,
      alias_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (assumption_id, alias_hash),
      FOREIGN KEY (assumption_id) REFERENCES core_assumptions(assumption_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_assumption_registry_meta (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      normalization_version INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id)
    )
  `);
  return db;
}

export interface RegistryMeta {
  normalizationVersion: number;
}

export function readRegistryMeta(
  db: DatabaseSync,
  scopeType: CoreAssumptionScopeType,
  scopeId: string,
): RegistryMeta | null {
  const rows = executeSqliteQuerySync(
    db,
    getRegistryKysely(db)
      .selectFrom("core_assumption_registry_meta")
      .select("normalization_version")
      .where("scope_type", "=", scopeType)
      .where("scope_id", "=", scopeId)
      .limit(1),
  ).rows;
  const [row] = rows;
  return row ? { normalizationVersion: row.normalization_version } : null;
}

export interface RegisterCoreAssumptionInput {
  assumptionId: string;
  scopeType: CoreAssumptionScopeType;
  scopeId: string;
  kind: CoreAssumptionKind;
  canonicalStatement: string;
  normalizationVersion: number;
  status: CoreAssumptionStatus;
  createdBy: string;
  createdAt: number;
  supersedesId?: string;
}

export type RegisterOutcome =
  | { ok: true; record: CoreAssumptionRecord }
  | { ok: false; reason: string };

/**
 * Register one assumption under the registry's current normalization_version
 * (bootstrapping it if this is the scope's first write). Runs inside
 * BEGIN IMMEDIATE so the version check and insert see one consistent
 * "current version" and block on a concurrent writer for the same DB file.
 */
export function registerCoreAssumption(
  db: DatabaseSync,
  input: RegisterCoreAssumptionInput,
  normalize: (text: string) => string = normalizeAssumptionText,
): RegisterOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const meta = readRegistryMeta(db, input.scopeType, input.scopeId);
    const currentVersion = meta?.normalizationVersion ?? input.normalizationVersion;
    if (input.normalizationVersion !== currentVersion) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: `normalizationVersion ${input.normalizationVersion} does not match the registry's current version ${currentVersion}; changing version requires migrateNormalizationVersion`,
      };
    }
    if (!meta) {
      executeSqliteQuerySync(
        db,
        getRegistryKysely(db).insertInto("core_assumption_registry_meta").values({
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          normalization_version: currentVersion,
        }),
      );
    }

    const normalizedText = normalize(input.canonicalStatement);
    const normalizedHash = computeNormalizedHash(normalizedText, currentVersion);

    try {
      executeSqliteQuerySync(
        db,
        getRegistryKysely(db)
          .insertInto("core_assumptions")
          .values({
            assumption_id: input.assumptionId,
            scope_type: input.scopeType,
            scope_id: input.scopeId,
            kind: input.kind,
            canonical_statement: input.canonicalStatement,
            normalized_text: normalizedText,
            normalization_version: currentVersion,
            normalized_hash: normalizedHash,
            status: input.status,
            supersedes_id: input.supersedesId ?? null,
            created_by: input.createdBy,
            created_at: input.createdAt,
            retired_at: null,
            retirement_reason: null,
            version: 1,
          }),
      );
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) {
        return {
          ok: false,
          reason:
            "duplicate assumption: an identical normalized statement is already registered for this scope",
        };
      }
      throw error;
    }

    db.exec("COMMIT");
    return {
      ok: true,
      record: {
        assumptionId: input.assumptionId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        kind: input.kind,
        canonicalStatement: input.canonicalStatement,
        normalizedText,
        normalizationVersion: currentVersion,
        normalizedHash,
        status: input.status,
        supersedesId: input.supersedesId,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        version: 1,
      },
    };
  } catch (error) {
    rollbackSafely(db);
    throw error;
  }
}

export type MigrationOutcome = { ok: true; migratedCount: number } | { ok: false; reason: string };

/**
 * Re-normalize and re-hash every row for one (scopeType, scopeId) under a
 * new normalize function, check for normalized_hash collisions before
 * committing anything, then advance registry_meta. Scope-atomic: one
 * (scopeType, scopeId) per call. Any collision rolls back the whole
 * migration -- no row and no meta row change.
 */
export function migrateNormalizationVersion(
  db: DatabaseSync,
  scopeType: CoreAssumptionScopeType,
  scopeId: string,
  newVersion: number,
  normalize: (text: string) => string,
): MigrationOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = executeSqliteQuerySync(
      db,
      getRegistryKysely(db)
        .selectFrom("core_assumptions")
        .selectAll()
        .where("scope_type", "=", scopeType)
        .where("scope_id", "=", scopeId),
    ).rows;

    const reNormalized = rows.map((row) => {
      const normalizedText = normalize(row.canonical_statement);
      return {
        assumptionId: row.assumption_id,
        normalizedText,
        normalizedHash: computeNormalizedHash(normalizedText, newVersion),
      };
    });

    const seenHashes = new Set<string>();
    for (const row of reNormalized) {
      if (seenHashes.has(row.normalizedHash)) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason: `migration aborted: normalized_hash collision after re-normalization (${row.normalizedHash})`,
        };
      }
      seenHashes.add(row.normalizedHash);
    }

    for (const row of reNormalized) {
      executeSqliteQuerySync(
        db,
        getRegistryKysely(db)
          .updateTable("core_assumptions")
          .set({
            normalized_text: row.normalizedText,
            normalized_hash: row.normalizedHash,
            normalization_version: newVersion,
          })
          .where("assumption_id", "=", row.assumptionId),
      );
    }

    executeSqliteQuerySync(
      db,
      getRegistryKysely(db)
        .insertInto("core_assumption_registry_meta")
        .values({ scope_type: scopeType, scope_id: scopeId, normalization_version: newVersion })
        .onConflict((conflict) =>
          conflict
            .columns(["scope_type", "scope_id"])
            .doUpdateSet({ normalization_version: newVersion }),
        ),
    );

    db.exec("COMMIT");
    return { ok: true, migratedCount: reNormalized.length };
  } catch (error) {
    rollbackSafely(db);
    throw error;
  }
}

function rollbackSafely(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was open (e.g. the failure happened before BEGIN
    // IMMEDIATE completed) -- nothing to roll back.
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
