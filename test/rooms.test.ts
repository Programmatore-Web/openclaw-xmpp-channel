import { xml } from '@xmpp/client';
import type { client, Element } from '@xmpp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinMuc } from '../src/rooms.js';
import { setupPresenceHandlers } from '../src/stanza-handlers.js';
import { getMucOccupantRealJid } from '../src/muc-identity.js';
import { cleanupAccountState, goneRooms, joinedRooms, pendingMucJoins } from '../src/state.js';
import type { Logger } from '../src/types.js';

const accountId = 'rooms-test';

beforeEach(() => {
  vi.useFakeTimers();
  cleanupAccountState(accountId);
});

afterEach(() => {
  cleanupAccountState(accountId);
  try {
    expect(pendingMucJoins.size).toBe(0);
    expect(joinedRooms.has(accountId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('MUC join confirmation', () => {
  it('fails closed before joining a room with an invalid raw localpart', async () => {
    const xmpp = {
      send: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof client>;
    const log: Logger = { warn: vi.fn() };
    const invalidRoom = 'bad room@conference.example.com';

    await joinMuc(xmpp, invalidRoom, 'bot', log, accountId, false);

    expect(pendingMucJoins.size).toBe(0);
    expect(joinedRooms.has(accountId)).toBe(false);
    expect(xmpp.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(`[XMPP] Skipping invalid MUC room JID: ${invalidRoom}`);
  });

  it('resolves a mixed-case configured room from differently-cased self-presence', async () => {
    let stanzaHandler: ((stanza: Element) => void) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler;
        }
      }),
      send: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof client>;
    const log: Logger = { warn: vi.fn() };
    setupPresenceHandlers(xmpp, accountId, log);

    const joinPromise = joinMuc(
      xmpp,
      'MixedRoom@Conference.Example.com',
      'bot',
      log,
      accountId,
      false
    );
    expect(pendingMucJoins.has(`${accountId}:mixedroom@conference.example.com`)).toBe(true);
    expect(vi.mocked(xmpp.send).mock.calls[0]?.[0].attrs.to).toBe(
      'MixedRoom@Conference.Example.com/bot'
    );
    if (!stanzaHandler) throw new Error('stanza handler was not registered');

    expect(
      stanzaHandler(
        xml(
          'presence',
          { from: 'mixedroom@conference.example.com/bot' },
          xml(
            'x',
            { xmlns: 'http://jabber.org/protocol/muc#user' },
            xml('item', { jid: 'bot@example.com/resource' }),
            xml('status', { code: '110' })
          )
        )
      )
    ).toBeUndefined();

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getMucOccupantRealJid(accountId, 'mixedroom@conference.example.com', 'bot')).toBe(
      'bot@example.com'
    );
    await joinPromise;
    expect(log.warn).not.toHaveBeenCalled();
    expect(joinedRooms.get(accountId)).toEqual(new Set(['mixedroom@conference.example.com']));
  });

  it('resolves canonically equivalent Unicode room forms without changing the wire JID', async () => {
    let stanzaHandler: ((stanza: Element) => void) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler;
        }
      }),
      send: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof client>;
    const log: Logger = { warn: vi.fn() };
    setupPresenceHandlers(xmpp, accountId, log);

    const configuredRoom = 'Cafe\u0301@Conference.Example.com';
    const joinPromise = joinMuc(xmpp, configuredRoom, 'bot', log, accountId, false);
    expect(pendingMucJoins.has(`${accountId}:café@conference.example.com`)).toBe(true);
    expect(vi.mocked(xmpp.send).mock.calls[0]?.[0].attrs.to).toBe(`${configuredRoom}/bot`);
    if (!stanzaHandler) throw new Error('stanza handler was not registered');

    expect(
      stanzaHandler(
        xml(
          'presence',
          { from: 'café@conference.example.com/bot' },
          xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('status', { code: '110' }))
        )
      )
    ).toBeUndefined();

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await joinPromise;
    expect(log.warn).not.toHaveBeenCalled();
    expect(joinedRooms.get(accountId)).toEqual(new Set(['café@conference.example.com']));
  });

  it('ignores invalid-domain self-presence without rejecting', () => {
    let stanzaHandler: ((stanza: Element) => void) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler;
        }
      }),
    } as unknown as ReturnType<typeof client>;
    const log: Logger = { warn: vi.fn() };
    setupPresenceHandlers(xmpp, accountId, log);
    if (!stanzaHandler) throw new Error('stanza handler was not registered');

    expect(
      stanzaHandler(
        xml(
          'presence',
          { from: 'room@bad domain.example/bot' },
          xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('status', { code: '110' }))
        )
      )
    ).toBeUndefined();

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      `[${accountId}] Ignoring MUC self-presence with invalid room JID`
    );
  });
});

