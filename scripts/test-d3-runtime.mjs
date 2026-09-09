// Local integration characterization of the installed, exact OpenClaw host.
// XMPP client construction, the model resolver and inbound agent/session plumbing
// are fixtures. Dispatcher, outbound routing/adapter, monitor, run tracker and
// Gateway account store/status handler are real.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const host = resolve(process.argv[2] ?? join(repository, 'node_modules/openclaw'));
const hostRequire = createRequire(join(host, 'package.json'));
const version = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version;
assert.ok(
  ['2026.8.2', '2026.9.2'].includes(version),
  'revalidate the host characterization before upgrading'
);
const temporary = await mkdtemp(join(tmpdir(), 'xmpp-d3-runtime-'));
process.env.OPENCLAW_STATE_DIR = temporary;
process.env.OPENCLAW_CONFIG_PATH = join(temporary, 'unused-config.json');

// Private host exports are used ONLY by this test, never by the plugin.
// Resolve content-hashed bundle names from the exact installed host.
async function hostExport(name) {
  for (const file of readdirSync(join(host, 'dist'))) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(host, 'dist', file), 'utf8');
    if (!source.includes(`function ${name}(`) && !source.includes(`const ${name} =`)) continue;
    const match = source.match(new RegExp(`export \\{[^}]*\\b${name}(?: as (\\w+))?[, }]`));
    if (match) return (await import(pathToFileURL(join(host, 'dist', file))))[match[1] ?? name];
  }
  throw new Error(`Missing characterized host export: ${name}`);
}

let makeClient;
globalThis[Symbol.for('xmpp.d3.test.client')] = () => makeClient();
const boundary = pathToFileURL(join(repository, 'dist/src/xmpp.js')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('openclaw/plugin-sdk/')) {
      return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true };
    }
    if (specifier === './xmpp.js' && context.parentURL?.endsWith('/dist/src/monitor.js')) {
      return { url: 'xmpp-d3:client', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'xmpp-d3:client')
      return {
        format: 'module',
        shortCircuit: true,
        source: `export { xml } from ${JSON.stringify(boundary)};
        export const client = () => globalThis[Symbol.for('xmpp.d3.test.client')]();`,
      };
    return next(url, context);
  },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

