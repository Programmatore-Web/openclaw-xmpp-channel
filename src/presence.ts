import { randomUUID } from 'node:crypto';
import { xml, type Element, type XmppClient } from '@xmpp/client';
import type { ChannelAccountSnapshot } from 'openclaw/plugin-sdk/channel-contract';
import type { GatewayStartContext, XmppConfig, XmppPresenceConfig } from './types.js';
import { bareJid } from './config-schema.js';
import { isSenderAllowed, normalizeAllowFrom, normalizeXmppRoomJid } from './normalize.js';
import { getXmppRuntime } from './runtime.js';

export const PRESENCE_POLL_MS = 1000;
export const PRESENCE_IO_BUDGET_MS = 5000;
export const PRESENCE_STOP_BUDGET_MS = 250;
const ROSTER_NS = 'jabber:iq:roster';

interface RosterIqClient {
  iqCallee?: {
    set(namespace: string, name: string, handler: (ctx: { stanza: Element }) => boolean): void;
  };
}

/** Native iqCallee owns exactly one reply. Its API has no unregister method;
 * detach the controller from the permanent per-client route on disposal. */
function registerRosterPushRoute(client: RosterIqClient, accept: (stanza: Element) => boolean) {
  let handler: typeof accept | undefined = accept;
  client.iqCallee?.set(ROSTER_NS, 'query', ({ stanza }) => handler?.(stanza) ?? false);
  return () => {
    handler = undefined;
  };
}

export interface OperationalPresence {
  state: 'available' | 'unavailable';
  text?: string;
}

export function derivePresence(
  config: XmppPresenceConfig | undefined,
  status: ChannelAccountSnapshot
): OperationalPresence {
  const mode = config?.mode ?? 'auto';
  const unavailable =
    mode === 'unavailable' ||
    (mode === 'auto' &&
      (status.busy === true ||
        (status.activeRuns ?? 0) > 0 ||
        status.ingressUnavailable === true ||
        status.lifecycle === 'blocked'));
  const text = unavailable ? config?.unavailableText : config?.availableText;
  return {
    state: unavailable ? 'unavailable' : 'available',
    text: text === '' ? undefined : text,
  };
}

export function buildOperationalPresence(value: OperationalPresence, to?: string): Element {
  return xml(
    'presence',
    to ? { to } : {},
    ...(value.state === 'unavailable' ? [xml('show', {}, 'dnd')] : []),
    ...(value.text ? [xml('status', {}, value.text)] : []),
    xml('priority', {}, '1')
  );
}

/** Presence trust is independent of all DM/group policies. No pairing challenge. */
export async function authorizePresence(
  config: XmppConfig,
  accountId: string,
  sender: string
): Promise<boolean> {
  const jid = normalizeXmppRoomJid(bareJid(sender));
  if (!jid) {
    return false;
  }
  // A wildcard owner list is not an explicit human identity. Public presence
  // must be selected through presenceAllowFrom itself.
  if (
    normalizeAllowFrom(config.allowFrom).entries.includes(jid) ||
    isSenderAllowed(normalizeAllowFrom(config.presenceAllowFrom), jid)
  ) {
    return true;
  }
  // Propagate store failures: callers deny, and roster reconciliation stays closed.
  const approved = await getXmppRuntime().channel.pairing.readAllowFromStore({
    channel: 'xmpp',
    accountId,
  });
  return normalizeAllowFrom(approved.map(String)).entries.includes(jid);
}

