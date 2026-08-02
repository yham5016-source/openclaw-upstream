import { describe, expect, it } from "vitest";
import {
  CAVEMAN_GENERIC_PAYLOAD_SCHEMA,
  validateCavemanEnvelope,
  type CavemanEnvelope,
} from "./caveman-envelope.js";

type StubPayload = { schema: string };

function makeEnvelope(overrides: Partial<CavemanEnvelope<StubPayload>> = {}): unknown {
  return {
    schema: "code_result.v1",
    schemaVersion: "1",
    taskId: "task-1",
    producer: "glm",
    status: "ok",
    payload: { schema: "code_result.v1" },
    evidenceRefs: [],
    exceptions: [],
    resourceUsage: { tokens: 100, wallSeconds: 1, costUsd: 0.01, toolCalls: 1 },
    ...overrides,
  };
}

const acceptAnyPayload = () => ({ ok: true as const });

describe("validateCavemanEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const result = validateCavemanEnvelope(makeEnvelope(), acceptAnyPayload);
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object value", () => {
    const result = validateCavemanEnvelope("not an envelope", acceptAnyPayload);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({ status: "done" as never }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("status");
  });

  it("rejects a missing taskId", () => {
    const result = validateCavemanEnvelope(makeEnvelope({ taskId: "" }), acceptAnyPayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("taskId");
  });

  it("rejects a missing producer", () => {
    const result = validateCavemanEnvelope(makeEnvelope({ producer: "" }), acceptAnyPayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("producer");
  });

  it("rejects evidenceRefs that is not a string array", () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({ evidenceRefs: [1, 2] as never }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("evidenceRefs");
  });

  it("rejects an exception with an unknown type", () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({
        exceptions: [{ type: "made_up", detail: "x", raisedAtMs: 1 } as never],
      }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("exceptions");
  });

  it("accepts each of the five known exception types", () => {
    const types = [
      "needs_clarification",
      "schema_mismatch",
      "out_of_scope_finding",
      "assumption_violation",
      "novel_observation",
    ] as const;
    for (const type of types) {
      const result = validateCavemanEnvelope(
        makeEnvelope({ exceptions: [{ type, detail: "x", raisedAtMs: 1 }] }),
        acceptAnyPayload,
      );
      expect(result.ok).toBe(true);
    }
  });

  it("rejects resourceUsage missing a required numeric field", () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({ resourceUsage: { tokens: 1, wallSeconds: 1, costUsd: 0.01 } as never }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resourceUsage");
  });

  it("delegates payload validation and surfaces a payload failure", () => {
    const rejectPayload = () => ({ ok: false as const, reason: "payload rejected by delegate" });
    const result = validateCavemanEnvelope(makeEnvelope(), rejectPayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("payload rejected by delegate");
  });

  it(`rejects a ${CAVEMAN_GENERIC_PAYLOAD_SCHEMA} payload with status ok`, () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({
        status: "ok",
        payload: { schema: CAVEMAN_GENERIC_PAYLOAD_SCHEMA },
      }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(CAVEMAN_GENERIC_PAYLOAD_SCHEMA);
  });

  it(`rejects a ${CAVEMAN_GENERIC_PAYLOAD_SCHEMA} payload with status failed`, () => {
    const result = validateCavemanEnvelope(
      makeEnvelope({
        status: "failed",
        payload: { schema: CAVEMAN_GENERIC_PAYLOAD_SCHEMA },
      }),
      acceptAnyPayload,
    );
    expect(result.ok).toBe(false);
  });

  it.each(["blocked", "partial"] as const)(
    `accepts a ${CAVEMAN_GENERIC_PAYLOAD_SCHEMA} payload with status %s`,
    (status) => {
      const result = validateCavemanEnvelope(
        makeEnvelope({ status, payload: { schema: CAVEMAN_GENERIC_PAYLOAD_SCHEMA } }),
        acceptAnyPayload,
      );
      expect(result.ok).toBe(true);
    },
  );
});
