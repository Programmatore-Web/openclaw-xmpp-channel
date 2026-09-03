import { describe, expect, it } from 'vitest';
import { selectPasswordSaslMechanism } from '../src/sasl.js';

describe('password SASL mechanism selection', () => {
  it('prefers SCRAM-SHA-1 even when PLAIN is offered first', () => {
    expect(selectPasswordSaslMechanism(['PLAIN', 'SCRAM-SHA-1'])).toBe('SCRAM-SHA-1');
  });

  it('falls back to PLAIN', () => {
    expect(selectPasswordSaslMechanism(['PLAIN'])).toBe('PLAIN');
  });

  it('rejects ANONYMOUS-only authentication', () => {
    expect(() => selectPasswordSaslMechanism(['ANONYMOUS'])).toThrow(
      'No supported password SASL mechanism is available'
    );
  });

  it('rejects mechanisms outside the supported password set', () => {
    expect(() => selectPasswordSaslMechanism(['EXTERNAL', 'DIGEST-MD5'])).toThrow(
      'No supported password SASL mechanism is available'
    );
  });
});
