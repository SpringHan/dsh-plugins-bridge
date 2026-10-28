import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCatalog,
  endpointOfDescriptor,
  findEndpoint,
  groupEndpoints,
  hasEndpoints,
  jsonSchemaOf,
  packageOfDescriptor,
  projectEndpoint,
  summarizeEndpoint,
} from '../lib/catalog.js';

/** A representative generated descriptor. */
function descriptor(overrides = {}) {
  return {
    id: '@scope/plugin#things/list',
    namespace: 'things',
    method: 'list',
    service: 'things',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      {
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
        acceptsUndefined: true,
        codec: { mode: 'strict', strictCodec: { jsonSchema: { type: 'string' } } },
        description: 'receiving agent',
      },
      {
        name: 'limit',
        wire: 'limit',
        source: 'json',
        codec: { mode: 'strict', jsonSchema: { type: 'integer' } },
      },
    ],
    result: { mode: 'strict', description: 'rows', strictCodec: { jsonSchema: { type: 'array' } } },
    ...overrides,
  };
}

test('package and endpoint identity come from the generated id', () => {
  const value = descriptor();
  assert.equal(packageOfDescriptor(value), '@scope/plugin');
  assert.equal(endpointOfDescriptor(value), 'things/list');
  assert.equal(packageOfDescriptor({ id: 'no-package' }), undefined);
});

test('jsonSchemaOf prefers the strict projection', () => {
  assert.deepEqual(jsonSchemaOf({ jsonSchema: { type: 'string' } }), { type: 'string' });
  assert.deepEqual(
    jsonSchemaOf({ jsonSchema: { type: 'string' }, strictCodec: { jsonSchema: { type: 'integer' } } }),
    { type: 'integer' },
  );
  assert.equal(jsonSchemaOf(undefined), null);
});

test('projectEndpoint exposes parameters, schemas, and agent scope', () => {
  const endpoint = projectEndpoint(descriptor());
  assert.equal(endpoint.package, '@scope/plugin');
  assert.equal(endpoint.endpoint, 'things/list');
  assert.equal(endpoint.kind, 'unary');
  assert.equal(endpoint.requiresAgent, 'agentId');
  assert.equal(endpoint.parameters[0].required, false);
  assert.equal(endpoint.parameters[1].required, true);
  assert.deepEqual(endpoint.parameters[1].schema, { type: 'integer' });
  assert.equal(endpoint.result.description, 'rows');
  assert.deepEqual(endpoint.result.schema, { type: 'array' });
});

test('stream endpoints are marked and agent scope is absent without one', () => {
  const endpoint = projectEndpoint(descriptor({ id: '@scope/plugin#things/watch', method: 'watch', mode: 'stream', scope: undefined }));
  assert.equal(endpoint.kind, 'stream');
  assert.equal(endpoint.requiresAgent, null);
});

test('summarizeEndpoint caps long descriptions', () => {
  const summary = summarizeEndpoint({
    endpoint: 'a/b',
    namespace: 'a',
    method: 'b',
    kind: 'unary',
    requiresAgent: null,
    description: 'x'.repeat(500),
  });
  assert.equal(summary.endpoint, 'a/b');
  assert.ok(summary.description.length <= 280);
  assert.ok(summary.description.endsWith('…'));
});

test('groupEndpoints groups, sorts, and ignores non-generated descriptors', () => {
  const grouped = groupEndpoints([
    descriptor({ id: '@scope/plugin#things/update', method: 'update' }),
    descriptor(),
    { id: 'no-package', namespace: 'x', method: 'y' },
  ]);
  assert.deepEqual([...grouped.keys()], ['@scope/plugin']);
  assert.deepEqual(grouped.get('@scope/plugin').map((entry) => entry.endpoint), ['things/list', 'things/update']);
});

test('buildCatalog merges Loader rows and API-only packages', () => {
  const catalog = buildCatalog(
    [
      {
        package: '@scope/plugin',
        moduleName: '@scope/plugin',
        entryId: 'plugin',
        phase: 'active',
        enabled: true,
        title: 'Things',
        description: 'Thing APIs',
        version: '1.2.3',
      },
      {
        package: 'no-api',
        moduleName: 'no-api',
        entryId: 'no-api',
        phase: 'failed',
        enabled: true,
      },
    ],
    [descriptor()],
  );
  assert.equal(catalog.length, 2);
  const plugin = catalog.find((row) => row.package === '@scope/plugin');
  assert.equal(plugin.title, 'Things');
  assert.equal(plugin.description, 'Thing APIs');
  assert.equal(plugin.version, '1.2.3');
  assert.equal(plugin.phase, 'active');
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.entries.length, 1);
  assert.equal(plugin.endpoints.length, 1);
  assert.equal(hasEndpoints(plugin), true);

  const noApi = catalog.find((row) => row.package === 'no-api');
  assert.equal(hasEndpoints(noApi), false);
  assert.equal(noApi.phase, 'failed');
});

test('buildCatalog surfaces API packages with no Loader row in this tree', () => {
  const catalog = buildCatalog([], [descriptor()]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].package, '@scope/plugin');
  assert.equal(catalog[0].title, '@scope/plugin');
  assert.equal(catalog[0].enabled, true);
  assert.deepEqual(catalog[0].entries, []);
  assert.equal(catalog[0].endpoints.length, 1);
});

test('buildCatalog merges several Loader rows of one package', () => {
  const catalog = buildCatalog(
    [
      { package: 'pkg', moduleName: 'pkg', entryId: 'one', phase: 'pending', enabled: true },
      { package: 'pkg', moduleName: 'pkg/sub', entryId: 'two', phase: 'active', enabled: true, title: 'Package' },
    ],
    [],
  );
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].phase, 'active');
  assert.equal(catalog[0].title, 'Package');
  assert.equal(catalog[0].entries.length, 2);
});

test('findEndpoint validates the pair', () => {
  const catalog = buildCatalog([], [descriptor()]);
  assert.equal(findEndpoint(catalog, '@scope/plugin', 'things/list').endpoint, 'things/list');
  assert.equal(findEndpoint(catalog, '@scope/plugin', 'things/missing'), undefined);
  assert.equal(findEndpoint(catalog, 'other', 'things/list'), undefined);
});
