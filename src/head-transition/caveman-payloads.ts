import {
  asRecord,
  firstInvalid,
  invalid,
  nonEmptyString,
  stringArray,
  stringField,
  valid,
  validateCavemanEnvelope,
  type CavemanEnvelope,
  type RecordLike,
  type ValidationResult,
} from "./caveman-envelope.js";

/** Every known Caveman payload schema mapped to its registered version string. */
export const CAVEMAN_PAYLOAD_SCHEMA_VERSIONS = {
  "code_result.v1": "1",
  "research_result.v1": "1",
  "review_result.v1": "1",
  "device_result.v1": "1",
  "generic_result.v1": "1",
} as const;

type CavemanPayloadSchema = keyof typeof CAVEMAN_PAYLOAD_SCHEMA_VERSIONS;

interface CodeResultPayload {
  schema: "code_result.v1";
  filesChanged: string[];
  diffSummary: string;
  testResults?: { passed: number; failed: number };
}

interface ResearchResultPayload {
  schema: "research_result.v1";
  findings: string[];
  sources: string[];
}

interface ReviewResultPayload {
  schema: "review_result.v1";
  verdict: "approve" | "request_changes" | "block";
  findings: string[];
}

interface DeviceResultPayload {
  schema: "device_result.v1";
  deviceId: string;
  actionTaken: string;
  observedState: Record<string, unknown>;
}

/**
 * Emergency envelope only — never a completion type. See
 * CAVEMAN_GENERIC_PAYLOAD_SCHEMA's status restriction in caveman-envelope.ts
 * and the budget-extension gate in progress-grade.ts.
 */
interface GenericResultPayload {
  schema: "generic_result.v1";
  note: string;
}

export type CavemanTaskPayload =
  | CodeResultPayload
  | ResearchResultPayload
  | ReviewResultPayload
  | DeviceResultPayload
  | GenericResultPayload;

export function validateCavemanTaskPayload(value: unknown): ValidationResult {
  const record = asRecord(value);
  if (!record) {
    return invalid("payload must be an object");
  }
  const schema = record.schema;
  if (typeof schema !== "string" || !isKnownSchema(schema)) {
    return invalid("payload.schema must be a known Caveman payload schema");
  }
  switch (schema) {
    case "code_result.v1":
      return validateCodeResultPayload(record);
    case "research_result.v1":
      return validateResearchResultPayload(record);
    case "review_result.v1":
      return validateReviewResultPayload(record);
    case "device_result.v1":
      return validateDeviceResultPayload(record);
    case "generic_result.v1":
      return validateGenericResultPayload(record);
  }
}

/**
 * Convenience combinator: full-envelope validation (structure + status/schema
 * gates + per-kind payload shape) using the known Caveman payload registry.
 */
export function validateCavemanEnvelopeWithTaskPayload(value: unknown): ValidationResult {
  const envelope = asRecord(value);
  if (!envelope) {
    return invalid("envelope must be an object");
  }
  const versionCheck = validateSchemaVersionConsistency(envelope);
  if (!versionCheck.ok) {
    return versionCheck;
  }
  return validateCavemanEnvelope(value as CavemanEnvelope<unknown>, validateCavemanTaskPayload);
}

function validateSchemaVersionConsistency(envelope: RecordLike): ValidationResult {
  const schema = envelope.schema;
  const schemaVersion = envelope.schemaVersion;
  const payload = asRecord(envelope.payload);

  if (payload && typeof payload.schema === "string" && payload.schema !== schema) {
    return invalid("envelope.schema must match payload.schema");
  }
  if (typeof schema === "string" && isKnownSchema(schema)) {
    const expectedVersion = CAVEMAN_PAYLOAD_SCHEMA_VERSIONS[schema];
    if (schemaVersion !== expectedVersion) {
      return invalid(
        `schemaVersion "${String(schemaVersion)}" does not match the registered version "${expectedVersion}" for schema "${schema}"`,
      );
    }
  }
  return valid();
}

function isKnownSchema(schema: string): schema is CavemanPayloadSchema {
  return Object.hasOwn(CAVEMAN_PAYLOAD_SCHEMA_VERSIONS, schema);
}

function validateCodeResultPayload(record: RecordLike): ValidationResult {
  return firstInvalid([
    stringArray(record.filesChanged, "filesChanged"),
    stringField(record.diffSummary, "diffSummary"),
  ]);
}

function validateResearchResultPayload(record: RecordLike): ValidationResult {
  return firstInvalid([
    stringArray(record.findings, "findings"),
    stringArray(record.sources, "sources"),
  ]);
}

const KNOWN_VERDICTS = new Set(["approve", "request_changes", "block"]);

function validateReviewResultPayload(record: RecordLike): ValidationResult {
  if (!KNOWN_VERDICTS.has(record.verdict as string)) {
    return invalid("verdict must be one of approve, request_changes, block");
  }
  return stringArray(record.findings, "findings");
}

function validateDeviceResultPayload(record: RecordLike): ValidationResult {
  return firstInvalid([
    nonEmptyString(record.deviceId, "deviceId"),
    stringField(record.actionTaken, "actionTaken"),
    asRecord(record.observedState) ? valid() : invalid("observedState must be an object"),
  ]);
}

function validateGenericResultPayload(record: RecordLike): ValidationResult {
  return stringField(record.note, "note");
}
