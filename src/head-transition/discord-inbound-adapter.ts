import type { DiscordMessagePreflightContext } from "../../extensions/discord/src/monitor/message-handler.preflight.types.js";
import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  type HeadTransitionInboundEvent,
  validateHeadTransitionInboundEvent,
} from "./contracts.js";

export function buildHeadTransitionDiscordInboundEvent(
  ctx: Pick<
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
  >,
): HeadTransitionInboundEvent {
  const messageId = (ctx.canonicalMessageId ?? ctx.message.id).trim();
  const idempotencyKey = buildHeadTransitionDiscordInboundIdempotencyKey({
    accountId: ctx.accountId,
    channelId: ctx.messageChannelId,
    messageId,
    inboundEventKind: ctx.inboundEventKind,
  });
  const event: HeadTransitionInboundEvent = {
    version: HEAD_TRANSITION_CONTRACT_VERSION,
    idempotencyKey,
    channel: "discord",
    accountId: ctx.accountId,
    sessionKey: ctx.route.sessionKey,
    messageId,
    senderId: ctx.sender.id,
    occurredAtMs: Date.parse(ctx.message.timestamp ?? ""),
    body: ctx.messageText || ctx.baseText,
    metadata: {
      agentId: ctx.route.agentId,
      discordChannelId: ctx.messageChannelId,
      inboundEventKind: ctx.inboundEventKind,
    },
  };
  const validation = validateHeadTransitionInboundEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid Discord Head inbound event: ${validation.reason}`);
  }
  return event;
}

export function buildHeadTransitionDiscordInboundIdempotencyKey(params: {
  accountId: string;
  channelId: string;
  messageId: string;
  inboundEventKind?: string;
}): string {
  const suffix = params.inboundEventKind === "room_event" ? ":room_event" : "";
  return `discord:${params.accountId}:${params.channelId}:${params.messageId}${suffix}`;
}
