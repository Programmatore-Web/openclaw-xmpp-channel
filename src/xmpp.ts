import { createRequire } from 'node:module';
import { assertXmppRuntimeCompatible } from './xmpp-runtime-compat.js';

const require = createRequire(import.meta.url);
let runtime: typeof import('@xmpp/client') | undefined;

function loadRuntime(): typeof import('@xmpp/client') {
  // Validate before loading the native module graph, so an incompatible deep
  // export cannot preempt our actionable error with a path-bearing loader error.
  // Supported Node engines can require this synchronous ESM family. Keeping
  // this synchronous also preserves OpenClaw's native/Jiti plugin loading.
  assertXmppRuntimeCompatible();
  runtime ??= require('@xmpp/client') as typeof import('@xmpp/client');
  return runtime;
}

export const client: typeof import('@xmpp/client').client = (...args) =>
  loadRuntime().client(...args);
export const xml: typeof import('@xmpp/client').xml = (...args) => loadRuntime().xml(...args);
