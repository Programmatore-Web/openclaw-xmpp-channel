/** XEP-0444 reaction action for the OpenClaw message tool. */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { xml } from '@xmpp/client';
import type { ChannelMessageActionName } from './types.js';
import { resolveXmppAccount } from './accounts.js';
import { getActiveClient } from './monitor.js';
import { bareJid } from './config-schema.js';
import { getRecentInboundMessageId, getServerMessageId } from './state.js';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonResult(payload: unknown): {
  content: { type: 'text'; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function reactionEnabled(
  config: Record<string, unknown> | undefined,
  accountId?: string | null
): boolean {
  if (!config) {
    return false;
  }
  const account = accountId
    ? (config.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId]
    : undefined;
  const effective = { ...config, ...account };
  return (effective.actions as { reactions?: boolean } | undefined)?.reactions === true;
}

export function listXmppActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const config = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  if (!config) {
    return [];
  }
  if (reactionEnabled(config)) {
    return ['react'];
  }

  const accounts = config.accounts as Record<string, Record<string, unknown>> | undefined;
  return accounts && Object.keys(accounts).some((accountId) => reactionEnabled(config, accountId))
    ? ['react']
    : [];
}

export function describeXmppMessageTool({ cfg }: { cfg: OpenClawConfig }) {
  if (!listXmppActions(cfg).includes('react')) {
    return null;
  }
  return {
    actions: ['react'] as ChannelMessageActionName[],
    schema: [
      {
        properties: {
          messageId: {
            type: 'string',
            description:
              'ID of the XMPP message to react to; defaults to the latest inbound message in the conversation.',
          },
          emoji: {
            type: 'string',
            description: 'Emoji to add or remove.',
          },
          remove: {
            type: 'boolean',
            description: 'Remove this reaction instead of adding it.',
          },
        },
        actions: ['react'] as const,
        visibility: 'current-channel' as const,
      },
    ],
  };
}

export function supportsXmppAction(action: string): boolean {
  return action === 'react';
}

async function handleReaction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  target: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}) {
  const xmppConfig = params.cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const account = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!reactionEnabled(xmppConfig, account.accountId)) {
    return jsonResult({ ok: false, error: 'XMPP reactions are disabled' });
  }

  const client = getActiveClient(account.accountId);
  if (!client) {
    return jsonResult({ ok: false, error: 'XMPP client not connected' });
  }

  const target = bareJid(params.target.replace(/^xmpp:/, ''));
  const normalizedTarget = target.toLowerCase();
  const isMuc =
    account.config.groups?.some((room) => bareJid(room).toLowerCase() === normalizedTarget) ??
    false;
  const referencedId = getServerMessageId(account.accountId, params.messageId, target);
  const reactions = params.remove
    ? xml('reactions', { id: referencedId, xmlns: 'urn:xmpp:reactions:0' })
    : xml(
        'reactions',
        { id: referencedId, xmlns: 'urn:xmpp:reactions:0' },
        xml('reaction', {}, params.emoji || '👍')
      );

  try {
    await client.send(
      xml(
        'message',
        {
          to: target,
          type: isMuc ? 'groupchat' : 'chat',
          id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        },
        reactions,
        xml('store', { xmlns: 'urn:xmpp:hints' })
      )
    );
    return jsonResult(
      params.remove ? { ok: true, removed: true } : { ok: true, added: params.emoji || '👍' }
    );
  } catch (err) {
    return jsonResult({
      ok: false,
      error: `XMPP reaction failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export const xmppMessageActions = {
  describeMessageTool: ({ cfg }: { cfg: OpenClawConfig }) => describeXmppMessageTool({ cfg }),
  listActions: ({ cfg }: { cfg: OpenClawConfig }) => listXmppActions(cfg),
  supportsAction: ({ action }: { action: string }) => supportsXmppAction(action),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    toolContext,
  }: {
    action: string;
    params: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
    toolContext?: { currentChannelId?: string; currentThreadId?: string };
  }) => {
    if (action !== 'react') {
      return jsonResult({ ok: false, error: `Unsupported XMPP action: ${action}` });
    }

    const target =
      nonEmptyString(params.chatJid) ||
      nonEmptyString(params.to) ||
      nonEmptyString(toolContext?.currentChannelId) ||
      '';
    if (!target) {
      return jsonResult({ ok: false, error: 'Target JID is required' });
    }

    const account = resolveXmppAccount({ cfg, accountId });
    const normalizedTarget = bareJid(target.replace(/^xmpp:/, ''));
    const messageId =
      nonEmptyString(params.messageId) ||
      getRecentInboundMessageId(account.accountId, normalizedTarget) ||
      '';
    if (!messageId) {
      return jsonResult({ ok: false, error: 'messageId is required for reactions' });
    }

    return handleReaction({
      cfg,
      accountId,
      target: normalizedTarget,
      messageId,
      emoji: typeof params.emoji === 'string' ? params.emoji : undefined,
      remove: typeof params.remove === 'boolean' ? params.remove : undefined,
    });
  },
  extractToolSend: () => null,
};
