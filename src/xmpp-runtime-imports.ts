// Reviewed bare @xmpp import sites in the 0.14.0 runtime (not tests/examples).
// Keep source locations: resolving only from this plugin misses nested copies.
// Reinspect this map alongside the version set when upgrading; no runtime parsing.
export const XMPP_RUNTIME_IMPORTS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  '@xmpp/base64': {},
  '@xmpp/client': {
    'index.js': [
      '@xmpp/client-core',
      '@xmpp/reconnect',
      '@xmpp/websocket',
      '@xmpp/tcp',
      '@xmpp/tls',
      '@xmpp/middleware',
      '@xmpp/stream-features',
      '@xmpp/iq/caller.js',
      '@xmpp/iq/callee.js',
      '@xmpp/resolve',
      '@xmpp/starttls',
      '@xmpp/sasl2',
      '@xmpp/sasl',
      '@xmpp/resource-binding',
      '@xmpp/stream-management',
      '@xmpp/client-core/src/bind2/bind2.js',
      '@xmpp/client-core/src/fast/fast.js',
      '@xmpp/sasl-scram-sha-1',
      '@xmpp/sasl-plain',
      '@xmpp/sasl-anonymous',
      '@xmpp/sasl-ht-sha-256-none',
    ],
  },
  '@xmpp/client-core': {
    'index.js': ['@xmpp/xml', '@xmpp/jid'],
    'lib/Client.js': ['@xmpp/connection'],
    'src/bind2/bind2.js': ['@xmpp/xml'],
    'src/fast/fast.js': ['@xmpp/events', '@xmpp/sasl', '@xmpp/sasl/lib/SASLError.js', '@xmpp/xml'],
  },
  '@xmpp/connection': {
    'index.js': ['@xmpp/events', '@xmpp/jid', '@xmpp/xml'],
    'lib/StreamError.js': ['@xmpp/error'],
  },
  '@xmpp/connection-tcp': {
    'index.js': ['@xmpp/connection', '@xmpp/xml', '@xmpp/connection/lib/util.js'],
  },
  '@xmpp/error': {},
  '@xmpp/events': {},
  '@xmpp/id': {},
  '@xmpp/iq': {
    'callee.js': ['@xmpp/xml'],
    'caller.js': ['@xmpp/id', '@xmpp/middleware/lib/StanzaError.js', '@xmpp/events', '@xmpp/xml'],
  },
  '@xmpp/jid': {},
  '@xmpp/middleware': {
    'lib/IncomingContext.js': ['@xmpp/jid'],
    'lib/OutgoingContext.js': ['@xmpp/jid'],
    'lib/StanzaError.js': ['@xmpp/error'],
  },
  '@xmpp/reconnect': {
    'index.js': ['@xmpp/events'],
  },
  '@xmpp/resolve': {
    'index.js': ['@xmpp/events'],
    'lib/http.js': ['@xmpp/xml/lib/parse.js'],
  },
  '@xmpp/resource-binding': {
    'index.js': ['@xmpp/xml'],
  },
  '@xmpp/sasl': {
    'index.js': ['@xmpp/base64', '@xmpp/xml', '@xmpp/events'],
    'lib/SASLError.js': ['@xmpp/error'],
  },
  '@xmpp/sasl-anonymous': {},
  '@xmpp/sasl-ht-sha-256-none': {},
  '@xmpp/sasl-plain': {},
  '@xmpp/sasl-scram-sha-1': {},
  '@xmpp/sasl2': {
    'index.js': [
      '@xmpp/base64',
      '@xmpp/sasl/lib/SASLError.js',
      '@xmpp/xml',
      '@xmpp/events',
      '@xmpp/sasl',
    ],
  },
  '@xmpp/starttls': {
    'index.js': ['@xmpp/xml'],
    'starttls.js': ['@xmpp/events', '@xmpp/tls/lib/Socket.js'],
  },
  '@xmpp/stream-features': {},
  '@xmpp/stream-management': {
    'index.js': ['@xmpp/events', '@xmpp/xml', '@xmpp/time'],
    'stream-feature.js': ['@xmpp/error', '@xmpp/events'],
  },
  '@xmpp/tcp': {
    'lib/Connection.js': ['@xmpp/connection-tcp'],
  },
  '@xmpp/time': {},
  '@xmpp/tls': {
    'lib/Connection.js': ['@xmpp/connection/lib/util.js', '@xmpp/connection-tcp'],
    'lib/Socket.js': ['@xmpp/events'],
  },
  '@xmpp/websocket': {
    'lib/Connection.js': ['@xmpp/connection', '@xmpp/xml'],
    'lib/FramedParser.js': ['@xmpp/xml'],
    'lib/Socket.js': ['@xmpp/events', '@xmpp/connection/lib/util.js'],
  },
  '@xmpp/xml': {
    'lib/Parser.js': ['@xmpp/events'],
  },
};
