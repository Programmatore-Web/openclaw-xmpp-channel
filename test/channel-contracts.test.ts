import type { XmppClient } from '@xmpp/client';
import type { OpenClawConfig, ReplyPayload } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('outbound payload normalization contract', () => {
  const normalize = xmppPlugin.outbound!.normalizePayload!;

  afterEach(() => {
    expect(getActiveClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the original payload rather than the params wrapper', () => {
    const payload = Object.freeze({ text: 'Ordinary reply' });
    const params = Object.freeze({ payload, cfg, accountId: 'default' });

    expect(normalize).toBeTypeOf('function');
    const result = normalize(params);

    expect(result).toBe(payload);
    expect(result).not.toBe(params);
  });

  it('returns null for a control payload supplied through the params wrapper', () => {
    expect(normalize({ payload: { text: 'NO_REPLY' }, cfg, accountId: 'default' })).toBeNull();
  });

  it.each([
    { name: 'NO_REPLY', text: 'NO_REPLY' },
    { name: 'padded NO_REPLY', text: ' \tNO_REPLY\r\n ' },
    { name: 'lowercase NO_REPLY', text: 'no_reply' },
    { name: 'padded mixed-case NO_REPLY', text: ' \tNo_RePlY\n ' },
    { name: 'REPLY_SKIP', text: 'REPLY_SKIP' },
    { name: 'padded REPLY_SKIP', text: ' \tREPLY_SKIP\r\n ' },
  ])('drops isolated $name without mutating its text', ({ text }) => {
    const payload = Object.freeze({ text });

    expect(normalize({ payload, cfg, accountId: 'default' })).toBeNull();
    expect(payload.text).toBe(text);
  });

  it.each([
    { name: 'HEARTBEAT_OK', text: 'HEARTBEAT_OK' },
    { name: 'padded HEARTBEAT_OK', text: '  HEARTBEAT_OK  ' },
    { name: 'lowercase REPLY_SKIP', text: 'reply_skip' },
    { name: 'mixed-case REPLY_SKIP', text: 'RePlY_SkIp' },
    { name: 'ordinary text', text: 'Ordinary reply' },
    { name: 'padded ordinary text', text: ' \tOrdinary reply\n ' },
    { name: 'missing text', text: undefined },
    { name: 'empty text', text: '' },
    { name: 'whitespace-only text', text: ' \t\r\n ' },
    { name: 'token in prose', text: 'The agent returned NO_REPLY while debugging.' },
    { name: 'NO_REPLY with a suffix', text: 'NO_REPLY please' },
    { name: 'NO_REPLY with a prefix', text: 'prefix NO_REPLY' },
    { name: 'REPLY_SKIP with a suffix', text: 'REPLY_SKIP please' },
    { name: 'REPLY_SKIP with a prefix', text: 'prefix REPLY_SKIP' },
    { name: 'HEARTBEAT_OK with a prefix', text: 'prefix HEARTBEAT_OK' },
    { name: 'code-wrapped token', text: '`NO_REPLY`' },
    { name: 'punctuated token', text: 'NO_REPLY.' },
    { name: 'repeated NO_REPLY', text: 'NO_REPLY NO_REPLY' },
    { name: 'repeated REPLY_SKIP', text: 'REPLY_SKIP REPLY_SKIP' },
  ])('preserves $name and payload identity', ({ text }) => {
    const payload = Object.freeze(text === undefined ? {} : { text });

    expect(normalize({ payload, cfg, accountId: 'default' })).toBe(payload);
    expect(payload).toEqual(text === undefined ? {} : { text });
  });

  it('preserves an explicitly visible heartbeat acknowledgement', () => {
    const payload = Object.freeze({ text: 'HEARTBEAT_OK' });
    const heartbeatCfg: OpenClawConfig = {
      channels: { xmpp: { ...xmppConfig, heartbeatVisibility: { showOk: true } } },
    };

    expect(normalize({ payload, cfg: heartbeatCfg, accountId: 'default' })).toBe(payload);
  });

  it('preserves the host finalization fallback unchanged', () => {
    const payload = Object.freeze({
      text: 'The tool run finished, but no final summary was produced. I did not repeat any completed actions.',
    });

    expect(normalize({ payload, cfg, accountId: 'default' })).toBe(payload);
  });

  describe.each(['NO_REPLY', 'REPLY_SKIP'])('content protection for %s', (text) => {
    it.each([
      { name: 'nonblank mediaUrl', content: { mediaUrl: ' https://example.invalid/media ' } },
      { name: 'nonempty mediaUrls', content: { mediaUrls: ['https://example.invalid/media'] } },
      { name: 'nonempty mediaUrls with blank entries', content: { mediaUrls: ['', ' \t'] } },
      {
        name: 'attachment',
        content: { attachments: [{ url: 'https://example.invalid/media' }] },
      },
      { name: 'minimal attachment', content: { attachments: [{}] } },
      {
        name: 'visible fallbackText',
        content: { fallbackText: { text: ' Visible fallback ', replacesPayloadIndex: 0 } },
      },
      {
        name: 'presentation',
        content: { presentation: { blocks: [{ type: 'text', text: 'Visible details' }] } },
      },
      { name: 'empty-block presentation', content: { presentation: { blocks: [] } } },
      {
        name: 'interactive content',
        content: { interactive: { blocks: [{ type: 'text', text: 'Choose an option' }] } },
      },
      { name: 'empty-block interactive content', content: { interactive: { blocks: [] } } },
      { name: 'zero-coordinate location', content: { location: { latitude: 0, longitude: 0 } } },
      { name: 'BTW question', content: { btw: { question: 'Additional question' } } },
      { name: 'blank-question BTW object', content: { btw: { question: '' } } },
      { name: 'spoken text', content: { spokenText: ' Spoken reply ' } },
      {
        name: 'TTS supplement',
        content: {
          ttsSupplement: { spokenText: 'Spoken reply', visibleTextAlreadyDelivered: true },
        },
      },
      { name: 'blank-text TTS supplement', content: { ttsSupplement: { spokenText: '' } } },
      {
        name: 'unknown channelData envelope',
        content: { channelData: { custom: { label: 'value' } } },
      },
    ] satisfies Array<{ name: string; content: Omit<ReplyPayload, 'text'> }>)(
      'preserves $name without mutation',
      ({ content }) => {
        const payload = Object.freeze({ text, ...content });
        const before = structuredClone(payload);

        expect(normalize({ payload, cfg, accountId: 'default' })).toBe(payload);
        expect(payload).toEqual(before);
      }
    );
  });

  it.each([
    { name: 'empty mediaUrl', content: { mediaUrl: '' } },
    { name: 'whitespace mediaUrl', content: { mediaUrl: ' \t' } },
    { name: 'empty mediaUrls', content: { mediaUrls: [] } },
    { name: 'empty attachments', content: { attachments: [] } },
    { name: 'empty fallbackText', content: { fallbackText: { text: '' } } },
    { name: 'whitespace fallbackText', content: { fallbackText: { text: ' \t' } } },
    { name: 'empty spokenText', content: { spokenText: '' } },
    { name: 'whitespace spokenText', content: { spokenText: ' \t' } },
    { name: 'empty channelData', content: { channelData: {} } },
  ] satisfies Array<{ name: string; content: Omit<ReplyPayload, 'text'> }>)(
    'drops NO_REPLY with only $name',
    ({ content }) => {
      const payload = Object.freeze({ text: 'NO_REPLY', ...content });
      const before = structuredClone(payload);

      expect(normalize({ payload, cfg, accountId: 'default' })).toBeNull();
      expect(payload).toEqual(before);
    }
  );

  it('does not treat delivery, reply, display or status metadata as content', () => {
    const payload: ReplyPayload = Object.freeze({
      text: 'NO_REPLY',
      delivery: { pin: { enabled: true, notify: true, required: true } },
      replyToId: 'message-id',
      replyToTag: true,
      replyToCurrent: true,
      audioAsVoice: true,
      videoAsNote: true,
      presentationTextMode: 'fallback',
      isError: true,
      isReasoning: true,
      isCommentary: true,
      isReasoningSnapshot: true,
      isCompactionNotice: true,
      isFallbackNotice: true,
      isStatusNotice: true,
    });
    const before = structuredClone(payload);

    expect(normalize({ payload, cfg, accountId: 'default' })).toBeNull();
    expect(payload).toEqual(before);
  });

  it.each([
    { name: 'ordinary pass', payload: { text: ' Ordinary reply ' }, drop: false },
    {
      name: 'protected token pass',
      payload: {
        text: 'NO_REPLY',
        mediaUrls: ['https://example.invalid/media'],
        channelData: { custom: { label: 'value' } },
      },
      drop: false,
    },
    { name: 'token drop', payload: { text: ' \tNO_REPLY\n ' }, drop: true },
  ] satisfies Array<{ name: string; payload: ReplyPayload; drop: boolean }>)(
    'keeps $name stable across repeated invocations',
    ({ payload, drop }) => {
      Object.freeze(payload);
      const params = Object.freeze({ payload, cfg, accountId: 'default' });
      const before = structuredClone(params);
      const expected = drop ? null : payload;

      expect(normalize(params)).toBe(expected);
      expect(normalize(params)).toBe(expected);
      expect(normalize({ ...params })).toBe(expected);
      expect(params).toEqual(before);
    }
  );
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
