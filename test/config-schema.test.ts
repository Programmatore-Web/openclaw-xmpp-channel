import { describe, expect, it } from 'vitest';
import { extractJidDomain, resolveConnectHost } from '../src/config-schema.js';

describe('XMPP domain and connection host', () => {
  it('always extracts the logical domain from the JID', () => {
    expect(extractJidDomain('bot@example.com/resource')).toBe('example.com');
  });

  it('uses server only as the physical connection host', () => {
    const config = { jid: 'bot@example.com', server: 'xmpp-edge.example.com' };
    expect(extractJidDomain(config.jid)).toBe('example.com');
    expect(resolveConnectHost(config)).toBe('xmpp-edge.example.com');
  });

  it.each([undefined, '', ' \t '])('falls back to the JID domain for server %j', (server) => {
    expect(resolveConnectHost({ jid: 'bot@example.com', server })).toBe('example.com');
  });

  it('reads and trims a padded server once without evaluating the JID fallback', () => {
    let serverReads = 0;
    const config = {
      get server() {
        serverReads += 1;
        return ' xmpp.example.com ';
      },
      get jid(): string {
        throw new Error('JID fallback must remain lazy');
      },
    };

    expect(resolveConnectHost(config)).toBe('xmpp.example.com');
    expect(serverReads).toBe(1);
  });
});