/** A single client-owned controller; retained publication survives only SM resume. */
export function createPresenceController(params: {
  xmpp: XmppClient;
  ctx: GatewayStartContext;
  isCurrent: () => boolean;
  isOnline: () => boolean;
  // The monitor supplies its original send after protocol readiness is established.
  // There must be no asynchronous gate between our final ownership check and send.
  send: (stanza: Element) => Promise<void>;
}) {
  const { xmpp, ctx } = params;
  let disposed = false;
  let connected = false;
  let reconciled = false;
  let generation = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  let published: OperationalPresence | undefined;
  let publishing: object | undefined;
  // Only in-flight approvals, never a cache of trusted/server subscribers.
  const approvals = new Map<string, object>();
  const current = (signal = generation.signal) =>
    !disposed &&
    !signal.aborted &&
    signal === generation.signal &&
    connected &&
    params.isCurrent() &&
    params.isOnline();
  const warn = () => {
    try {
      ctx.log?.warn?.(
        `[${ctx.accountId}] Operational presence publication/authorization unavailable; failing closed`
      );
    } catch {
      /* Reporting cannot escape a detached presence task. */
    }
  };
  const read = () =>
    derivePresence(ctx.account.config.presence, ctx.getStatus?.() ?? { accountId: ctx.accountId });
  const send = (stanza: Element, signal: AbortSignal) => {
    if (!current(signal)) {
      return Promise.reject(new Error('Presence session cancelled'));
    }
    return params.send(stanza);
  };

  /** Cancellation removes every owned deadline/listener even if foreign IO hangs. */
  function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!current(signal)) {
        reject(new Error('Presence session cancelled'));
        return;
      }
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        complete();
      };
      const fail = (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error('Presence operation failed'))
        );
      const onAbort = () => fail(new Error('Presence session cancelled'));
      const timer = setTimeout(
        () => fail(new Error('Presence operation timed out')),
        PRESENCE_IO_BUDGET_MS
      );
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        void run().then((value) => finish(() => resolve(value)), fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  const serverOrigin = (stanza: Element) =>
    !stanza.attrs.from ||
    stanza.attrs.from.toLowerCase() === bareJid(ctx.account.config.jid).toLowerCase();

  // A cancellable roster IQ avoids iqCaller 0.14's uncancellable handler/timer
  // and validates response origin as well as the unpredictable request id.
  async function roster(signal: AbortSignal): Promise<Element[]> {
    const id = `presence-roster-${randomUUID()}`;
    let listener: ((stanza: Element) => void) | undefined;
    try {
      const result = await bounded(
        () =>
          new Promise<Element>((resolve, reject) => {
            listener = (stanza) => {
              if (stanza.name !== 'iq' || stanza.attrs.id !== id || !serverOrigin(stanza)) {
                return;
              }
              if (stanza.attrs.type === 'error') {
                reject(new Error('Roster refused'));
              }
              if (stanza.attrs.type === 'result') {
                resolve(stanza);
              }
            };
            xmpp.on('stanza', listener);
            void send(
              xml('iq', { type: 'get', id }, xml('query', { xmlns: ROSTER_NS })),
              signal
            ).catch(reject);
          }),
        signal
      );
      const query = result.getChild('query', ROSTER_NS);
      if (!query) {
        throw new Error('Missing roster');
      }
      const items = query.getChildren('item');
      if (
        items.some(
          (item) =>
            !normalizeXmppRoomJid(item.attrs.jid ?? '') ||
            !['none', 'to', 'from', 'both'].includes(item.attrs.subscription ?? 'none')
        )
      ) {
        throw new Error('Invalid roster');
      }
      return items;
    } finally {
      if (listener) {
        xmpp.off('stanza', listener);
      }
    }
  }

  async function unauthorized(items: Element[], signal: AbortSignal): Promise<string[]> {
    const denied: string[] = [];
    for (const item of items) {
      if (!['from', 'both'].includes(item.attrs.subscription) && item.attrs.approved !== 'true') {
        continue;
      }
      if (
        !(await bounded(
          () => authorizePresence(ctx.account.config, ctx.accountId, item.attrs.jid),
          signal
        ))
      ) {
        denied.push(item.attrs.jid);
      }
    }
    return [...new Set(denied)];
  }

  async function publish(): Promise<void> {
    const signal = generation.signal;
    if (!current(signal) || !reconciled || publishing) {
      return;
    }
    const token = {};
    publishing = token;
    try {
      const next = read();
      if (published?.state === next.state && published.text === next.text) {
        return;
      }
      await bounded(() => send(buildOperationalPresence(next), signal), signal);
      if (current(signal)) {
        published = next;
      }
    } catch {
      if (current(signal)) {
        warn();
      }
    } finally {
      if (publishing === token) {
        publishing = undefined;
      }
    }
  }

  function suspend() {
    connected = false;
    clearInterval(poll);
    poll = undefined;
    generation.abort();
    generation = new AbortController();
    publishing = undefined;
    approvals.clear();
  }

  // Roster pushes must be acknowledged, but never establish local presence trust.
  const onRosterPush = (stanza: Element) => {
    if (
      !current() ||
      stanza.name !== 'iq' ||
      stanza.attrs.type !== 'set' ||
      !stanza.attrs.id ||
      !stanza.getChild('query', ROSTER_NS) ||
      !serverOrigin(stanza)
    ) {
      return;
    }
    void bounded(
      () =>
        send(
          xml('iq', {
            type: 'result',
            id: stanza.attrs.id,
            ...(stanza.attrs.from ? { to: stanza.attrs.from } : {}),
          }),
          generation.signal
        ),
      generation.signal
    ).catch(warn);
  };
  const iqClient = xmpp as unknown as RosterIqClient;
  const disposeRosterPush = iqClient.iqCallee
    ? registerRosterPushRoute(iqClient, (stanza) => current() && serverOrigin(stanza))
    : (() => {
        // Minimal clients without the native IQ module need a direct responder.
        xmpp.on('stanza', onRosterPush);
        return () => xmpp.off('stanza', onRosterPush);
      })();

  return {
    suspend,
    reset() {
      suspend();
      reconciled = false;
      published = undefined;
    },
    async ready(fresh: boolean) {
      if (disposed || !params.isCurrent()) {
        return;
      }
      connected = true;
      const signal = generation.signal;
      if (fresh) {
        reconciled = false;
        published = undefined;
        try {
          const denied = await unauthorized(await roster(signal), signal);
          for (const jid of denied) {
            await bounded(
              () => send(xml('presence', { to: jid, type: 'unsubscribed' }), signal),
              signal
            );
          }
          // Verify server-side completion, not merely that cancellation was written.
          if (denied.length && (await unauthorized(await roster(signal), signal)).length) {
            throw new Error('Roster revocation unconfirmed');
          }
          if (!current(signal)) {
            return;
          }
          reconciled = true;
        } catch {
          if (current(signal)) {
            warn();
          }
        }
      }
      if (!current(signal)) {
        return;
      }
      // No timer needed when reconciliation failed. Trusted directed replies work.
      if (reconciled) {
        clearInterval(poll);
        poll = setInterval(() => {
          if (!params.isCurrent()) {
            suspend();
            return;
          }
          void publish();
        }, PRESENCE_POLL_MS);
        poll.unref?.();
        await publish();
      }
    },
    async handle(this: void, type: string, from: string) {
      const signal = generation.signal;
      if (!current(signal)) {
        return;
      }
      const to = normalizeXmppRoomJid(bareJid(from));
      if (!to) {
        return;
      }
      if (type === 'subscribe' && approvals.has(to)) {
        return;
      }
      const approval = type === 'subscribe' ? {} : undefined;
      if (approval) {
        approvals.set(to, approval);
      }
      try {
        if (type === 'unsubscribe') {
          approvals.delete(to);
          await bounded(() => send(xml('presence', { to, type: 'unsubscribed' }), signal), signal);
          return;
        }
        if (type !== 'subscribe' && type !== 'probe') {
          return;
        }
        if (
          !(await bounded(() => authorizePresence(ctx.account.config, ctx.accountId, to), signal))
        ) {
          return;
        }
        if (type === 'subscribe') {
          if (approvals.get(to) !== approval) {
            return;
          }
          await bounded(() => send(xml('presence', { to, type: 'subscribed' }), signal), signal);
          if (approvals.get(to) !== approval) {
            return;
          }
        }
        await bounded(() => send(buildOperationalPresence(read(), to), signal), signal);
      } catch {
        if (current(signal)) {
          warn();
        }
      } finally {
        if (approval && approvals.get(to) === approval) {
          approvals.delete(to);
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      suspend();
      published = undefined;
      reconciled = false;
      disposeRosterPush();
    },
  };
}
