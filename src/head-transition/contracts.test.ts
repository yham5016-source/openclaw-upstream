import { describe, expect, it } from "vitest";
import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  validateHeadTransitionDecision,
  validateHeadTransitionDeliveryReceipt,
  validateHeadTransitionInboundEvent,
  validateHeadTransitionWorkerResult,
} from "./contracts.js";

describe("Head transition contracts", () => {
  it("accepts the minimal Discord inbound event envelope", () => {
    expect(
      validateHeadTransitionInboundEvent({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "discord:default:channel-1:message-1",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:default:channel:channel-1",
        messageId: "message-1",
        senderId: "user-1",
        occurredAtMs: 1,
        body: "hello",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects stale or malformed inbound events before Head execution", () => {
    expect(
      validateHeadTransitionInboundEvent({
        version: 0,
        idempotencyKey: "event-1",
        channel: "discord",
        sessionKey: "agent:main:main",
        occurredAtMs: 1,
        body: "hello",
      }),
    ).toEqual({ ok: false, reason: "version must be 1" });

    expect(
      validateHeadTransitionInboundEvent({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "event-1",
        channel: "irc",
        sessionKey: "agent:main:main",
        occurredAtMs: 1,
        body: "hello",
      }),
    ).toEqual({ ok: false, reason: "channel must be a known channel" });
  });

  it("requires reply decisions to carry reply text", () => {
    expect(
      validateHeadTransitionDecision({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "decision-1",
        sessionKey: "agent:main:main",
        status: "reply",
      }),
    ).toEqual({ ok: false, reason: "reply decisions require replyText" });
  });

  it("validates dispatch decisions with nested worker commands", () => {
    expect(
      validateHeadTransitionDecision({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "decision-1",
        sessionKey: "agent:main:main",
        status: "dispatch_worker",
        workerCommand: {
          version: HEAD_TRANSITION_CONTRACT_VERSION,
          idempotencyKey: "worker-command-1",
          workerId: "glm",
          kind: "code",
          body: "run focused tests",
          leaseExpiresAtMs: 2,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects malformed worker results and accepts delivery receipts", () => {
    expect(
      validateHeadTransitionWorkerResult({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        commandIdempotencyKey: "worker-command-1",
        workerId: "glm",
        status: "late",
        body: "done",
        completedAtMs: 3,
      }),
    ).toEqual({ ok: false, reason: "status must be a known worker result status" });

    expect(
      validateHeadTransitionDeliveryReceipt({
        version: HEAD_TRANSITION_CONTRACT_VERSION,
        idempotencyKey: "delivery-1",
        sessionKey: "agent:main:main",
        deliveredAtMs: 4,
        target: {
          channel: "discord",
          to: "channel-1",
          accountId: "default",
        },
      }),
    ).toEqual({ ok: true });
  });
});
