import {
  HEAD_TRANSITION_CONTRACT_VERSION,
  type HeadTransitionInboundEvent,
  validateHeadTransitionInboundEvent,
} from "./contracts.js";

/**
 * Structural subset of the Discord extension's DiscordMessagePreflightContext,
 * kept local so core (src/head-transition) never imports extensions/discord
 * internals directly -- check-tsgo-core-boundary forbids bundled extension
 * files from reaching the core tsgo graph. Any real
 * DiscordMessagePreflightContext already satisfies this shape structurally.
 */
export interface DiscordInboundEventSource {
  accountId: string;
  baseText: string;
  canonicalMessageId?: string;
  inboundEventKind?: string;
  message: { id: string; timestamp?: string };
  messageChannelId: string;
  messageText: string;
  route: { agentId: string; sessionKey: string };
  sender: { id: string };
}

export function buildHeadTransitionDiscordInboundEvent(
  ctx: DiscordInboundEventSource,
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