try {
  const createChannelManager = await hostExport('createChannelManager');
  const createEmptyPluginRegistry = await hostExport('createEmptyPluginRegistry');
  const setActivePluginRegistry = await hostExport('setActivePluginRegistry');
  const routeReply = await hostExport('routeReply');
  const getChannelActivity = await hostExport('getChannelActivity');
  const channelsHandlers = await hostExport('channelsHandlers');
  const { xmppPlugin } = await import('../dist/src/channel.js');
  const { setXmppRuntime } = await import('../dist/src/runtime.js');
  const { xml } = await import('../dist/src/xmpp.js');
  const { trackMucOccupantIdentity } = await import('../dist/src/muc-identity.js');
  const reply = await import(pathToFileURL(join(host, 'dist/plugin-sdk/reply-runtime.js')));

  for (const group of [false, true])
    for (const mode of ['callback', 'routed', 'suppressed', 'failed']) {
      await test(`${version}: ${group ? 'MUC' : 'DM'} ${mode}`, { timeout: 30_000 }, async () => {
        const room = 'room@conference.example.com';
        const peer = group ? room : 'user@example.com';
        const work = join(temporary, `${group}-${mode}`);
        await mkdir(work);
        const cfg = {
          channels: {
            xmpp: {
              jid: 'bot@example.com',
              password: 'fixture',
              allowFrom: ['user@example.com'],
              groups: [],
              sendReadReceipts: false,
            },
          },
          session: { store: join(work, 'sessions.json') },
          agents: { defaults: { workspace: work } },
        };
        // Keep room joining local while exercising the real MUC authorization path.
        const accountConfig = { ...cfg.channels.xmpp, groups: group ? [room] : [] };
        let gateway;
        const online = deferred();
        const runEnded = deferred();
        const queued = deferred();
        const started = deferred();
        const physical = deferred();
        const active = deferred();
        const bodyWrites = [];
        let callbacks = 0;
        let adapterCalls = 0;
        let routedResult;
        const xmpp = Object.assign(new EventEmitter(), {
          status: 'offline',
          options: { service: 'xmpp://example.com:5222', domain: 'example.com' },
          reconnect: { stop() {} },
          connect: async () => {},
          stop: async () => {},
          open: async () => {
            xmpp.status = 'online';
            xmpp.emit('online', { toString: () => 'bot@example.com/fixture' });
          },
          send: async (stanza) => {
            if (stanza.getChild('active', 'http://jabber.org/protocol/chatstates'))
              active.resolve();
            if (stanza.getChild('query', 'jabber:iq:roster'))
              queueMicrotask(() =>
                xmpp.emit(
                  'stanza',
                  xml(
                    'iq',
                    { type: 'result', id: stanza.attrs.id },
                    xml('query', { xmlns: 'jabber:iq:roster' })
                  )
                )
              );
            if (stanza.getChildText('body')?.trim()) {
              bodyWrites.push(stanza);
              started.resolve();
              await physical.promise;
            }
          },
        });
        makeClient = () => xmpp;
        const plugin = {
          ...xmppPlugin,
          outbound: {
            ...xmppPlugin.outbound,
            sendText: async (params) => {
              adapterCalls++;
              return xmppPlugin.outbound.sendText(params);
            },
          },
          gateway: {
            startAccount: async (ctx) => {
              gateway = ctx;
              return xmppPlugin.gateway.startAccount({
                ...ctx,
                setStatus: (patch) => {
                  ctx.setStatus(patch);
                  if (patch.connected) online.resolve();
                  if (patch.activeRuns === 0 && ctx.getStatus().lastInboundAt) runEnded.resolve();
                },
              });
            },
          },
        };
        const registry = createEmptyPluginRegistry();
        registry.channels.push({ pluginId: 'xmpp', plugin, source: 'fixture' });
        setActivePluginRegistry(registry);
        const manager = createChannelManager({
          getRuntimeConfig: () => cfg,
          getPluginRegistry: () => registry,
          channelLogs: {},
          channelRuntimeEnvs: {},
        });
        setXmppRuntime({
          channel: {
            routing: {
              resolveAgentRoute: () => ({
                agentId: 'main',
                accountId: 'default',
                sessionKey: `agent:main:xmpp:${group ? 'group' : 'direct'}:${peer}`,
                mainSessionKey: 'agent:main:main',
              }),
            },
            session: {
              resolveStorePath: () => cfg.session.store,
              recordInboundSession: async () => {},
            },
            reply: {
              finalizeInboundContext: reply.finalizeInboundContext,
              dispatchReplyWithBufferedBlockDispatcher: (params) =>
                reply.dispatchReplyWithBufferedBlockDispatcher({
                  ...params,
                  // Model a source turn whose visible reply is owned by routed
                  // delivery. Direct chats otherwise replace NO_REPLY with a
                  // fallback, creating an unrelated second callback delivery.
                  replyOptions:
                    mode === 'callback'
                      ? undefined
                      : {
                          sourceReplyDeliveryMode: 'message_tool_only',
                        },
                  dispatcherOptions: {
                    ...params.dispatcherOptions,
                    deliver: async (...args) => {
                      callbacks++;
                      const result = await params.dispatcherOptions.deliver(...args);
                      queued.resolve();
                      return result;
                    },
                  },
                  replyResolver: async () => {
                    if (mode === 'routed' || mode === 'failed') {
                      routedResult = await routeReply({
                        cfg,
                        channel: 'xmpp',
                        to: peer,
                        accountId: 'default',
                        payload: { text: 'D3-OK' },
                        mirror: false,
                      });
                      return { text: 'NO_REPLY' };
                    }
                    return { text: mode === 'suppressed' ? 'NO_REPLY' : 'D3-OK' };
                  },
                }),
            },
          },
        });
        mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10_000 });
        try {
          await manager.startChannel('xmpp');
          await online.promise;
          // The monitor captured this object; adding the room after startup avoids
          // simulating a room join, without bypassing authorization of the message.
          Object.assign(gateway.account.config, accountConfig);
          if (group)
            trackMucOccupantIdentity(
              xml(
                'presence',
                { from: `${room}/user` },
                xml(
                  'x',
                  { xmlns: 'http://jabber.org/protocol/muc#user' },
                  xml('item', { jid: 'user@example.com/mobile' })
                )
              ),
              'default'
            );
          xmpp.emit(
            'stanza',
            xml(
              'message',
              {
                from: group ? `${room}/user` : 'user@example.com/mobile',
                to: 'bot@example.com',
                type: group ? 'groupchat' : 'chat',
                id: `fixture-${group}-${mode}`,
              },
              xml('body', {}, 'hello')
            )
          );
          if (mode === 'callback') {
            await queued.promise;
            await runEnded.promise;
            assert.equal(gateway.getStatus().busy, false);
            mock.timers.tick(500);
          }
          if (mode !== 'suppressed') {
            await started.promise;
            assert.equal(gateway.getStatus().lastOutboundAt ?? null, null);
            mock.timers.setTime(11_000);
            if (mode === 'failed') physical.reject(new Error('fixture physical failure'));
            else physical.resolve();
            if (mode === 'callback') await active.promise;
          }
          await runEnded.promise;
          const runtime = manager.getRuntimeSnapshot().channelAccounts.xmpp.default;
          let statusReply;
          await channelsHandlers['channels.status']({
            params: { channel: 'xmpp' },
            context: { ...manager, getRuntimeConfig: () => cfg, getPluginRegistry: () => registry },
            respond: (ok, payload, error) => {
              assert.equal(ok, true, JSON.stringify(error));
              statusReply = payload;
            },
          });
          const snapshot = statusReply.channelAccounts.xmpp.find(
            (account) => account.accountId === 'default'
          );
          const visible = mode === 'callback' || mode === 'routed';
          assert.equal(snapshot.lastInboundAt, 10_000);
          assert.equal(snapshot.lastOutboundAt, visible ? 11_000 : null);
          assert.equal(runtime.activeRuns, 0);
          assert.equal(runtime.busy, false);
          assert.equal(snapshot.lastError, mode === 'failed' ? 'fixture physical failure' : null);
          assert.equal(bodyWrites.length, mode === 'suppressed' ? 0 : 1);
          assert.equal(callbacks, mode === 'callback' ? 1 : 0);
          assert.equal(adapterCalls, mode === 'routed' || mode === 'failed' ? 1 : 0);
          if (routedResult) assert.equal(routedResult.delivered, mode === 'routed');
          // channels.status only falls back to this host store when snapshot is null.
          // Routed delivery does not populate it: the plugin must publish the timestamp.
          assert.equal(
            getChannelActivity({ channel: 'xmpp', accountId: 'default' }).outboundAt,
            null
          );
          await manager.stopChannel('xmpp');
          const stopped = manager.getRuntimeSnapshot();
          gateway.setStatus({ accountId: 'default', lastOutboundAt: 999_999 });
          assert.deepEqual(
            manager.getRuntimeSnapshot(),
            stopped,
            'Gateway must reject a retired task patch'
          );
        } finally {
          physical.resolve();
          await manager.stopChannel('xmpp');
          mock.timers.reset();
        }
      });
    }
} finally {
  hooks.deregister();
  delete globalThis[Symbol.for('xmpp.d3.test.client')];
  await rm(temporary, { recursive: true, force: true });
}
