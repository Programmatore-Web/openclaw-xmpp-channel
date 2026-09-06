import type { XmppClient } from '@xmpp/client';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveXmppAccount } from '../src/accounts.js';
import { xmppPlugin } from '../src/channel.js';
import { getXmppSelf } from '../src/directory.js';
import { getActiveClient } from '../src/monitor.js';

vi.mock('../src/monitor.js', () => ({
  getActiveClient: vi.fn(),
}));

const xmppConfig = {
  jid: 'bot@example.com',
  password: 'unused-test-value',
  server: 'example.invalid',
};
const cfg: OpenClawConfig = { channels: { xmpp: xmppConfig } };
const send = vi.fn().mockResolvedValue(undefined);
const client = { send } as unknown as XmppClient;

beforeEach(() => {
  vi.mocked(getActiveClient).mockReset();
  send.mockClear();
});

describe('account and directory name fallbacks', () => {
  it.each([
    { label: 'absent', name: undefined, accountName: 'XMPP', selfName: 'XMPP Bot' },
    { label: 'empty', name: '', accountName: 'XMPP', selfName: 'XMPP Bot' },
    { label: 'configured', name: 'Work bot', accountName: 'Work bot', selfName: 'Work bot' },
    { label: 'padded', name: ' Work bot ', accountName: ' Work bot ', selfName: ' Work bot ' },
    { label: 'whitespace', name: ' ', accountName: ' ', selfName: ' ' },
  ])('preserves $label names and account selection', async ({ name, accountName, selfName }) => {
    const namedCfg: OpenClawConfig = {
      channels: {
        xmpp: {
          jid: 'bot@example.com',
          dmPolicy: 'open',
          allowFrom: ['user@example.com'],
          accounts: { work: { jid: 'user@example.com/desktop', name } },
        },
      },
    };
    const account = resolveXmppAccount({ cfg: namedCfg, accountId: 'work' });

    expect(xmppPlugin.config.describeAccount!(account, namedCfg)).toEqual({
      accountId: 'work',
      name: accountName,
      enabled: true,
      configured: true,
      dmPolicy: 'open',
      allowFrom: ['user@example.com'],
    });
    await expect(getXmppSelf({ cfg: namedCfg, accountId: 'work' })).resolves.toEqual({
      kind: 'user',
      id: 'user@example.com',
      name: selfName,
      raw: { jid: 'user@example.com' },
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('mention strip patterns', () => {
  it.each([
    { name: 'absent', ctx: {}, expected: [] },
    { name: 'empty', ctx: { To: '' }, expected: [] },
    { name: 'prefix-only', ctx: { To: 'xmpp:' }, expected: [] },
    {
      name: 'valid',
      ctx: { To: 'xmpp:bot@example.com/resource' },
      expected: [String.raw`bot@example\.com`, String.raw`@bot@example\.com`],
    },
  ])('preserves mention strip patterns for $name To', ({ ctx, expected }) => {
    expect(xmppPlugin.mentions!.stripPatterns!({ ctx, cfg })).toEqual(expected);
  });
});

describe('channel pairing and status Promise contracts', () => {
  it('resolves approval notification without sending or changing config', async () => {
    vi.mocked(getActiveClient).mockReturnValue(client);
    const before = structuredClone(cfg);
    const result = xmppPlugin.pairing!.notifyApproval!({ cfg, id: 'user@example.com' });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(getActiveClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(cfg).toEqual(before);
  });

  it.each([
    { name: 'unconfigured', config: {}, expected: { ok: false, error: 'Not configured' } },
    { name: 'configured', config: cfg, expected: { ok: true, jid: 'bot@example.com' } },
  ])('resolves the $name probe from configuration alone', async ({ config, expected }) => {
    const result = xmppPlugin.status!.probeAccount!({
      account: resolveXmppAccount({ cfg: config }),
      cfg: config,
      timeoutMs: 100,
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual(expected);
    expect(getActiveClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a Promise summary with configured fields and falsey snapshot values', async () => {
    const result = xmppPlugin.status!.buildChannelSummary!({
      account: { ...resolveXmppAccount({ cfg }), enabled: false },
      cfg,
      defaultAccountId: 'default',
      snapshot: {
        accountId: 'default',
        running: true,
        connected: true,
        lastConnectedAt: 0,
        lastError: '',
      },
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({
      configured: true,
      enabled: false,
      running: true,
      connected: true,
      jid: 'bot@example.com',
      server: 'example.invalid',
      lastConnectedAt: 0,
      lastError: '',
    });
  });

  it('keeps a Promise summary with the unconfigured and missing snapshot fallbacks', async () => {
    const result = xmppPlugin.status!.buildChannelSummary!({
      account: resolveXmppAccount({ cfg: {} }),
      cfg: {},
      defaultAccountId: 'default',
      snapshot: { accountId: 'default' },
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({
      configured: false,
      enabled: true,
      running: false,
      connected: false,
      jid: undefined,
      server: undefined,
      lastConnectedAt: null,
      lastError: null,
    });
  });
});

describe('heartbeat readiness Promise contract', () => {
  const checkReady = xmppPlugin.heartbeat!.checkReady!;

  it.each([
    { reason: 'xmpp-not-configured', config: {}, connected: false },
    {
      reason: 'xmpp-disabled',
      config: { channels: { xmpp: { ...xmppConfig, enabled: false } } },
      connected: true,
    },
    { reason: 'xmpp-not-connected', config: cfg, connected: false },
    { reason: 'ok', config: cfg, connected: true },
  ])('returns a catch-compatible Promise for $reason', async ({ reason, config, connected }) => {
    vi.mocked(getActiveClient).mockReturnValue(connected ? client : undefined);
    const onError = vi.fn();
    const result = checkReady({ cfg: config });

    expect(result).toBeInstanceOf(Promise);
    if (reason === 'ok' || reason === 'xmpp-not-connected') {
      expect(getActiveClient).toHaveBeenCalledWith('default');
    } else {
      expect(getActiveClient).not.toHaveBeenCalled();
    }
    await expect(result.catch(onError)).resolves.toEqual({ ok: reason === 'ok', reason });
    expect(onError).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects when the client lookup throws so a consumer can catch the failure', async () => {
    const error = new Error('Client lookup failed');
    vi.mocked(getActiveClient).mockImplementationOnce(() => {
      throw error;
    });
    const result = checkReady({ cfg });

    expect(result).toBeInstanceOf(Promise);
    await expect(result.catch((failure: unknown) => failure)).resolves.toBe(error);
  });
});
