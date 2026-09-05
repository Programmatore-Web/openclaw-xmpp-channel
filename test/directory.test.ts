import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { RuntimeEnv } from 'openclaw/plugin-sdk/runtime';
import { describe, expect, it } from 'vitest';
import { xmppDirectoryAdapter, xmppResolverAdapter } from '../src/directory.js';

const cfg: OpenClawConfig = {
  channels: {
    xmpp: {
      jid: 'bot@example.com/desktop',
      allowFrom: ['root@example.com'],
      groups: ['root@conference.example.com'],
      accounts: {
        work: {
          jid: 'work-bot@example.com/desktop',
          name: 'Work bot',
          allowFrom: ['second@example.com/mobile', 'first@example.com/laptop'],
          groups: ['second@conference.example.com/resource', 'first@conference.example.com'],
        },
      },
    },
  },
};

describe('directory Promise contracts', () => {
  it('resolves self, peers and groups in order for the selected account', async () => {
    const params = { cfg, accountId: 'work' };
    const results = [
      xmppDirectoryAdapter.self(params),
      xmppDirectoryAdapter.listPeers(params),
      xmppDirectoryAdapter.listGroups(params),
    ];

    for (const result of results) expect(result).toBeInstanceOf(Promise);
    await expect(Promise.all(results)).resolves.toEqual([
      {
        kind: 'user',
        id: 'work-bot@example.com',
        name: 'Work bot',
        raw: { jid: 'work-bot@example.com' },
      },
      [
        {
          kind: 'user',
          id: 'second@example.com',
          name: 'second@example.com',
          raw: { jid: 'second@example.com' },
        },
        {
          kind: 'user',
          id: 'first@example.com',
          name: 'first@example.com',
          raw: { jid: 'first@example.com' },
        },
      ],
      [
        {
          kind: 'group',
          id: 'second@conference.example.com',
          name: 'second',
          raw: { roomJid: 'second@conference.example.com' },
        },
        {
          kind: 'group',
          id: 'first@conference.example.com',
          name: 'first',
          raw: { roomJid: 'first@conference.example.com' },
        },
      ],
    ]);
  });

  it('keeps the default self name and empty or wildcard results as Promises', async () => {
    const results = [
      xmppDirectoryAdapter.self({ cfg }),
      xmppDirectoryAdapter.self({ cfg: {} }),
      xmppDirectoryAdapter.listPeers({ cfg: {} }),
      xmppDirectoryAdapter.listGroups({ cfg: {} }),
      xmppDirectoryAdapter.listPeers({
        cfg: { channels: { xmpp: { allowFrom: ['user@example.com', '*'] } } },
      }),
    ];

    for (const result of results) expect(result).toBeInstanceOf(Promise);
    await expect(Promise.all(results)).resolves.toEqual([
      {
        kind: 'user',
        id: 'bot@example.com',
        name: 'XMPP Bot',
        raw: { jid: 'bot@example.com' },
      },
      null,
      [],
      [],
      [],
    ]);
  });

  it('resolves user and group targets without changing matching or input order', async () => {
    const params = { cfg, accountId: 'work', runtime: {} as RuntimeEnv };
    const users = xmppResolverAdapter.resolveTargets({
      ...params,
      kind: 'user',
      inputs: [' ', 'xmpp:user@example.com/mobile', 'FIRST', 'missing'],
    });
    const groups = xmppResolverAdapter.resolveTargets({
      ...params,
      kind: 'group',
      inputs: ['jabber:room@conference.example.com/nick', 'SECOND', 'missing'],
    });

    expect(users).toBeInstanceOf(Promise);
    expect(groups).toBeInstanceOf(Promise);
    await expect(users).resolves.toEqual([
      { input: ' ', resolved: false, note: 'empty input' },
      {
        input: 'xmpp:user@example.com/mobile',
        resolved: true,
        id: 'user@example.com',
        name: 'user',
      },
      { input: 'FIRST', resolved: true, id: 'first@example.com', name: 'first' },
      { input: 'missing', resolved: false, note: 'not found' },
    ]);
    await expect(groups).resolves.toEqual([
      {
        input: 'jabber:room@conference.example.com/nick',
        resolved: true,
        id: 'room@conference.example.com',
        name: 'room',
      },
      { input: 'SECOND', resolved: true, id: 'second@conference.example.com', name: 'second' },
      { input: 'missing', resolved: false, note: 'not found' },
    ]);
  });
});