describe('presence listener rejection ownership', () => {
  function harness() {
    let listener: ((stanza: Element) => void) | undefined;
    const send = vi.fn().mockResolvedValue(undefined);
    const xmpp = {
      on: vi.fn((_event: string, handler: (stanza: Element) => void) => {
        listener = handler;
      }),
      send,
    } as unknown as ReturnType<typeof client>;
    const warn = vi.fn();
    const error = vi.fn();
    setupPresenceHandlers(xmpp, accountId, { warn, error });
    if (!listener) throw new Error('presence listener was not registered');
    return { listener, send, warn, error };
  }

  it.each([
    {
      name: 'missing error element',
      present: false,
      type: undefined,
      condition: undefined,
      expectedType: 'unknown',
      expectedCondition: 'unknown',
    },
    {
      name: 'missing type and condition',
      present: true,
      type: undefined,
      condition: undefined,
      expectedType: 'unknown',
      expectedCondition: 'unknown',
    },
    {
      name: 'empty type',
      present: true,
      type: '',
      condition: 'service-unavailable',
      expectedType: 'unknown',
      expectedCondition: 'service-unavailable',
    },
    {
      name: 'empty condition',
      present: true,
      type: 'cancel',
      condition: '',
      expectedType: 'cancel',
      expectedCondition: 'unknown',
    },
    {
      name: 'padded fields',
      present: true,
      type: ' cancel ',
      condition: ' service-unavailable ',
      expectedType: ' cancel ',
      expectedCondition: ' service-unavailable ',
    },
  ])(
    'preserves $name in presence error reporting',
    async ({ present, type, condition, expectedType, expectedCondition }) => {
      const h = harness();
      const stanza = xml('presence', { from: 'user@example.com/resource', type: 'error' });
      if (present) {
        stanza.append(
          xml(
            'error',
            type === undefined ? {} : { type },
            'ignored character data',
            xml('text', {}, 'Details'),
            ...(condition === undefined ? [] : [xml(condition, {})])
          )
        );
      }

      h.listener(stanza);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.warn).toHaveBeenCalledOnce();
      expect(h.warn).toHaveBeenCalledWith(
        `[${accountId}] XMPP presence error from user@example.com/resource: type=${expectedType} condition=${expectedCondition} text="${present ? 'Details' : ''}"`
      );
      expect(h.error).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it.each(['conflict', 'gone', 'recipient-unavailable'])(
    'retains the %s special case with an empty error type',
    async (condition) => {
      const h = harness();
      const room = 'room@conference.example.com';
      goneRooms.delete(room);
      try {
        h.listener(
          xml(
            'presence',
            { from: `${room}/bot`, type: 'error' },
            xml('error', { type: '' }, xml('text', {}, 'Details'), xml(condition, {}))
          )
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(goneRooms.has(room)).toBe(condition === 'gone');
        if (condition === 'conflict') {
          expect(h.error).toHaveBeenCalledOnce();
          expect(h.error).toHaveBeenCalledWith(
            `[${accountId}] MUC nick conflict in ${room} - check if another instance is using the same nickname`
          );
        } else {
          expect(h.error).not.toHaveBeenCalled();
        }
        if (condition === 'gone') {
          expect(h.warn).toHaveBeenCalledOnce();
          expect(h.warn).toHaveBeenCalledWith(
            `[${accountId}] Configured room ${room} no longer exists`
          );
        } else {
          expect(h.warn).not.toHaveBeenCalled();
        }
        expect(h.send).not.toHaveBeenCalled();
      } finally {
        goneRooms.delete(room);
      }
    }
  );

  it.each([
    { name: 'missing', text: undefined, expectedText: '' },
    { name: 'empty', text: '', expectedText: '' },
    { name: 'non-empty', text: 'Service unavailable', expectedText: 'Service unavailable' },
  ])('preserves $name presence error text in the warning log', async ({ text, expectedText }) => {
    const h = harness();
    const xmlns = 'urn:ietf:params:xml:ns:xmpp-stanzas';
    const stanza = xml(
      'presence',
      { from: 'user@example.com/resource', type: 'error' },
      xml(
        'error',
        { type: 'cancel' },
        xml('service-unavailable', { xmlns }),
        ...(text === undefined ? [] : [xml('text', { xmlns }, text)])
      )
    );

    expect(h.listener(stanza)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith(
      `[${accountId}] XMPP presence error from user@example.com/resource: type=cancel condition=service-unavailable text="${expectedText}"`
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['probe', 'unsubscribe'])(
    'handles rejected %s sends and remains usable',
    async (type) => {
      const h = harness();
      h.send.mockRejectedValueOnce(new Error('send failed'));
      const stanza = xml('presence', { from: 'user@example.com/resource', type });
      expect(h.listener(stanza)).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0][0].is('presence')).toBe(true);
      expect(h.send.mock.calls[0][0].attrs).toEqual(
        type === 'probe'
          ? { to: 'user@example.com' }
          : { to: 'user@example.com', type: 'unsubscribed' }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledWith(
        `[${accountId}] Failed to process XMPP presence: send failed`
      );
      expect(h.listener(stanza)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.warn).toHaveBeenCalledTimes(1);
    }
  );

  it('contains failures in both operational and terminal warning reporting', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('send failed'));
    h.warn.mockImplementation(() => {
      throw new Error('logger failed');
    });
    expect(
      h.listener(xml('presence', { from: 'user@example.com', type: 'probe' }))
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenLastCalledWith(
      `[${accountId}] XMPP presence task failed: logger failed`
    );
  });

  it('keeps subscriptions fail-closed and ignores non-presence or missing senders', () => {
    const h = harness();
    expect(
      h.listener(xml('presence', { from: 'user@example.com', type: 'subscribe' }))
    ).toBeUndefined();
    expect(h.listener(xml('presence', { type: 'probe' }))).toBeUndefined();
    expect(h.listener(xml('message', { from: 'user@example.com' }))).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
