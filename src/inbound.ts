/** Inbound XMPP authorization, routing, and text reply delivery. */

import { xml } from '@xmpp/client';
import { randomUUID } from 'crypto';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { bareJid } from './config-schema.js';
import { getXmppRuntime } from './runtime.js';
import { normalizeAllowFrom, isSenderAllowed } from './normalize.js';
import type { XmppConfig, XmppInboundMessage, Logger, ChannelAccountStatusPatch } from './types.js';
import { activeClients, recordInboundMessageId } from './state.js';
import { sendChatState, sendChatMarker } from './chat-state.js';
import { getMucOccupantRealJid } from './muc-identity.js';
import {
  buildReplyElement,
  buildReplyFallbackPrefix,
  buildReplyFallbackMarker,
} from './replies.js';

type SenderFacts = {
  senderBare: string;
  senderFull: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
};

type SenderAccess = {
  allowed: boolean;
  isOwner: boolean;
  senderIdentity: string;
};

function isConfiguredRoom(config: XmppConfig, roomJid: string | undefined): boolean {
  if (!roomJid) {
    return false;
  }
  const room = bareJid(roomJid).toLowerCase();
  return config.groups?.some((entry) => bareJid(entry).toLowerCase() === room) ?? false;
}

async function sendPairingChallenge(
  accountId: string,
  senderBare: string,
  log?: Logger
): Promise<void> {
  const rt = getXmppRuntime();
  const client = activeClients.get(accountId);
  if (!client) {
    return;
  }

  try {
    const { code, created } = await rt.channel.pairing.upsertPairingRequest({
      channel: 'xmpp',
      accountId,
      id: senderBare,
      meta: { jid: senderBare },
    });
    if (!created) {
      return;
    }

    const text = rt.channel.pairing.buildPairingReply({
      channel: 'xmpp',
      idLine: `Your XMPP JID: ${senderBare}`,
      code,
    });
    await client.send(
      xml(
        'message',
        { to: senderBare, type: 'chat', id: `pairing_${Date.now()}` },
        xml('body', {}, text)
      )
    );
    log?.info?.(`[${accountId}] Created pairing request for ${senderBare}`);
  } catch (err) {
    log?.warn?.(
      `[${accountId}] Failed to create or send pairing challenge: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Resolve sender access before routing or session creation.
 * Empty allowlists never match; explicit `open` remains supported.
 */
async function authorizeSender(
  facts: SenderFacts,
  accountId: string,
  config: XmppConfig,
  issuePairing: boolean,
  log?: Logger
): Promise<SenderAccess> {
  const owners = normalizeAllowFrom(config.allowFrom);

  if (facts.isGroup) {
    const roomJid = facts.roomJid ? bareJid(facts.roomJid) : undefined;
    if (!isConfiguredRoom(config, roomJid)) {
      log?.debug?.(`[XMPP] Blocked message from undeclared room ${roomJid ?? 'unknown'}`);
      return { allowed: false, isOwner: false, senderIdentity: facts.senderFull };
    }

    const realJid =
      roomJid && facts.senderNick
        ? getMucOccupantRealJid(accountId, roomJid, facts.senderNick)
        : undefined;
    const senderIdentity = realJid ?? facts.senderFull;
    const isOwner = realJid ? isSenderAllowed(owners, realJid) : false;
    const groupPolicy = config.groupPolicy ?? 'allowlist';

    if (groupPolicy === 'open') {
      return { allowed: true, isOwner, senderIdentity };
    }

    if (!realJid) {
      log?.warn?.(`[XMPP] Blocked group sender ${facts.senderFull}: real JID is not verifiable`);
      return { allowed: false, isOwner: false, senderIdentity };
    }

    const groupAllowlist = normalizeAllowFrom(config.groupAllowFrom ?? config.allowFrom);
    if (!isSenderAllowed(groupAllowlist, realJid)) {
      log?.debug?.(`[XMPP] Blocked group sender ${realJid}: not in groupAllowFrom`);
      return { allowed: false, isOwner, senderIdentity: realJid };
    }

    return { allowed: true, isOwner, senderIdentity: realJid };
  }

  const isOwner = isSenderAllowed(owners, facts.senderBare);
  if (isOwner) {
    return { allowed: true, isOwner: true, senderIdentity: facts.senderBare };
  }

  const dmPolicy = config.dmPolicy ?? 'pairing';
  if (dmPolicy === 'open') {
    return { allowed: true, isOwner: false, senderIdentity: facts.senderBare };
  }

  if (dmPolicy === 'allowlist') {
    const dmAllowlist = normalizeAllowFrom(config.dmAllowlist);
    return {
      allowed: isSenderAllowed(dmAllowlist, facts.senderBare),
      isOwner: false,
      senderIdentity: facts.senderBare,
    };
  }

  if (dmPolicy === 'pairing') {
    try {
      const approved = await getXmppRuntime().channel.pairing.readAllowFromStore({
        channel: 'xmpp',
        accountId,
      });
      if (isSenderAllowed(normalizeAllowFrom(approved.map(String)), facts.senderBare)) {
        return { allowed: true, isOwner: false, senderIdentity: facts.senderBare };
      }
    } catch (err) {
      log?.warn?.(
        `[${accountId}] Pairing allowlist unavailable; denying ${facts.senderBare}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (issuePairing) {
      await sendPairingChallenge(accountId, facts.senderBare, log);
    }
  }

  log?.debug?.(`[XMPP] Blocked direct sender ${facts.senderBare} (dmPolicy=${dmPolicy})`);
  return { allowed: false, isOwner: false, senderIdentity: facts.senderBare };
}

/** Validate an inbound text message and route it to OpenClaw. */
export async function handleInboundMessage(
  message: XmppInboundMessage,
  cfg: OpenClawConfig,
  accountId: string,
  config: XmppConfig,
  log?: Logger,
  setStatus?: (patch: ChannelAccountStatusPatch) => void
): Promise<void> {
  setStatus?.({ accountId, lastInboundAt: Date.now() });

  const senderBare = bareJid(message.from).toLowerCase();
  const access = await authorizeSender(
    {
      senderBare,
      senderFull: message.from,
      isGroup: message.isGroup,
      roomJid: message.roomJid,
      senderNick: message.senderNick,
    },
    accountId,
    config,
    true,
    log
  );
  if (!access.allowed) {
    return;
  }

  const rt = getXmppRuntime();
  const senderIdentity = access.senderIdentity;
  log?.info?.(`[XMPP] Authorized inbound text from=${senderIdentity} isGroup=${message.isGroup}`);

  if (config.sendReadReceipts !== false && message.id && !message.isGroup) {
    await sendChatMarker(accountId, senderBare, message.id, 'displayed', log);
  }

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'xmpp',
    accountId,
    peer: {
      kind: message.isGroup ? 'group' : 'direct',
      id: message.isGroup ? message.roomJid! : senderBare,
    },
  });
  const storePath = rt.channel.session.resolveStorePath(
    (cfg as { session?: { store?: string } }).session?.store,
    { agentId: route.agentId }
  );

  let displayBody = message.body;
  if (message.oobUrl && !displayBody.includes(message.oobUrl)) {
    const description = message.oobDesc ? ` (${message.oobDesc})` : '';
    displayBody = `${displayBody ? `${displayBody}\n` : ''}[Shared URL: ${message.oobUrl}${description}]`;
  }

  const msgId = message.stanzaId || message.id || `xmpp-${Date.now()}`;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: displayBody,
    RawBody: message.body,
    CommandBody: displayBody,
    From: `xmpp:${message.isGroup ? message.from : senderIdentity}`,
    To: `xmpp:${message.to}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: message.isGroup ? 'group' : 'direct',
    ConversationLabel: message.isGroup ? message.roomJid : senderBare,
    SenderName: message.senderNick || senderBare.split('@')[0],
    SenderId: senderIdentity,
    Provider: 'xmpp',
    Surface: 'xmpp',
    MessageSid: msgId,
    messageId: msgId,
    ReplyToId: message.replyToId,
    ReplyToBody: message.replyToBody,
    OriginatingChannel: 'xmpp' as const,
    OriginatingTo: `xmpp:${message.isGroup ? message.roomJid : senderBare}`,
    CommandAuthorized: access.isOwner,
    InboundAccessAuthorized: true,
  });

  const inboundMessageId = message.isGroup
    ? message.stanzaId || message.id
    : message.originId || message.rawStanzaId || message.id || message.stanzaId;
  if (inboundMessageId) {
    recordInboundMessageId(
      accountId,
      message.isGroup ? message.roomJid! : senderBare,
      inboundMessageId
    );
  }

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
    updateLastRoute: message.isGroup
      ? undefined
      : {
          sessionKey: route.mainSessionKey,
          channel: 'xmpp',
          to: senderBare,
          accountId,
        },
    onRecordError: (err: unknown) => {
      log?.error?.(`[XMPP] Failed to record inbound session: ${String(err)}`);
    },
  });

  const replyTo = message.isGroup ? message.roomJid! : senderBare;
  await sendChatState(accountId, replyTo, 'composing', log, message.isGroup);
  let delivered = false;

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: '',
      deliver: async (payload: ReplyPayload) => {
        delivered = true;
        debouncedDeliver(
          `${accountId}:${replyTo}`,
          payload,
          async (combined) => {
            await deliverReply(combined, message, accountId, senderIdentity, log, setStatus);
          },
          (err) => {
            const error = err instanceof Error ? err.message : String(err);
            log?.error?.(`[XMPP] Debounced reply delivery failed: ${error}`);
            setStatus?.({ accountId, lastError: error });
          }
        );
      },
    },
  });

  if (!delivered) {
    await sendChatState(accountId, replyTo, 'active', log, message.isGroup);
  }
}

type ReplyPayload = { text?: string; markdown?: string };

const pendingDeliveries = new Map<
  string,
  {
    texts: string[];
    deliver: (combined: ReplyPayload) => Promise<void> | void;
    onError: (err: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
  }
>();

function debouncedDeliver(
  key: string,
  payload: ReplyPayload,
  deliver: (combined: ReplyPayload) => Promise<void> | void,
  onError: (err: unknown) => void
): void {
  const text = payload.markdown || payload.text || '';
  const pending = pendingDeliveries.get(key) ?? { texts: [], deliver, onError };
  if (text) {
    pending.texts.push(text);
  }
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pendingDeliveries.set(key, pending);

  pending.timer = setTimeout(() => {
    pendingDeliveries.delete(key);
    const combinedText = pending.texts.join('\n\n');
    void Promise.resolve(pending.deliver({ text: combinedText, markdown: combinedText })).catch(
      pending.onError
    );
  }, 500);
}

async function deliverReply(
  payload: ReplyPayload,
  message: XmppInboundMessage,
  accountId: string,
  senderIdentity: string,
  log?: Logger,
  setStatus?: (patch: ChannelAccountStatusPatch) => void
): Promise<void> {
  const client = activeClients.get(accountId);
  const replyTo = message.isGroup ? message.roomJid! : bareJid(senderIdentity);
  if (!client) {
    const error = `No active client for reply on account ${accountId}`;
    log?.error?.(`[XMPP] ${error}`);
    setStatus?.({ accountId, lastError: error });
    return;
  }

  const text = payload.markdown || payload.text;
  if (!text) {
    await sendChatState(accountId, replyTo, 'active', log, message.isGroup);
    return;
  }

  const children: ReturnType<typeof xml>[] = [];
  let body = text;
  if (message.id) {
    const { prefix, length } = buildReplyFallbackPrefix(message.body || '');
    if (length > 0) {
      body = prefix + text;
      children.push(buildReplyFallbackMarker(0, length));
    }
    children.push(buildReplyElement(message.id, message.isGroup ? message.from : senderIdentity));
  }
  children.push(xml('body', {}, body));

  try {
    await client.send(
      xml(
        'message',
        {
          to: replyTo,
          type: message.isGroup ? 'groupchat' : 'chat',
          id: randomUUID(),
        },
        ...children
      )
    );
    setStatus?.({ accountId, lastOutboundAt: Date.now() });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[XMPP] Failed to send reply: ${error}`);
    setStatus?.({ accountId, lastError: error });
  } finally {
    await sendChatState(accountId, replyTo, 'active', log, message.isGroup);
  }
}

