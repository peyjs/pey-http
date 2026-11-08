// Verifies the entry-point lifecycle wiring and the manifest contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepare } from '../index.js';

const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function createPrepareContext(overrides = {}) {
  const published = [];
  return {
    config: {},
    events: {
      publish: (type, data) => published.push({ type, data }),
      subscribe: () => () => {},
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: () => {},
    published,
    ...overrides,
  };
}

test('should_register_service_when_prepare_is_called', async () => {
  const context = createPrepareContext();

  const registrations = await prepare(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'pey.http.service');
  assert.equal(typeof registrations[0].object.getText, 'function');
});

test('should_assign_lifecycle_hooks_when_prepare_is_called', async () => {
  const context = createPrepareContext();

  await prepare(context);

  assert.equal(typeof context.onShutdown, 'function');
  assert.equal(typeof context.onDeactivated, 'function');
});

test('should_reject_startup_error_when_prepare_receives_no_fetch', async () => {
  const context = createPrepareContext();
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });

  try {
    await assert.rejects(
      prepare(context),
      (error) => error.code === 'HTTP_TRANSPORT_UNAVAILABLE' && error.type === 'startup',
    );
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true });
  }
});

test('should_pass_the_config_error_through_when_prepare_receives_an_unusable_timeout', async () => {
  // A structured startup error keeps its code and detail through prepare —
  // the host needs to know WHICH configuration key is broken, not just
  // that "the transport could not start".
  const context = createPrepareContext({ config: { timeoutMs: 'fast' } });

  await assert.rejects(
    prepare(context),
    (error) => error.code === 'HTTP_INPUT_INVALID'
      && error.type === 'startup'
      && error.detail?.value === 'fast',
  );
});

test('should_match_manifest_contract_when_loaded', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

  assert.equal(manifest.name, 'pey.http');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.type, 'transport');
  assert.equal(manifest.adapterType, undefined);
  assert.deepEqual(manifest.dependencies, { required: [], optional: [] });
  assert.equal(manifest.provides.length, 1);
  assert.equal(manifest.provides[0].name, 'pey.http.service');
  const methodNames = manifest.provides[0].methods.map((method) => method.name);
  assert.deepEqual(methodNames, ['request', 'stream', 'getText']);
  assert.deepEqual(manifest.events, []);
});
