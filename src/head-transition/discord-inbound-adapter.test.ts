import { describe, expect, it } from "vitest";
import type { DiscordMessagePreflightContext } from "../../extensions/discord/src/monitor/message-handler.preflight.types.js";
import {
  buildHeadTransitionDiscordInboundEvent,
  buildHeadTransitionDiscordInboundIdempotencyKey,
} from "./discord-inbound-adapter.js";

describe("buildHeadTransitionDiscordInboundEvent", () => {
  it("keeps Discord preflight ownership while materializing a Head inbound contract", () => {
    const event = buildHeadTransitionDiscordInboundEvent({
      accountId: "default",
      baseText: "raw text",
      canonicalMessageId: "canonical-1",
      inboundEventKind: "message",
      message: {
        id: "message-1",
        timestamp: "2026-07-31T01:00:00.000Z",
      },
      messageChannelId: "channel-1",
      messageText: "normalized text",
      route: {
        agentId: "main",
        sessionKey: "agent:main:discord:default:channel:channel-1",
      },
      sender: {
        id: "user-1",
      },
    } as unknown as Pick<
      DiscordMessagePreflightContext,
      | "accountId"
      | "baseText"
      | "canonicalMessageId"
      | "inboundEventKind"
      | "message"
      | "messageChannelId"
      | "messageText"
      | "route"
      | "sender"
    >);

    expect(event).toMatchObject({
      version: 1,
      idempotencyKey: "discord:default:channel-1:canonical-1",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:default:channel:channel-1",
      messageId: "canonical-1",
      senderId: "user-1",
      occurredAtMs: Date.parse("2026-07-31T01:00:00.000Z"),
      body: "normalized text",
      metadata: {
        agentId: "main",
        discordChannelId: "channel-1",
        inboundEventKind: "message",
      },
    });
  });

  it("marks room events separately so delivery dedupe can preserve room-event semantics", () => {
    expect(
      buildHeadTransitionDiscordInboundIdempotencyKey({
        accountId: "default",
        channelId: "channel-1",
        messageId: "message-1",
        inboundEventKind: "room_event",
      }),
    ).toBe("discord:default:channel-1:message-1:room_event");
  });

  it("fails closed when Discord timestamps cannot become contract timestamps", () => {
    expect(() =>
      buildHeadTransitionDiscordInboundEvent({
        accountId: "default",
        baseText: "raw text",
        inboundEventKind: "message",
        message: {
          id: "message-1",
          timestamp: "not-a-date",
        },
        messageChannelId: "channel-1",
        messageText: "normalized text",
        route: {
          agentId: "main",
          sessionKey: "agent:main:discord:default:channel:channel-1",
        },
        sender: {
          id: "user-1",
        },
      } as unknown as Pick<
        DiscordMessagePreflightContext,
        | "accountId"
        | "baseText"
        | "inboundEventKind"
        | "message"
        | "messageChannelId"
        | "messageText"
        | "route"
        | "sender"
      >),
    ).toThrow("occurredAtMs must be a non-negative finite number");
  });

  it("fails closed when Discord omits the message timestamp entirely", () => {
    expect(() =>
      buildHeadTransitionDiscordInboundEvent({
        accountId: "default",
        baseText: "raw text",
        inboundEventKind: "message",
        message: {
          id: "message-1",
        },
        messageChannelId: "channel-1",
        messageText: "normalized text",
        route: {
          agentId: "main",
          sessionKey: "agent:main:discord:default:channel:channel-1",
        },
        sender: {
          id: "user-1",
        },
      } as unknown as Pick<
        DiscordMessagePreflightContext,
        | "accountId"
        | "baseText"
        | "inboundEventKind"
        | "message"
        | "messageChannelId"
        | "messageText"
        | "route"
        | "sender"
      >),
    ).toThrow("occurredAtMs must be a non-negative finite number");
  });
});
