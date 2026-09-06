import type { Element, XmppClient } from '@xmpp/client';
import type { OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInboundMessage } from '../src/inbound.js';
import { setXmppRuntime } from '../src/runtime.js';
import { activeClients, cleanupAccountState } from '../src/state.js';
import type { Logger, XmppConfig, XmppInboundMessage } from '../src/types.js';

const accountId = 'read-marker-test';
const markerNamespace = 'urn:xmpp:chat-markers:0';
const chatStateNamespace = 'http://jabber.org/protocol/chatstates';

function directMessage(overrides: Partial<XmppInboundMessage> = {}): XmppInboundMessage {
  return {
    id: 'message-id',
    from: 'user@example.com/resource',
    to: 'bot@example.com',
    body: 'hello',
    type: 'chat',
    timestamp: 1,
    isGroup: false,
    stanzaId: 'stanza-id',
    originId: 'origin-id',
    rawStanzaId: 'raw-stanza-id',
    ...overrides,
  };
}

function accountConfig(overrides: Partial<XmppConfig> = {}): XmppConfig {
  return {
    jid: 'bot@example.com',
    password: 'unused-test-value',
    dmPolicy: 'open',
    ...overrides,
  };
}

function displayedMarkers(stanzas: Element[]): Element[] {
  return stanzas.filter((stanza) => stanza.getChild('displayed', markerNamespace));
}

function chatStates(stanzas: Element[], state: 'composing' | 'active'): Element[] {
  return stanzas.filter((stanza) => stanza.getChild(state, chatStateNamespace));
}

function expectDisplayedMarker(stanzas: Element[], to: string, id: string): void {
  const markers = displayedMarkers(stanzas);
  expect(markers).toHaveLength(1);
  const stanza = markers[0];
  expect(stanza.name).toBe('message');
  expect(stanza.attrs).toMatchObject({ to, type: 'chat' });

  const displayed = stanza.getChild('displayed', markerNamespace);
  expect(displayed).toBeDefined();
  expect(displayed?.name).toBe('displayed');
  expect(displayed?.attrs).toMatchObject({ xmlns: markerNamespace, id });
}

function createHarness(options: { rejectFirstMarker?: boolean } = {}) {
  const sent: Element[] = [];
  let markerRejected = false;
  const send = vi.fn(async (stanza: Element): Promise<void> => {
    sent.push(stanza);
    if (
      options.rejectFirstMarker &&
      !markerRejected &&
      stanza.getChild('displayed', markerNamespace)
    ) {
      markerRejected = true;
      throw new Error('marker delivery failed');
    }
  });
  activeClients.set(accountId, {
    send,
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as XmppClient);

  const resolveAgentRoute = vi.fn(() => ({
    agentId: 'agent',
    sessionKey: 'session',
    mainSessionKey: 'main-session',
    accountId,
  }));
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({ queuedFinal: false }));
  setXmppRuntime({
    channel: {
      routing: { resolveAgentRoute },
      session: {
        resolveStorePath: () => 'test-sessions.json',
        recordInboundSession,
      },
      reply: {
        finalizeInboundContext: (context: Record<string, unknown>) => context,
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  } as unknown as PluginRuntime);

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;

  return {
    sent,
    send,
    resolveAgentRoute,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
    log,
  };
}

function expectInboundContinued(harness: ReturnType<typeof createHarness>): void {
  expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
  expect(harness.recordInboundSession).toHaveBeenCalledOnce();
  expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  expect(chatStates(harness.sent, 'composing')).toHaveLength(1);
  expect(chatStates(harness.sent, 'active')).toHaveLength(1);
}

async function routeDirectMessage(
  harness: ReturnType<typeof createHarness>,
  config: XmppConfig,
  message = directMessage()
): Promise<void> {
  const cfg = { channels: { xmpp: config } } as OpenClawConfig;
  await handleInboundMessage(message, cfg, accountId, config, harness.log);
}

beforeEach(() => cleanupAccountState(accountId));
afterEach(() => cleanupAccountState(accountId));

describe('XEP-0333 displayed markers for inbound messages', () => {
  it('sends one default-enabled marker to the bare sender using message.id', async () => {
    const harness = createHarness();
    const config = accountConfig();
    expect(Object.hasOwn(config, 'sendReadReceipts')).toBe(false);

    await routeDirectMessage(harness, config);

    expectDisplayedMarker(harness.sent, 'user@example.com', 'message-id');
    expectInboundContinued(harness);
  });

  it('sends the same displayed marker when read receipts are explicitly enabled', async () => {
    const harness = createHarness();
    const config = accountConfig({ sendReadReceipts: true });

    await routeDirectMessage(harness, config);

    expectDisplayedMarker(harness.sent, 'user@example.com', 'message-id');
    expectInboundContinued(harness);
  });

  it('suppresses the marker but continues inbound processing when explicitly disabled', async () => {
    const harness = createHarness();
    const config = accountConfig({ sendReadReceipts: false });

    await routeDirectMessage(harness, config);

    expect(displayedMarkers(harness.sent)).toHaveLength(0);
    expectInboundContinued(harness);
  });

  it('does not send a marker for an authorized group message', async () => {
    const harness = createHarness();
    const config = accountConfig({
      groupPolicy: 'open',
      groups: ['room@conference.example.com'],
    });
    const cfg = { channels: { xmpp: config } } as OpenClawConfig;

    await handleInboundMessage(
      {
        id: 'group-message-id',
        from: 'room@conference.example.com/visitor',
        to: 'bot@example.com',
        body: 'hello room',
        type: 'groupchat',
        timestamp: 1,
        isGroup: true,
        roomJid: 'room@conference.example.com',
        senderNick: 'visitor',
      },
      cfg,
      accountId,
      config,
      harness.log
    );

    expect(displayedMarkers(harness.sent)).toHaveLength(0);
    expectInboundContinued(harness);
  });

  it('denies an unauthorized direct sender before sending a marker or routing', async () => {
    const harness = createHarness();
    const config = accountConfig({ dmPolicy: 'disabled' });

    await routeDirectMessage(harness, config);

    expect(displayedMarkers(harness.sent)).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
    expect(harness.resolveAgentRoute).not.toHaveBeenCalled();
    expect(harness.recordInboundSession).not.toHaveBeenCalled();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('suppresses the marker for an empty message ID while routing normally', async () => {
    const harness = createHarness();
    const config = accountConfig();

    await routeDirectMessage(harness, config, directMessage({ id: '' }));

    expect(displayedMarkers(harness.sent)).toHaveLength(0);
    expectInboundContinued(harness);
  });

  it('contains marker-send rejection and completes subsequent inbound lifecycle work', async () => {
    const harness = createHarness({ rejectFirstMarker: true });
    const config = accountConfig();

    await expect(routeDirectMessage(harness, config)).resolves.toBeUndefined();

    expectDisplayedMarker(harness.sent, 'user@example.com', 'message-id');
    expect(harness.log.warn).toHaveBeenCalledOnce();
    expect(harness.log.warn).toHaveBeenCalledWith(
      `[${accountId}] Failed to send chat marker: marker delivery failed`
    );
    expectInboundContinued(harness);
  });
});
