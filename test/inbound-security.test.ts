import { xml } from '@xmpp/client';
import type { OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInboundMessage } from '../src/inbound.js';
import { trackMucOccupantIdentity } from '../src/muc-identity.js';
import { setXmppRuntime } from '../src/runtime.js';
import { cleanupAccountState } from '../src/state.js';
import type { XmppConfig, XmppInboundMessage } from '../src/types.js';

const accountId = 'security-test';
const cfg = { channels: { xmpp: {} } } as OpenClawConfig;

function createRuntimeHarness(approved: string[] = []) {
  const resolveAgentRoute = vi.fn(() => ({
    agentId: 'agent',
    sessionKey: 'session',
    mainSessionKey: 'main-session',
    accountId,
  }));
  const resolveStorePath = vi.fn(() => '/tmp/openclaw-xmpp-test-sessions.json');
  const recordInboundSession = vi.fn(async () => undefined);
  const readAllowFromStore = vi.fn(async () => approved);
  const finalizeInboundContext = vi.fn((context: Record<string, unknown>) => context);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({ queuedFinal: false }));

  const runtime = {
    channel: {
      routing: { resolveAgentRoute },
      session: { resolveStorePath, recordInboundSession },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => ({ code: 'TEST-CODE', created: true })),
        buildPairingReply: vi.fn(() => 'Pairing code: TEST-CODE'),
      },
      reply: { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    resolveAgentRoute,
    resolveStorePath,
    recordInboundSession,
    readAllowFromStore,
    finalizeInboundContext,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

function directMessage(from = 'user@example.com'): XmppInboundMessage {
  return {
    id: 'message-1',
    from,
    to: 'bot@example.com',
    body: 'hello',
    type: 'chat',
    timestamp: 1,
    isGroup: false,
  };
}

function groupMessage(): XmppInboundMessage {
  return {
    id: 'message-2',
    from: 'room@conference.example.com/visitor',
    to: 'bot@example.com',
    body: 'hello room',
    type: 'groupchat',
    timestamp: 1,
    isGroup: true,
    roomJid: 'room@conference.example.com',
    senderNick: 'visitor',
  };
}

function accountConfig(overrides: Partial<XmppConfig> = {}): XmppConfig {
  return {
    jid: 'bot@example.com',
    password: 'password',
    sendReadReceipts: false,
    ...overrides,
  };
}

function expectBlocked(harness: ReturnType<typeof createRuntimeHarness>): void {
  expect(harness.resolveAgentRoute).not.toHaveBeenCalled();
  expect(harness.resolveStorePath).not.toHaveBeenCalled();
  expect(harness.recordInboundSession).not.toHaveBeenCalled();
  expect(harness.finalizeInboundContext).not.toHaveBeenCalled();
  expect(harness.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
}

beforeEach(() => cleanupAccountState(accountId));
afterEach(() => cleanupAccountState(accountId));

describe('direct-message authorization', () => {
  it('blocks non-owners when DMs are disabled', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(directMessage(), cfg, accountId, accountConfig({ dmPolicy: 'disabled' }));
    expectBlocked(harness);
  });

  it('admits a sender only when DM open is explicit', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(directMessage(), cfg, accountId, accountConfig({ dmPolicy: 'open' }));
    expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(harness.recordInboundSession).toHaveBeenCalledOnce();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it('applies the DM allowlist for matches and non-matches', async () => {
    const allowed = createRuntimeHarness();
    setXmppRuntime(allowed.runtime);
    const config = accountConfig({ dmPolicy: 'allowlist', dmAllowlist: ['user@example.com'] });
    await handleInboundMessage(directMessage(), cfg, accountId, config);
    expect(allowed.resolveAgentRoute).toHaveBeenCalledOnce();

    const blocked = createRuntimeHarness();
    setXmppRuntime(blocked.runtime);
    await handleInboundMessage(directMessage('other@example.com'), cfg, accountId, config);
    expectBlocked(blocked);
  });

  it('blocks an unapproved pairing peer before route, session, or dispatch', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(directMessage(), cfg, accountId, accountConfig({ dmPolicy: 'pairing' }));
    expect(harness.readAllowFromStore).toHaveBeenCalledWith({ channel: 'xmpp', accountId });
    expectBlocked(harness);
  });

  it('admits an account-scoped paired peer but does not authorize commands', async () => {
    const harness = createRuntimeHarness(['user@example.com']);
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(directMessage(), cfg, accountId, accountConfig({ dmPolicy: 'pairing' }));
    expect(harness.readAllowFromStore).toHaveBeenCalledWith({ channel: 'xmpp', accountId });
    expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(harness.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ CommandAuthorized: false, InboundAccessAuthorized: true })
    );
  });

  it('always admits a static owner and authorizes owner commands', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(
      directMessage(),
      cfg,
      accountId,
      accountConfig({ dmPolicy: 'disabled', allowFrom: ['user@example.com'] })
    );
    expect(harness.readAllowFromStore).not.toHaveBeenCalled();
    expect(harness.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ CommandAuthorized: true, InboundAccessAuthorized: true })
    );
  });
});

describe('MUC authorization', () => {
  it('blocks messages from rooms that are not explicitly configured', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(
      groupMessage(),
      cfg,
      accountId,
      accountConfig({ groupPolicy: 'open', groups: [] })
    );
    expectBlocked(harness);
  });

  it('admits a verified allowlisted real JID', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    trackMucOccupantIdentity(
      xml(
        'presence',
        { from: 'room@conference.example.com/visitor' },
        xml(
          'x',
          { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('item', { jid: 'user@example.com/resource' })
        )
      ),
      accountId
    );
    await handleInboundMessage(
      groupMessage(),
      cfg,
      accountId,
      accountConfig({
        groupPolicy: 'allowlist',
        groups: ['room@conference.example.com'],
        groupAllowFrom: ['user@example.com'],
      })
    );
    expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it('fails closed when a real JID is unavailable', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(
      groupMessage(),
      cfg,
      accountId,
      accountConfig({
        groupPolicy: 'allowlist',
        groups: ['room@conference.example.com'],
        groupAllowFrom: ['user@example.com'],
      })
    );
    expectBlocked(harness);
  });

  it('blocks a verified real JID that is not allowlisted', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    trackMucOccupantIdentity(
      xml(
        'presence',
        { from: 'room@conference.example.com/visitor' },
        xml(
          'x',
          { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('item', { jid: 'other@example.com' })
        )
      ),
      accountId
    );
    await handleInboundMessage(
      groupMessage(),
      cfg,
      accountId,
      accountConfig({
        groupPolicy: 'allowlist',
        groups: ['room@conference.example.com'],
        groupAllowFrom: ['user@example.com'],
      })
    );
    expectBlocked(harness);
  });

  it('allows group open only for an explicitly configured room', async () => {
    const harness = createRuntimeHarness();
    setXmppRuntime(harness.runtime);
    await handleInboundMessage(
      groupMessage(),
      cfg,
      accountId,
      accountConfig({ groupPolicy: 'open', groups: ['room@conference.example.com'] })
    );
    expect(harness.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});
