import { createRequire } from 'node:module';
import * as outboundSdk from 'openclaw/plugin-sdk/channel-outbound';

/** Common public SDK contract, checked against each characterized host. */
export interface RunStateMachineParams {
  setStatus?: (patch: {
    busy?: boolean;
    activeRuns?: number;
    lastRunActivityAt?: number | null;
    activeRunStartedAt?: number | null;
  }) => void;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
}

export interface RunStateMachine {
  isActive(): boolean;
  onRunStart(): void;
  onRunEnd(): void;
  deactivate(): void;
}

export type RunStateMachineFactory = (params: RunStateMachineParams) => RunStateMachine;

function hasFactory(value: unknown): value is { createRunStateMachine: RunStateMachineFactory } {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Invalid OpenClaw run-state SDK module');
  }
  if (!('createRunStateMachine' in value)) {
    return false;
  }
  if (typeof value.createRunStateMachine !== 'function') {
    throw new TypeError('Invalid OpenClaw createRunStateMachine export');
  }
  // The public function signature is verified by real-host contract checks;
  // this boundary checks its presence without invoking or wrapping the factory.
  return true;
}

/** Synchronous selection; module-load errors and invalid exports propagate. */
export function loadRunStateMachine(load: (specifier: string) => unknown): RunStateMachineFactory {
  const outbound = load('openclaw/plugin-sdk/channel-outbound');
  if (hasFactory(outbound)) {
    return outbound.createRunStateMachine;
  }
  // Older hosts export the same contract from this public subpath only.
  const lifecycle = load('openclaw/plugin-sdk/channel-lifecycle');
  if (hasFactory(lifecycle)) {
    return lifecycle.createRunStateMachine;
  }
  throw new Error('OpenClaw SDK does not export createRunStateMachine');
}

const requireSdk = createRequire(import.meta.url);

// Keep the common module in the ESM graph. Only the optional legacy subpath
// needs require; requiring the entire outbound graph slows ESM-based loaders.
export const createRunStateMachine: RunStateMachineFactory = loadRunStateMachine((specifier) =>
  specifier === 'openclaw/plugin-sdk/channel-outbound' ? outboundSdk : requireSdk(specifier)
);
