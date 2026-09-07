import { getActiveClient } from '@openclaw/xmpp';

type IsAny<T> = 0 extends 1 & T ? true : false;
const clientIsAny: IsAny<ReturnType<typeof getActiveClient>> = false;
const client = getActiveClient('default');
const canBeAbsent: ReturnType<typeof getActiveClient> = undefined;
// @ts-expect-error account IDs must be strings
getActiveClient(123);
if (client) {
  const secure: boolean = client.isSecure();
  const jid: string | undefined = client.jid?.toString();
  const starting: Promise<void> = client.start();
  const stopping: Promise<void> = client.stop();
  const sendIsAny: IsAny<typeof client.send> = false;
  client.on('online', (address) => {
    const jid: string = address.toString();
  });
  client.on('offline', () => {});
  client.on('error', (error) => {
    const message: string = error.message;
  });
  client.on('stanza', (stanza) => {
    const stanzaIsAny: IsAny<typeof stanza> = false;
    const name: string = stanza.name;
    const matches: boolean = stanza.is('message');
    const attrs: Record<string, string> = stanza.attrs;
    const body: string | null = stanza.getChildText('body');
    const child: typeof stanza | undefined = stanza.getChild('body');
    const children: Array<typeof stanza> = stanza.getChildren('body');
    const mixed: Array<typeof stanza | string> | undefined = stanza.children;
    const text: string = stanza.text();
    const serialized: string = stanza.toString();
    const nested: typeof stanza = stanza.c('body', {}).t('hello');
    const sending: Promise<void> = client.send(stanza);
    const handler = (received: typeof stanza): void => {};
    client.off('stanza', handler);
    client.removeListener('stanza', handler);
    client.off('custom', (...args: unknown[]) => {});
    client.removeListener('custom', (...args: unknown[]) => {});
    // @ts-expect-error stanza attributes are strings
    stanza.attrs.id = 123;
  });
  // @ts-expect-error send requires an XML element
  client.send('message');
  // @ts-expect-error event overloads must remain typed
  client.on('unsupported', () => {});
}
