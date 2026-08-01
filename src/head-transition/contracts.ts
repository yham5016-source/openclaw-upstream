export const HEAD_TRANSITION_CONTRACT_VERSION = 1 as const;

export type HeadTransitionChannel = "discord" | "gateway" | "device" | "cron" | "unknown";

export type HeadTransitionInboundEvent = {
  version: typeof HEAD_TRANSITION_CONTRACT_VERSION;
  idempotencyKey: string;
  channel: HeadTransitionChannel;
  accountId?: string;
  sessionKey: string;
  messageId?: string;
  senderId?: string;
  occurredAtMs: number;
  body: string;
  metadata?: Record<string, unknown>;
};

export type HeadTransitionDeliveryReceipt = {
  version: typeof HEAD_TRANSITION_CONTRACT_VERSION;
  idempotencyKey: string;
  sessionKey: string;
  deliveredAtMs: number;
  target: {
    channel: HeadTransitionChannel;
    to: string;
    accountId?: string;
  };
};

export type HeadTransitionWorkerCommand = {
  version: typeof HEAD_TRANSITION_CONTRACT_VERSION;
  idempotencyKey: string;
  workerId: string;
  kind: "code" | "research" | "review" | "device" | "generic";
  body: string;
  leaseExpiresAtMs: number;
  metadata?: Record<string, unknown>;
};

export type HeadTransitionWorkerResult = {
  version: typeof HEAD_TRANSITION_CONTRACT_VERSION;
  commandIdempotencyKey: string;
  workerId: string;
  status: "ok" | "failed" | "cancelled";
  body: string;
  completedAtMs: number;
  metadata?: Record<string, unknown>;
};

export type HeadTransitionDecision = {
  version: typeof HEAD_TRANSITION_CONTRACT_VERSION;
  idempotencyKey: string;
  sessionKey: string;
  status: "reply" | "needs_approval" | "dispatch_worker" | "noop" | "blocked";
  replyText?: string;
  workerCommand?: HeadTransitionWorkerCommand;
  metadata?: Record<string, unknown>;
};

type ValidationResult = { ok: true } | { ok: false; reason: string };

type RecordLike = Record<string, unknown>;

export function validateHeadTransitionInboundEvent(value: unknown): ValidationResult {
  const event = asRecord(value);
  if (!event) {
    return invalid("event must be an object");
  }
  const version = validateVersion(event);
  if (!version.ok) {
    return version;
  }
  return firstInvalid([
    nonEmptyString(event.idempotencyKey, "idempotencyKey"),
    knownChannel(event.channel, "channel"),
    nonEmptyString(event.sessionKey, "sessionKey"),
    finiteTimestamp(event.occurredAtMs, "occurredAtMs"),
    stringField(event.body, "body"),
    optionalRecord(event.metadata, "metadata"),
  ]);
}

export function validateHeadTransitionDecision(value: unknown): ValidationResult {
  const decision = asRecord(value);
  if (!decision) {
    return invalid("decision must be an object");
  }
  const version = validateVersion(decision);
  if (!version.ok) {
    return version;
  }
  const status = decision.status;
  const statusValid =
    status === "reply" ||
    status === "needs_approval" ||
    status === "dispatch_worker" ||
    status === "noop" ||
    status === "blocked";
  if (!statusValid) {
    return invalid("status must be a known Head decision status");
  }
  if (status === "reply" && typeof decision.replyText !== "string") {
    return invalid("reply decisions require replyText");
  }
  if (status === "dispatch_worker") {
    const command = validateHeadTransitionWorkerCommand(decision.workerCommand);
    if (!command.ok) {
      return invalid(`workerCommand invalid: ${command.reason}`);
    }
  }
  return firstInvalid([
    nonEmptyString(decision.idempotencyKey, "idempotencyKey"),
    nonEmptyString(decision.sessionKey, "sessionKey"),
    optionalRecord(decision.metadata, "metadata"),
  ]);
}

