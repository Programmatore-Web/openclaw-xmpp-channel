export type SupportedPasswordSaslMechanism = 'SCRAM-SHA-1' | 'PLAIN';

/** Select only password mechanisms supported by this baseline. */
export function selectPasswordSaslMechanism(
  mechanisms: readonly string[]
): SupportedPasswordSaslMechanism {
  if (mechanisms.includes('SCRAM-SHA-1')) return 'SCRAM-SHA-1';
  if (mechanisms.includes('PLAIN')) return 'PLAIN';
  throw new Error('No supported password SASL mechanism is available');
}
