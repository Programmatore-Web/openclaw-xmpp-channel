import { xml } from '@xmpp/client';
import type { Element, XmppClient } from '@xmpp/client';
import type { OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMessageHandler } from '../src/monitor.js';
import { setXmppRuntime } from '../src/runtime.js';
import { cleanupAccountState } from '../src/state.js';
import type { XmppConfig } from '../src/types.js';

const accountId = 'encrypted-stanza-test';
const cfg = { channels: { xmpp: {} } } as OpenClawConfig;
const config: XmppConfig = {
  jid: 'bot@example.com',
  password: 'password',
  dmPolicy: 'disabled',
  allowFrom: ['user@example.com'],
  sendReadReceipts: false,
};

function createHandlerHarness() {
  const resolveAgentRoute = vi.fn(() => ({
    agentId: 'agent',
    sessionKey: 'session',
    mainSessionKey: 'main-session',
    accountId,
  }));
  const recordInboundSession = vi.fn(async () => undefined);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({ queuedFinal: false }));
  const runtime = {
    channel: {
      routing: { resolveAgentRoute },
      session: {
        resolveStorePath: vi.fn(() => '/tmp/openclaw-xmpp-test-sessions.json'),
        recordInboundSession,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      reply: {
        finalizeInboundContext: vi.fn((context: Record<string, unknown>) => context),
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  } as unknown as PluginRuntime;
  setXmppRuntime(runtime);

  let stanzaHandler: ((stanza: Element) => Promise<void>) | undefined;
  const xmpp = {
    on: vi.fn((event: string, handler: (stanza: Element) => void) => {
      if (event === 'stanza') {
        stanzaHandler = handler as unknown as (stanza: Element) => Promise<void>;
      }
    }),
  } as unknown as XmppClient;
  setupMessageHandler(xmpp, accountId, 'bot', cfg, config);
  if (!stanzaHandler) throw new Error('stanza handler was not registered');

  return { stanzaHandler, resolveAgentRoute, recordInboundSession, dispatchReplyWithBufferedBlockDispatcher };
}

function message(...children: Element[]): Element {
  return xml(
    'message',
    {
      from: 'user@example.com/resource',
      to: 'bot@example.com',
      type: 'chat',
      id: 'message-1',
    },
    ...children
  );
}

beforeEach(() => cleanupAccountState(accountId));
afterEach(() => cleanupAccountState(accountId));

describe('unsupported encrypted stanza filtering', () => {
  it('ignores a stanza carrying EME before routing its fallback body', async () => {
    const harness = createHandlerHarness();
    await harness.stanzaHandler(
      message(
        xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:example:e2ee' }),
        xml('body', {}, 'unsupported encrypted fallback')
      )
    );
    expect(harness.resolveAgentRoute).not.toHaveBeenCalled();
    expect(harness.recordInboundSession).not.toHaveBeenCalled();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('ignores any top-level encrypted element even without EME', async () => {
    const harness = createHandlerHarness();
    await harness.stanzaHandler(
      message(
        xml('encrypted', { xmlns: 'urn:example:unsupported-e2ee' }),
        xml('body', {}, 'unsupported encrypted fallback')
      )
    );
    expect(harness.resolveAgentRoute).not.toHaveBeenCalled();
    expect(harness.recordInboundSession).not.toHaveBeenCalled();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('processes an ordinary plaintext body', async () => {
    const harness = createHandlerHarness();
    await harness.stanzaHandler(message(xml('body', {}, 'ordinary plaintext')));
    expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(harness.recordInboundSession).toHaveBeenCalledOnce();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});
