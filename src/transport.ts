import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { xml } from './xmpp.js';
import { assertXmppRuntimeCompatible } from './xmpp-runtime-compat.js';
import type { client, Element } from '@xmpp/client';

interface NamespacedElement extends Element {
  is(name: string, namespace?: string): boolean;
}

interface Transport {
  destroyed?: boolean;
  once?: (event: string, callback: () => void) => unknown;
  off?: (event: string, callback: () => void) => unknown;
  listenerCount?: (event: string) => number;
  emit?: (event: string, error: Error) => boolean;
  destroy?: () => void;
  socket?: Transport | null;
  timeout?: number | ReturnType<typeof setTimeout> | null;
}

interface Entity {
  timeout?: number;
  status: string;
  socket?: Transport | null;
  parser?: Transport | null;
  streamManagement?: { enabled: boolean };
  iqCaller?: { handlers: Map<string, { promise: Promise<unknown>; reject(error: Error): void }> };
  _ready?: (resumed?: boolean) => void;
  options: { service: string; domain: string; lang?: string };
  connect(service: string): Promise<unknown>;
  open(options: { domain: string; lang?: string }): Promise<unknown>;
  disconnect(): Promise<unknown>;
  restart?: () => Promise<unknown>;
  sendReceive?: (element: Element) => Promise<NamespacedElement>;
  write?: (data: string) => Promise<unknown>;
  _closeSocket?: () => Promise<unknown>;
  reconnect?: { stop(): void };
  _attachSocket?: (socket: Transport) => void;
  _detachSocket?: () => void;
  _detachParser?: () => void;
  _onElement?: (element: NamespacedElement) => void;
  _onSeeOtherHost?: (error: { element: Element }) => void;
  listenerCount?: (event: string) => number;
  emit?: (event: string, ...args: unknown[]) => boolean;
}

/** Two native 2s close phases plus the existing 1s teardown allowance. */
export const TRANSPORT_CLOSE_BUDGET_MS = 5000;

/** RFC 6120 §4.9.3.19: allow two successive redirects per connection attempt. */
export const MAX_CONSECUTIVE_REDIRECTS = 2;

/** Destroy is a last resort and must never escape an event/cleanup boundary. */
export function destroyTransport(socket?: Transport | null): void {
  if (!socket) {
    return;
  }
  // @xmpp/tls 0.14.0 exposes a wrapper with no destroy(), and can detach
  // its inner TLSSocket. Capture the inner reference before any close effect.
  const inner = socket.socket;
  if (socket.timeout && typeof socket.timeout === 'object') {
    clearTimeout(socket.timeout);
  }
  try {
    if (!socket.destroyed) {
      socket.destroy?.();
    }
  } catch {
    // Still dispose an inner socket when a wrapper's destroy throws.
  }
  if (inner && inner !== socket) {
    destroyTransport(inner);
  }
}

/**
 * Adapter for @xmpp/connection 0.14.0. Only run() authorizes a new connection.
 * Stream restarts (STARTTLS/SASL) still use the library's open() normally.
 * A timed-out operation retires this entity: its uncancellable continuation
 * must never share mutable parser/SM state with a subsequent attempt.
 */
