import { describe, expect, it } from "vitest";
import { validateCavemanEnvelope } from "./caveman-envelope.js";
import {
  CAVEMAN_PAYLOAD_SCHEMA_VERSIONS,
  validateCavemanEnvelopeWithTaskPayload,
  validateCavemanTaskPayload,
  type CavemanTaskPayload,
} from "./caveman-payloads.js";

function baseEnvelope(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schema: (payload as Record<string, unknown>).schema,
    schemaVersion: "1",
    taskId: "task-1",
    producer: "glm",
    status: "ok",
    payload,
    evidenceRefs: [],
    exceptions: [],
    resourceUsage: { tokens: 1, wallSeconds: 1, costUsd: 0.01, toolCalls: 1 },
    ...overrides,
  };
}

const validPayloads: Record<CavemanTaskPayload["schema"], CavemanTaskPayload> = {
  "code_result.v1": {
    schema: "code_result.v1",
    filesChanged: ["src/a.ts"],
    diffSummary: "added a function",
  },
  "research_result.v1": {
    schema: "research_result.v1",
    findings: ["x happens because y"],
    sources: ["https://example.com"],
  },
  "review_result.v1": {
    schema: "review_result.v1",
    verdict: "approve",
    findings: [],
  },
  "device_result.v1": {
    schema: "device_result.v1",
    deviceId: "light-1",
    actionTaken: "turned_on",
    observedState: { on: true },
  },
  "generic_result.v1": {
    schema: "generic_result.v1",
    note: "contract could not express the result",
  },
};

describe("validateCavemanTaskPayload", () => {
  it("rejects a non-object payload", () => {
    const result = validateCavemanTaskPayload("nope");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown schema", () => {
    const result = validateCavemanTaskPayload({ schema: "made_up.v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("schema");
    }
  });

  for (const [schema, payload] of Object.entries(validPayloads)) {
    it(`accepts a well-formed ${schema} payload`, () => {
      const result = validateCavemanTaskPayload(payload);
      expect(result.ok).toBe(true);
    });
  }

  it("rejects code_result.v1 missing filesChanged", () => {
    const result = validateCavemanTaskPayload({
      schema: "code_result.v1",
      diffSummary: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("filesChanged");
    }
  });

  it("rejects research_result.v1 missing sources", () => {
    const result = validateCavemanTaskPayload({
      schema: "research_result.v1",
      findings: ["a"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sources");
    }
  });

  it("rejects review_result.v1 with an unknown verdict", () => {
    const result = validateCavemanTaskPayload({
      schema: "review_result.v1",
      verdict: "meh",
      findings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("verdict");
    }
  });

  it("rejects device_result.v1 missing deviceId", () => {
    const result = validateCavemanTaskPayload({
      schema: "device_result.v1",
      actionTaken: "on",
      observedState: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("deviceId");
    }
  });

  it("rejects generic_result.v1 missing note", () => {
    const result = validateCavemanTaskPayload({ schema: "generic_result.v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("note");
    }
  });
});

describe("CAVEMAN_PAYLOAD_SCHEMA_VERSIONS / schema-version consistency", () => {
  it("lists exactly the five known schemas at version 1", () => {
    expect(CAVEMAN_PAYLOAD_SCHEMA_VERSIONS).toEqual({
      "code_result.v1": "1",
      "research_result.v1": "1",
      "review_result.v1": "1",
      "device_result.v1": "1",
      "generic_result.v1": "1",
    });
  });
});

describe("validateCavemanEnvelopeWithTaskPayload (schema/version mismatch gate)", () => {
  it("accepts an envelope whose schemaVersion matches the payload schema's registered version", () => {
    const envelope = baseEnvelope(validPayloads["code_result.v1"], { schemaVersion: "1" });
    const result = validateCavemanEnvelopeWithTaskPayload(envelope);
    expect(result.ok).toBe(true);
  });

  it("rejects an envelope whose schemaVersion does not match the payload schema's registered version", () => {
    const envelope = baseEnvelope(validPayloads["code_result.v1"], { schemaVersion: "2" });
    const result = validateCavemanEnvelopeWithTaskPayload(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("version");
    }
  });

  it("rejects an envelope whose schema field disagrees with the payload's own schema field", () => {
    const envelope = baseEnvelope(validPayloads["code_result.v1"], {
      schema: "research_result.v1",
    });
    const result = validateCavemanEnvelopeWithTaskPayload(envelope);
    expect(result.ok).toBe(false);
  });

  it("still enforces the generic_result.v1 status restriction end to end", () => {
    const envelope = baseEnvelope(validPayloads["generic_result.v1"], { status: "ok" });
    const result = validateCavemanEnvelopeWithTaskPayload(envelope);
    expect(result.ok).toBe(false);
  });

  it("delegates through to validateCavemanEnvelope (sanity: reuses the same underlying gate)", () => {
    const envelope = baseEnvelope(validPayloads["code_result.v1"]);
    const direct = validateCavemanEnvelope(envelope as never, validateCavemanTaskPayload);
    const viaHelper = validateCavemanEnvelopeWithTaskPayload(envelope);
    expect(viaHelper).toEqual(direct);
  });
});
