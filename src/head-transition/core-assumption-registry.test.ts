import { unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeNormalizedHash,
  migrateNormalizationVersion,
  normalizeAssumptionText,
  openCoreAssumptionRegistry,
  readRegistryMeta,
  registerCoreAssumption,
  type RegisterCoreAssumptionInput,
} from "./core-assumption-registry.js";

function tmpPath(): string {
  return `${globalThis.process.env.TMPDIR ?? "/tmp"}/core-assumption-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
}

function baseInput(
  overrides: Partial<RegisterCoreAssumptionInput> = {},
): RegisterCoreAssumptionInput {
  return {
    assumptionId: "ca_1",
    scopeType: "project",
    scopeId: "proj-1",
    kind: "constraint",
    canonicalStatement: "The API rate limit is 100 req/min",
    normalizationVersion: 1,
    status: "proposed",
    createdBy: "head",
    createdAt: 1,
    ...overrides,
  };
}

describe("computeNormalizedHash / normalizeAssumptionText", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeAssumptionText("  Foo   Bar  ")).toBe("foo bar");
  });

  it("produces the same hash for the same text+version and a different hash for a different version", () => {
    const a = computeNormalizedHash("foo bar", 1);
    const b = computeNormalizedHash("foo bar", 1);
    const c = computeNormalizedHash("foo bar", 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("openCoreAssumptionRegistry / registerCoreAssumption", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("bootstraps registry_meta at the caller's normalizationVersion on first write", () => {
    db = openCoreAssumptionRegistry(":memory:");
    const result = registerCoreAssumption(db, baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.normalizedText).toBe("the api rate limit is 100 req/min");
      expect(result.record.normalizedHash).toBe(
        computeNormalizedHash(result.record.normalizedText, 1),
      );
    }
    expect(readRegistryMeta(db, "project", "proj-1")).toEqual({ normalizationVersion: 1 });
  });

  it("rejects a duplicate (scopeType, scopeId, normalizedHash) registration", () => {
    db = openCoreAssumptionRegistry(":memory:");
    const first = registerCoreAssumption(db, baseInput({ assumptionId: "ca_1" }));
    expect(first.ok).toBe(true);

    const second = registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_2", canonicalStatement: "the api rate limit is 100 req/min" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("duplicate");
    }
  });

  it("allows the same statement text under a different scopeId", () => {
    db = openCoreAssumptionRegistry(":memory:");
    registerCoreAssumption(db, baseInput({ assumptionId: "ca_1", scopeId: "proj-1" }));
    const result = registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_2", scopeId: "proj-2" }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a write whose normalizationVersion does not match the registry's current version", () => {
    db = openCoreAssumptionRegistry(":memory:");
    registerCoreAssumption(db, baseInput({ assumptionId: "ca_1", normalizationVersion: 1 }));

    const result = registerCoreAssumption(
      db,
      baseInput({
        assumptionId: "ca_2",
        canonicalStatement: "a different statement entirely",
        normalizationVersion: 2,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("version");
    }
    // Rejection must not have mutated registry state.
    expect(readRegistryMeta(db, "project", "proj-1")).toEqual({ normalizationVersion: 1 });
  });
});

describe("BEGIN IMMEDIATE concurrency", () => {
  it("blocks a concurrent writer while another connection holds the write transaction", () => {
    const path = tmpPath();
    const dbA = openCoreAssumptionRegistry(path);
    const dbB = openCoreAssumptionRegistry(path);
    try {
      dbA.exec("BEGIN IMMEDIATE");
      expect(() => registerCoreAssumption(dbB, baseInput())).toThrow();
      dbA.exec("ROLLBACK");

      // Lock released: the same write now succeeds.
      const result = registerCoreAssumption(dbB, baseInput());
      expect(result.ok).toBe(true);
    } finally {
      dbA.close();
      dbB.close();
      unlinkSync(path);
    }
  });
});

describe("migrateNormalizationVersion", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("re-normalizes and re-hashes every row for the scope, then advances registry_meta", () => {
    db = openCoreAssumptionRegistry(":memory:");
    const trimOnly = (text: string) => text.trim();
    registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_1", canonicalStatement: "Foo Bar", normalizationVersion: 1 }),
      trimOnly,
    );

    const migration = migrateNormalizationVersion(
      db,
      "project",
      "proj-1",
      2,
      normalizeAssumptionText,
    );
    expect(migration.ok).toBe(true);
    if (migration.ok) {
      expect(migration.migratedCount).toBe(1);
    }
    expect(readRegistryMeta(db, "project", "proj-1")).toEqual({ normalizationVersion: 2 });

    // A write under the old version is now rejected; under the new version it succeeds.
    const oldVersionWrite = registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_2", canonicalStatement: "unrelated", normalizationVersion: 1 }),
    );
    expect(oldVersionWrite.ok).toBe(false);

    const newVersionWrite = registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_2", canonicalStatement: "unrelated", normalizationVersion: 2 }),
    );
    expect(newVersionWrite.ok).toBe(true);
  });

  it("rolls back the whole migration on a normalized_hash collision, leaving all rows and meta unchanged", () => {
    db = openCoreAssumptionRegistry(":memory:");
    const trimOnly = (text: string) => text.trim();
    registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_1", canonicalStatement: "Foo Bar", normalizationVersion: 1 }),
      trimOnly,
    );
    registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_2", canonicalStatement: "foo bar", normalizationVersion: 1 }),
      trimOnly,
    );

    // Case-folding normalization collapses "Foo Bar" and "foo bar" onto the same hash.
    const migration = migrateNormalizationVersion(
      db,
      "project",
      "proj-1",
      2,
      normalizeAssumptionText,
    );
    expect(migration.ok).toBe(false);
    if (!migration.ok) {
      expect(migration.reason).toContain("collision");
    }

    // Full rollback: registry_meta and both rows must be exactly as before the attempt.
    expect(readRegistryMeta(db, "project", "proj-1")).toEqual({ normalizationVersion: 1 });
    const rejectedRewrite = registerCoreAssumption(
      db,
      baseInput({ assumptionId: "ca_3", canonicalStatement: "Foo Bar", normalizationVersion: 1 }),
      trimOnly,
    );
    // Still duplicate under the untouched v1 hash -- proves ca_1's row was not rewritten.
    expect(rejectedRewrite.ok).toBe(false);
  });

  it("is scope-atomic: migrating one scope does not touch another scope's rows", () => {
    db = openCoreAssumptionRegistry(":memory:");
    const trimOnly = (text: string) => text.trim();
    registerCoreAssumption(
      db,
      baseInput({
        assumptionId: "ca_1",
        scopeId: "proj-1",
        canonicalStatement: "Foo",
        normalizationVersion: 1,
      }),
      trimOnly,
    );
    registerCoreAssumption(
      db,
      baseInput({
        assumptionId: "ca_2",
        scopeId: "proj-2",
        canonicalStatement: "Bar",
        normalizationVersion: 1,
      }),
      trimOnly,
    );

    migrateNormalizationVersion(db, "project", "proj-1", 2, normalizeAssumptionText);

    expect(readRegistryMeta(db, "project", "proj-1")).toEqual({ normalizationVersion: 2 });
    expect(readRegistryMeta(db, "project", "proj-2")).toEqual({ normalizationVersion: 1 });
  });
});