export function validateHeadTransitionWorkerCommand(value: unknown): ValidationResult {
  const command = asRecord(value);
  if (!command) {
    return invalid("worker command must be an object");
  }
  const version = validateVersion(command);
  if (!version.ok) {
    return version;
  }
  const kind = command.kind;
  const kindValid =
    kind === "code" ||
    kind === "research" ||
    kind === "review" ||
    kind === "device" ||
    kind === "generic";
  if (!kindValid) {
    return invalid("kind must be a known worker command kind");
  }
  return firstInvalid([
    nonEmptyString(command.idempotencyKey, "idempotencyKey"),
    nonEmptyString(command.workerId, "workerId"),
    stringField(command.body, "body"),
    finiteTimestamp(command.leaseExpiresAtMs, "leaseExpiresAtMs"),
    optionalRecord(command.metadata, "metadata"),
  ]);
}

export function validateHeadTransitionWorkerResult(value: unknown): ValidationResult {
  const result = asRecord(value);
  if (!result) {
    return invalid("worker result must be an object");
  }
  const version = validateVersion(result);
  if (!version.ok) {
    return version;
  }
  const status = result.status;
  if (status !== "ok" && status !== "failed" && status !== "cancelled") {
    return invalid("status must be a known worker result status");
  }
  return firstInvalid([
    nonEmptyString(result.commandIdempotencyKey, "commandIdempotencyKey"),
    nonEmptyString(result.workerId, "workerId"),
    stringField(result.body, "body"),
    finiteTimestamp(result.completedAtMs, "completedAtMs"),
    optionalRecord(result.metadata, "metadata"),
  ]);
}

export function validateHeadTransitionDeliveryReceipt(value: unknown): ValidationResult {
  const receipt = asRecord(value);
  if (!receipt) {
    return invalid("delivery receipt must be an object");
  }
  const version = validateVersion(receipt);
  if (!version.ok) {
    return version;
  }
  const target = asRecord(receipt.target);
  if (!target) {
    return invalid("target must be an object");
  }
  return firstInvalid([
    nonEmptyString(receipt.idempotencyKey, "idempotencyKey"),
    nonEmptyString(receipt.sessionKey, "sessionKey"),
    finiteTimestamp(receipt.deliveredAtMs, "deliveredAtMs"),
    knownChannel(target.channel, "target.channel"),
    nonEmptyString(target.to, "target.to"),
  ]);
}

function validateVersion(value: RecordLike): ValidationResult {
  return value.version === HEAD_TRANSITION_CONTRACT_VERSION
    ? valid()
    : invalid(`version must be ${HEAD_TRANSITION_CONTRACT_VERSION}`);
}

function asRecord(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function firstInvalid(results: ValidationResult[]): ValidationResult {
  return results.find((result) => !result.ok) ?? valid();
}

function valid(): ValidationResult {
  return { ok: true };
}

function invalid(reason: string): ValidationResult {
  return { ok: false, reason };
}

function nonEmptyString(value: unknown, field: string): ValidationResult {
  return typeof value === "string" && value.trim().length > 0
    ? valid()
    : invalid(`${field} must be a non-empty string`);
}

function stringField(value: unknown, field: string): ValidationResult {
  return typeof value === "string" ? valid() : invalid(`${field} must be a string`);
}

function knownChannel(value: unknown, field: string): ValidationResult {
  return value === "discord" ||
    value === "gateway" ||
    value === "device" ||
    value === "cron" ||
    value === "unknown"
    ? valid()
    : invalid(`${field} must be a known channel`);
}

function finiteTimestamp(value: unknown, field: string): ValidationResult {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? valid()
    : invalid(`${field} must be a non-negative finite number`);
}

function optionalRecord(value: unknown, field: string): ValidationResult {
  return value === undefined || asRecord(value) ? valid() : invalid(`${field} must be an object`);
}
