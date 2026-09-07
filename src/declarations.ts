declare module '@xmpp/client' {
  export function client(options: {
    service: string;
    domain: string;
    username: string;
    password?: string;
    credentials?: (
      authenticate: (
        credentials: { username: string; password: string },
        mechanism: string
      ) => Promise<void>,
      mechanisms: string[],
      fast: unknown,
      entity: XmppClient
    ) => Promise<void>;
    resource?: string;
  }): XmppClient;

  export function xml(
    name: string,
    attrs?: Record<string, string>,
    ...children: unknown[]
  ): Element;

  export interface XmppClient {
    jid?: { toString(): string };
    isSecure(): boolean;
    on(event: 'stanza', handler: (stanza: Element) => void): void;
    on(event: 'online', handler: (address: { toString(): string }) => void): void;
    on(event: 'offline', handler: () => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    off(event: 'stanza', handler: (stanza: Element) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    removeListener(event: 'stanza', handler: (stanza: Element) => void): void;
    removeListener(event: string, handler: (...args: unknown[]) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: Element): Promise<void>;
  }

  export interface Element {
    name: string;
    is(name: string): boolean;
    attrs: Record<string, string>;
    getChildText(name: string): string | null;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string): Element[];
    text(): string;
    children?: Array<Element | string>;
    toString(): string;
    c(name: string, attrs?: Record<string, string>): Element;
    t(text: string): Element;
  }
}
