import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createRunStateMachine, loadRunStateMachine } from '../src/sdk-run-state.js';

const outbound = 'openclaw/plugin-sdk/channel-outbound';
const lifecycle = 'openclaw/plugin-sdk/channel-lifecycle';

describe('public SDK run-state selection', () => {
  it('exports the real installed SDK factory without a wrapper', () => {
    const require = createRequire(import.meta.url);
    const modern: Record<string, unknown> = require(outbound);
    const sdk: Record<string, unknown> =
      'createRunStateMachine' in modern ? modern : require(lifecycle);
    expect(createRunStateMachine).toBe(sdk.createRunStateMachine);
  });

  it('prefers the modern factory without loading the removed legacy subpath', () => {
    const load = vi.fn(() => ({ createRunStateMachine }));
    expect(loadRunStateMachine(load)).toBe(createRunStateMachine);
    expect(load.mock.calls).toEqual([[outbound]]);
  });

  it('uses the legacy public factory only when the modern export is absent', () => {
    const load = vi.fn((path: string) => (path === outbound ? {} : { createRunStateMachine }));
    expect(loadRunStateMachine(load)).toBe(createRunStateMachine);
    expect(load.mock.calls).toEqual([[outbound], [lifecycle]]);
  });

  it.each(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND', 'unexpected initialization'])(
    'propagates a modern load error (%s) without falling back',
    (code) => {
      const error = Object.assign(new Error(code), { code });
      const load = vi.fn(() => {
        throw error;
      });
      expect(() => loadRunStateMachine(load)).toThrow(error);
      expect(load.mock.calls).toEqual([[outbound]]);
    }
  );

  it.each([undefined, null, false, 42, {}])('rejects an invalid modern export: %s', (value) => {
    const load = vi.fn(() => ({ createRunStateMachine: value }));
    expect(() => loadRunStateMachine(load)).toThrow(
      'Invalid OpenClaw createRunStateMachine export'
    );
    expect(load.mock.calls).toEqual([[outbound]]);
  });

  it('propagates legacy load errors and rejects a missing legacy factory', () => {
    const error = new Error('legacy initialization failed');
    expect(() =>
      loadRunStateMachine((path) => {
        if (path === outbound) return {};
        throw error;
      })
    ).toThrow(error);
    expect(() => loadRunStateMachine(() => ({}))).toThrow(
      'OpenClaw SDK does not export createRunStateMachine'
    );
  });
});
