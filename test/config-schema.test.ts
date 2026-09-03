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

  it('falls back to the JID domain for the connection host', () => {
    expect(resolveConnectHost({ jid: 'bot@example.com' })).toBe('example.com');
  });
});