/** Route an authorized XEP-0444 reaction as a text event. */
export async function handleInboundReaction(params: {
  reactedMessageId: string;
  emojis: string[];
  senderBare: string;
  senderFull: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  cfg: OpenClawConfig;
  accountId: string;
  config: XmppConfig;
  log?: Logger;
  setStatus?: (patch: ChannelAccountStatusPatch) => void;
}): Promise<void> {
  const access = await authorizeSender(
    {
      senderBare: bareJid(params.senderBare).toLowerCase(),
      senderFull: params.senderFull,
      isGroup: params.isGroup,
      roomJid: params.roomJid,
      senderNick: params.senderNick,
    },
    params.accountId,
    params.config,
    false,
    params.log
  );
  if (!access.allowed) {
    return;
  }

  params.setStatus?.({ accountId: params.accountId, lastInboundAt: Date.now() });
  const rt = getXmppRuntime();
  const reactionText = `[reaction] ${params.emojis.join(' ')} on message "${params.reactedMessageId}"`;
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: 'xmpp',
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? 'group' : 'direct',
      id: params.isGroup ? params.roomJid! : params.senderBare,
    },
  });
  const storePath = rt.channel.session.resolveStorePath(
    (params.cfg as { session?: { store?: string } }).session?.store,
    { agentId: route.agentId }
  );
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: reactionText,
    RawBody: reactionText,
    CommandBody: reactionText,
    From: `xmpp:${access.senderIdentity}`,
    To: `xmpp:${params.config.jid}`,
    SessionKey: route.sessionKey,
    AccountId: params.accountId,
    ChatType: params.isGroup ? 'group' : 'direct',
    ConversationLabel: params.isGroup ? params.roomJid : params.senderBare,
    SenderName: params.senderNick || params.senderBare.split('@')[0],
    SenderId: access.senderIdentity,
    Provider: 'xmpp',
    Surface: 'xmpp',
    MessageSid: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    OriginatingChannel: 'xmpp' as const,
    OriginatingTo: `xmpp:${params.isGroup ? params.roomJid : params.senderBare}`,
    CommandAuthorized: access.isOwner,
    InboundAccessAuthorized: true,
    ReactionEmojis: params.emojis,
    ReactedMessageId: params.reactedMessageId,
    IsReaction: true,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
    updateLastRoute: params.isGroup
      ? undefined
      : {
          sessionKey: route.mainSessionKey,
          channel: 'xmpp',
          to: params.senderBare,
          accountId: params.accountId,
        },
    onRecordError: (err: unknown) => {
      params.log?.error?.(`[XMPP] Failed to record inbound reaction session: ${String(err)}`);
    },
  });

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg: params.cfg,
    dispatcherOptions: {
      responsePrefix: '',
      deliver: async () => undefined,
    },
  });
}
