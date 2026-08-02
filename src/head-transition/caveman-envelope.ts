/**
 * "Caveman" is the Head/worker message contract shape: a typed envelope
 * (this file) wrapping a per-task-kind payload (caveman-payloads.ts). It is
 * independent of and not wired into HeadTransitionWorkerResult/WorkerCommand
 * (contracts.ts) — that integration is a follow-up PR.
 */

export const CAVEMAN_GENERIC_PAYLOAD_SCHEMA = "generic_result.v1";

/** Statuses a generic_result.v1 payload may carry — never a completion claim. */
const GENERIC_PAYLOAD_ALLOWED_STATUSES = new Set(["blocked", "partial"]);

export type CavemanEnvelopeStatus = "ok" | "partial" | "failed" | "blocked" | "cancelled";

export type ContractExceptionType =
  | "needs_clarification"
  | "schema_mismatch"
  | "out_of_scope_finding"
  | "assumption_violation"
  | "novel_observation";

export interface ContractException {
  type: ContractExceptionType;
  detail: string;
  raisedAtMs: number;
}

export interface ResourceUsage {
  tokens: number;
  wallSeconds: number;
  costUsd: number;
  toolCalls: number;
}

export interface CavemanEnvelope<TPayload> {
  schema: string;
  schemaVersion: string;
  taskId: string;
  producer: string;
  status: CavemanEnvelopeStatus;
  payload: TPayload;
  evidenceRefs: string[];
  exceptions: ContractException[];
  resourceUsage: ResourceUsage;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };
export type PayloadValidator = (payload: unknown) => ValidationResult;

export type RecordLike = Record<string, unknown>;

export function validateCavemanEnvelope(
  value: unknown,
  validatePayload: PayloadValidator,
): ValidationResult {
  const envelope = asRecord(value);
  if (!envelope) {
    return invalid("envelope must be an object");
  }

  const structural = firstInvalid([
    nonEmptyString(envelope.schema, "schema"),
    nonEmptyString(envelope.schemaVersion, "schemaVersion"),
    nonEmptyString(envelope.taskId, "taskId"),
    nonEmptyString(envelope.producer, "producer"),
    knownStatus(envelope.status, "status"),
    stringArray(envelope.evidenceRefs, "evidenceRefs"),
    exceptionArray(envelope.exceptions, "exceptions"),
    validateResourceUsage(envelope.resourceUsage),
  ]);
  if (!structural.ok) {
    return structural;
  }

  const genericStatusCheck = validateGenericPayloadStatus(envelope);
  if (!genericStatusCheck.ok) {
    return genericStatusCheck;
  }

  return validatePayload(envelope.payload);
}

function validateGenericPayloadStatus(envelope: RecordLike): ValidationResult {
  const payload = asRecord(envelope.payload);
  if (payload?.schema !== CAVEMAN_GENERIC_PAYLOAD_SCHEMA) {
    return valid();
  }
  return GENERIC_PAYLOAD_ALLOWED_STATUSES.has(envelope.status as string)
    ? valid()
    : invalid(
        `${CAVEMAN_GENERIC_PAYLOAD_SCHEMA} payload only permits status blocked or partial, never a completion claim`,
      );
}

function validateResourceUsage(value: unknown): ValidationResult {
  const usage = asRecord(value);
  if (!usage) {
    return invalid("resourceUsage must be an object");
  }
  return firstInvalid([
    finiteNumber(usage.tokens, "resourceUsage.tokens"),
    finiteNumber(usage.wallSeconds, "resourceUsage.wallSeconds"),
    finiteNumber(usage.costUsd, "resourceUsage.costUsd"),
    finiteNumber(usage.toolCalls, "resourceUsage.toolCalls"),
  ]);
}

const KNOWN_EXCEPTION_TYPES = new Set<ContractExceptionType>([
  "needs_clarification",
  "schema_mismatch",
  "out_of_scope_finding",
  "assumption_violation",
  "novel_observation",
]);

function exceptionArray(value: unknown, field: string): ValidationResult {
  if (!Array.isArray(value)) {
    return invalid(`${field} must be an array`);
  }
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry);
    if (!record) {
      return invalid(`${field}[${index}] must be an object`);
    }
    if (!KNOWN_EXCEPTION_TYPES.has(record.type as ContractExceptionType)) {
      return invalid(`${field}[${index}].type must be a known ContractExceptionType`);
    }
    const detail = stringField(record.detail, `${field}[${index}].detail`);
    if (!detail.ok) {
      return detail;
    }
    const raisedAtMs = finiteNumber(record.raisedAtMs, `${field}[${index}].raisedAtMs`);
    if (!raisedAtMs.ok) {
      return raisedAtMs;
    }
  }
  return valid();
}

// ── Shared validation primitives (also used by caveman-payloads.ts) ────

export function asRecord(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

export function firstInvalid(results: ValidationResult[]): ValidationResult {
  return results.find((result) => !result.ok) ?? valid();
}

export function valid(): ValidationResult {
  return { ok: true };
}

export function invalid(reason: string): ValidationResult {
  return { ok: false, reason };
}

export function nonEmptyString(value: unknown, field: string): ValidationResult {
  return typeof value === "string" && value.trim().length > 0
    ? valid()
    : invalid(`${field} must be a non-empty string`);
}

export function stringField(value: unknown, field: string): ValidationResult {
  return typeof value === "string" ? valid() : invalid(`${field} must be a string`);
}

export function finiteNumber(value: unknown, field: string): ValidationResult {
  return typeof value === "number" && Number.isFinite(value)
    ? valid()
    : invalid(`${field} must be a finite number`);
}

export function stringArray(value: unknown, field: string): ValidationResult {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? valid()
    : invalid(`${field} must be an array of strings`);
}

function knownStatus(value: unknown, field: string): ValidationResult {
  return value === "ok" ||
    value === "partial" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled"
    ? valid()
    : invalid(`${field} must be a known CavemanEnvelopeStatus`);
}