export function governTransport(
  xmpp: ReturnType<typeof client>,
  current: () => boolean,
  redirect: (service?: string) => void
) {
  assertXmppRuntimeCompatible();
  const entity = xmpp as unknown as Entity;
  const connect = entity.connect.bind(entity);
  const open = entity.open.bind(entity);
  const disconnect = entity.disconnect?.bind(entity);
  const write = entity.write?.bind(entity);
  const closeSocket = entity._closeSocket?.bind(entity);
  const receive = entity.sendReceive?.bind(entity);
  const emit = entity.emit?.bind(entity);
  const ready = entity._ready?.bind(entity);
  const attach = entity._attachSocket?.bind(entity);
  const onElement = entity._onElement?.bind(entity);
  const sockets = new Map<Transport, () => void>();
  const track = (transport: Transport) => {
    if (sockets.has(transport) || transport.destroyed) {
      return;
    }
    const remove = () => {
      transport.off?.('close', remove);
      sockets.delete(transport);
    };
    sockets.set(transport, remove);
    if (transport.socket && transport.socket !== transport) {
      track(transport.socket);
    }
    transport.once?.('close', remove);
  };
  const cancellations = new Set<() => void>();
  let isCurrent: (() => boolean) | undefined = current;
  let onRedirect: ((service?: string) => void) | undefined = redirect;
  let retired = false;
  let authorized = false;
  let busy = false;
  let closing: Promise<void> | undefined;
  let upgrading = false;
  let consecutiveRedirects = 0;
  const operationAbort = new AbortController();
  let socket = entity.socket;
  if (socket) {
    track(socket);
  }
  const valid = () => !retired && isCurrent?.() === true;
  const cancelled = () => new Error('XMPP transport operation cancelled');
  const destroyAll = () => {
    if (socket) {
      track(socket);
    }
    for (const [transport, remove] of sockets) {
      remove();
      if (retired && transport.listenerCount?.('error')) {
        try {
          transport.emit?.('error', cancelled());
        } catch {
          /* Contain transport listeners. */
        }
      }
      destroyTransport(transport);
    }
    sockets.clear();
    entity._detachSocket?.();
    entity._detachParser?.();
    socket = null;
  };

  // Retain even references that disconnect() drops after its close timeout.
  // This also catches a late attachment after abort/replacement/timeout.
  Object.defineProperty(entity, 'socket', {
    configurable: true,
    get: () => socket,
    set: (next: Transport | null) => {
      if (next && !valid()) {
        destroyTransport(next);
        socket = null;
      } else {
        socket = next;
        if (next) {
          track(next);
        }
      }
    },
  });
  if (attach) {
    entity._attachSocket = (next) => {
      if (!valid()) {
        destroyTransport(next);
        // Stop native connect() before it can call connect() on a destroyed socket.
        throw cancelled();
      }
      attach(next);
    };
  }
  entity.connect = (service) => {
    if (!authorized || !valid()) {
      return Promise.reject(cancelled());
    }
    return connect(service);
  };
  entity.open = (options) => {
    if (!valid()) {
      return Promise.reject(cancelled());
    }
    return bounded(() => open(options), 'open', entity.timeout ?? 2000);
  };
  // Native middleware may report errors after its entity has been retired.
  // No monitor closure or error listener is retained to consume those events.
  if (emit) {
    entity.emit = (event, ...args) => (retired ? false : emit(event, ...args));
  }
  if (ready) {
    entity._ready = (resumed) => {
      if (valid()) {
        ready(resumed);
      }
    };
  }
  const sm = entity.streamManagement;
  if (sm) {
    let enabled = sm.enabled;
    Object.defineProperty(sm, 'enabled', {
      configurable: true,
      get: () => !retired && enabled,
      set: (value: boolean) => {
        enabled = !retired && value;
      },
    });
  }
  if (receive) {
    entity.sendReceive = async (element) => {
      if (!valid()) {
        throw cancelled();
      }
      const response = await receive(element);
      if (!valid()) {
        throw cancelled();
      }
      return response;
    };
  }
  const startTls = async (raw: net.Socket) => {
    if (upgrading || !valid()) {
      return;
    }
    upgrading = true;
    try {
      const response = await bounded(
        () => entity.sendReceive!(xml('starttls', { xmlns: 'urn:ietf:params:xml:ns:xmpp-tls' })),
        'STARTTLS negotiation',
        entity.timeout ?? 2000
      );
      if (!valid()) {
        throw cancelled();
      }
      if (!response.is('proceed', 'urn:ietf:params:xml:ns:xmpp-tls')) {
        throw new Error('STARTTLS_FAILURE');
      }
      // Same tls.connect options as native starttls.upgrade(). Capture its
      // TLSSocket immediately, before awaiting secureConnect (native upgrade
      // exposes its wrapper only after this wait and cannot cancel that wait).
      const secure = Object.assign(tls.connect({ socket: raw, host: entity.options.domain }), {
        secure: true,
      });
      track(secure);
      await bounded(
        () => once(secure, 'secureConnect', { signal: operationAbort.signal }),
        'STARTTLS',
        entity.timeout ?? 2000
      );
      if (!valid()) {
        throw cancelled();
      }
      // Retain the installed TLS 1.3/Openfire compatibility delay, cancellably.
      if (secure.getProtocol() === 'TLSv1.3') {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            cancellations.delete(cancel);
            resolve();
          };
          const cancel = () => {
            clearTimeout(timer);
            cancellations.delete(cancel);
            reject(cancelled());
          };
          const timer = setTimeout(finish, 1);
          cancellations.add(cancel);
        });
      }
      if (!valid()) {
        throw cancelled();
      }
      entity._detachSocket?.();
      entity._attachSocket?.(secure);
      await entity.restart?.();
    } catch (error) {
      if (valid()) {
        entity.emit?.('error', error);
        await close().catch(() => {});
      }
    } finally {
      upgrading = false;
    }
  };
  const requestRedirect = (element: Element) => {
    if (!valid()) {
      destroyAll();
      return;
    }
    try {
      const host = element.getChildText('see-other-host');
      const protocol = new URL(entity.options.service).protocol;
      const target = new URL(`${protocol}//${host}`);
      if (
        !host ||
        /[\s\\]/u.test(host) ||
        target.username ||
        target.password ||
        target.pathname ||
        target.search ||
        target.hash
      ) {
        throw new Error('Invalid XMPP see-other-host target');
      }
      if (consecutiveRedirects >= MAX_CONSECUTIVE_REDIRECTS) {
        throw new Error(`XMPP successive redirect limit (${MAX_CONSECUTIVE_REDIRECTS}) exceeded`);
      }
      consecutiveRedirects++;
      onRedirect?.(`${protocol}//${target.host}`);
    } catch (error) {
      emit?.('error', error);
      // No destination means this attempt failed: close and use plugin backoff.
      onRedirect?.();
    }
  };
  if (onElement) {
    entity._onElement = (element) => {
      if (!valid()) {
        return;
      }
      if (
        element.is('features', 'http://etherx.jabber.org/streams') &&
        element.getChild('starttls', 'urn:ietf:params:xml:ns:xmpp-tls') &&
        entity.socket instanceof net.Socket &&
        !(entity.socket instanceof tls.TLSSocket)
      ) {
        // Consume only the pre-TLS features. Native middleware handles the new
        // features after restart, including SASL, binding and SM unchanged.
        void startTls(entity.socket).catch(() => {});
        return;
      }
      if (
        element.is('error', 'http://etherx.jabber.org/streams') &&
        element.getChild('see-other-host', 'urn:ietf:params:xml:ns:xmpp-streams')
      ) {
        // Replace the complete native redirect branch, including its detached
        // disconnect(). Otherwise that close can race the new connection.
        requestRedirect(element);
        emit?.('element', element);
        emit?.('nonza', element);
      } else {
        onElement(element);
      }
    };
    entity._onSeeOtherHost = ({ element }) => requestRedirect(element);
  }

  const retire = () => {
    if (retired) {
      return;
    }
    // Let native SM cancel its own timers, without emitting offline on the
    // resumable failure path. The entity is never reused after a timeout.
    retired = true;
    operationAbort.abort();
    emit?.('disconnect');
    if (entity.listenerCount?.('error')) {
      emit?.('error', cancelled());
    }
    const parser = entity.parser;
    if (parser?.listenerCount?.('error')) {
      parser.emit?.('error', cancelled());
    }
    // IQCaller has no disconnect cancellation; rejecting its Deferred clears
    // the native 30s timeout, including an unfinished resource-binding IQ.
    for (const deferred of entity.iqCaller?.handlers.values() ?? []) {
      // request() may still be awaiting send() and not yet observing Deferred.
      void deferred.promise.catch(() => {});
      deferred.reject(cancelled());
    }
    entity.iqCaller?.handlers.clear();
    for (const cancel of cancellations) {
      cancel();
    }
    cancellations.clear();
    destroyAll();
  };
  // Every operation is cancellable on retirement. A deadline belongs to the
  // containing protocol operation; ordinary application writes have no timer.
  const operate = <T>(
    operation: () => Promise<T>,
    deadline?: { name: string; ms: number }
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cancellations.delete(cancel);
        complete();
      };
      const fail = (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error(typeof error === 'string' ? error : 'XMPP transport operation failed', {
                  cause: error,
                })
          )
        );
      const cancel = () => fail(cancelled());
      const timer = deadline
        ? setTimeout(() => {
            fail(new Error(`XMPP ${deadline.name} exceeded ${deadline.ms}ms`));
            retire();
          }, deadline.ms)
        : undefined;
      cancellations.add(cancel);
      try {
        void Promise.resolve(operation()).then((result) => {
          if (!valid()) {
            destroyAll();
            fail(cancelled());
          } else {
            finish(() => resolve(result));
          }
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
  const bounded = <T>(operation: () => Promise<T>, name: string, ms: number) =>
    operate(operation, { name, ms });
  if (write) {
    entity.write = (data) => (valid() ? operate(() => write(data)) : Promise.reject(cancelled()));
  }
  if (closeSocket) {
    entity._closeSocket = () => (retired ? Promise.resolve() : closeSocket());
  }
  const close = (): Promise<void> => {
    if (closing) {
      return closing;
    }
    closing = (async () => {
      try {
        if (!retired && disconnect) {
          await bounded(disconnect, 'disconnect', TRANSPORT_CLOSE_BUDGET_MS);
        }
      } finally {
        destroyAll();
        closing = undefined;
      }
    })();
    return closing;
  };
  // Non-redirect native stream errors also use the bounded, deduplicated close.
  entity.disconnect = () => close().catch(() => {});

  return {
    get reusable() {
      return !retired && !upgrading;
    },
    get busy() {
      return busy;
    },
    resetRedirects() {
      if (valid()) {
        consecutiveRedirects = 0;
      }
    },
    async run(service = entity.options.service, redirected = false) {
      if (!valid() || busy) {
        throw cancelled();
      }
      busy = true;
      if (!redirected) {
        consecutiveRedirects = 0;
      }
      try {
        if (closing) {
          await closing;
        }
        if (!valid()) {
          throw cancelled();
        }
        authorized = true;
        // Native timeout is 2000ms. Cover the whole call, including DNS/write,
        // rather than only the final event wait used by the library.
        const connecting = bounded(
          () => entity.connect(service),
          'connect',
          entity.timeout ?? 2000
        );
        authorized = false;
        await connecting;
        if (!valid()) {
          destroyAll();
          throw cancelled();
        }
        await entity.open(entity.options);
      } finally {
        authorized = false;
        busy = false;
      }
    },
    close,
    retire,
    dispose() {
      entity.reconnect?.stop();
      retire();
      isCurrent = undefined;
      onRedirect = undefined;
    },
  };
}
