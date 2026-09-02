import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearMucOccupantIdentities,
  getMucOccupantRealJid,
  trackMucOccupantIdentity,
} from '../src/muc-identity.js';

const accountId = 'test-account';
const room = 'room@conference.example.com';
const nick = 'visitor';

function presence(realJid?: string, type?: string) {
  const attrs: Record<string, string> = { from: `${room}/${nick}` };
  if (type) attrs.type = type;
  const children = realJid ? [xml('item', { jid: realJid })] : [];
  return xml(
    'presence',
    attrs,
    xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, ...children)
  );
}

afterEach(() => clearMucOccupantIdentities(accountId));

describe('MUC occupant identity tracking', () => {
  it('registers the verified bare real JID', () => {
    trackMucOccupantIdentity(presence('User@Example.com/resource'), accountId);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBe('user@example.com');
  });

  it('removes an identity on unavailable presence', () => {
    trackMucOccupantIdentity(presence('user@example.com'), accountId);
    trackMucOccupantIdentity(presence(undefined, 'unavailable'), accountId);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBeUndefined();
  });

  it('deletes a stale identity when available presence omits the real JID', () => {
    trackMucOccupantIdentity(presence('user@example.com'), accountId);
    trackMucOccupantIdentity(presence(), accountId);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBeUndefined();
  });

  it('cleans up all identities for an account', () => {
    trackMucOccupantIdentity(presence('user@example.com'), accountId);
    clearMucOccupantIdentities(accountId);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBeUndefined();
  });
});
