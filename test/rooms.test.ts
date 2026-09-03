import { xml } from '@xmpp/client';
import type { client, Element } from '@xmpp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinMuc } from '../src/rooms.js';
import { setupPresenceHandlers } from '../src/stanza-handlers.js';
import { cleanupAccountState, joinedRooms, pendingMucJoins } from '../src/state.js';
import type { Logger } from '../src/types.js';

const accountId = 'rooms-test';

beforeEach(() => {
  vi.useFakeTimers();
  cleanupAccountState(accountId);
});

afterEach(() => {
  cleanupAccountState(accountId);
  vi.useRealTimers();
});

describe('MUC join confirmation', () => {
  it('resolves a mixed-case configured room from differently-cased self-presence', async () => {
    let stanzaHandler: ((stanza: Element) => Promise<void>) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: Element) => Promise<void>;
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

    await stanzaHandler(
      xml(
        'presence',
        { from: 'mixedroom@conference.example.com/bot' },
        xml(
          'x',
          { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('status', { code: '110' })
        )
      )
    );

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await joinPromise;
    expect(log.warn).not.toHaveBeenCalled();
    expect(joinedRooms.get(accountId)).toEqual(new Set(['mixedroom@conference.example.com']));
  });

  it('resolves canonically equivalent Unicode room forms without changing the wire JID', async () => {
    let stanzaHandler: ((stanza: Element) => Promise<void>) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: Element) => Promise<void>;
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

    await stanzaHandler(
      xml(
        'presence',
        { from: 'café@conference.example.com/bot' },
        xml(
          'x',
          { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('status', { code: '110' })
        )
      )
    );

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await joinPromise;
    expect(log.warn).not.toHaveBeenCalled();
    expect(joinedRooms.get(accountId)).toEqual(new Set(['café@conference.example.com']));
  });

  it('ignores invalid-domain self-presence without rejecting', async () => {
    let stanzaHandler: ((stanza: Element) => Promise<void>) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: Element) => Promise<void>;
        }
      }),
    } as unknown as ReturnType<typeof client>;
    const log: Logger = { warn: vi.fn() };
    setupPresenceHandlers(xmpp, accountId, log);
    if (!stanzaHandler) throw new Error('stanza handler was not registered');

    await expect(
      stanzaHandler(
        xml(
          'presence',
          { from: 'room@bad domain.example/bot' },
          xml(
            'x',
            { xmlns: 'http://jabber.org/protocol/muc#user' },
            xml('status', { code: '110' })
          )
        )
      )
    ).resolves.toBeUndefined();

    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      `[${accountId}] Ignoring MUC self-presence with invalid room JID`
    );
  });
});
