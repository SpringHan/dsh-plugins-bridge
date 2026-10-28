import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The plugin reads DSH_HOME/DSH_PROFILE when it activates, not at import time.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpb-host-'));
process.env.DSH_PROFILE = 'test';

const { apply } = await import('../index.js');

/** Each fake host gets its own profile so config never leaks between tests. */
let profileCounter = 0;

/** Build the smallest context the bridge actually touches. */
function fakeHost(options = {}) {
  if (options.profileEnv === null) delete process.env.DSH_PROFILE;
  else {
    profileCounter += 1;
    process.env.DSH_PROFILE = options.profileEnv ?? `test-${profileCounter}`;
  }
  const descriptors = new Map();
  const calls = [];
  const peers = [];
  const routes = [];
  const add = (descriptor) => descriptors.set(descriptor.id.slice(descriptor.id.indexOf('#') + 1), descriptor);

  add({
    id: '@scope/plugin#things/list',
    namespace: 'things',
    method: 'list',
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      {
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
        acceptsUndefined: true,
        codec: { mode: 'strict', strictCodec: { jsonSchema: { type: 'string' } } },
      },
      {
        name: 'limit',
        wire: 'limit',
        source: 'json',
        codec: { mode: 'strict', jsonSchema: { type: 'integer' } },
      },
    ],
    result: { mode: 'strict', strictCodec: { jsonSchema: { type: 'object' } } },
  });
  add({
    id: '@scope/plugin#things/watch',
    namespace: 'things',
    method: 'watch',
    mode: 'stream',
    parameters: [],
    result: { mode: 'strict', strictCodec: { jsonSchema: { type: 'string' } } },
  });
  add({
    id: '@scope/other#other/ping',
    namespace: 'other',
    method: 'ping',
    parameters: [],
    result: { mode: 'strict', strictCodec: { jsonSchema: { type: 'string' } } },
  });

  const entry = (id, name, phase = 'active') => ({
    id,
    options: { id, name },
    ctx: { baseUrl: 'file:///tmp/' },
    fiber: { state: phase },
    disabled: false,
  });

  const ctx = {
    baseUrl: options.baseUrl ?? 'file:///tmp/',
    logger: { info() {}, warn() {} },
    effect(fn) {
      return fn();
    },
    inject(_names, callback) {
      callback(ctx);
      return () => {};
    },
    get() {
      return undefined;
    },
    webServer: {
      port: 3080,
      register(route) {
        routes.push(route);
        return () => {};
      },
      getOrigin() {
        return 'http://127.0.0.1:3080';
      },
    },
    typert: {
      local: {
        list: () => [...descriptors.values()],
        get: (endpoint) => descriptors.get(endpoint),
      },
    },
    typertGateway: {
      async invoke(request) {
        calls.push(request);
        if (request.args.limit === 99) {
          const failure = new Error('limit is not usable');
          failure.code = 'gateway/arguments-invalid';
          throw failure;
        }
        return { rows: [{ id: request.args.limit ?? 0 }], peer: request.peer.principal.kind };
      },
    },
    connection: {
      requestRejection() {
        return options.managementRejection;
      },
      createPeer(options) {
        const peer = { principal: options.principal, async dispose() {} };
        peers.push(peer);
        return peer;
      },
    },
    loader: {
      entries: function* () {
        yield entry('plugin', '@scope/plugin');
        yield entry('other', '@scope/other');
        yield { options: { group: true }, ctx: {}, fiber: { state: 'active' } };
      },
    },
    tools: {
      schemas: () => [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      get: (name) => (name === 'read' ? { name } : undefined),
      async execute(input) {
        calls.push({ tool: input.name, args: input.arguments, agent: input.agent?.id });
        return { isError: false, value: { content: 'hello' }, content: [{ type: 'text', text: 'hello' }] };
      },
    },
    agents: {
      list: () => [{ id: 'session-1', status: 'inactive', session: { header: { cwd: '/tmp' } } }],
      get: (id) => (id === 'session-1' ? { id: 'session-1', status: 'inactive', session: { header: { cwd: '/tmp' } } } : undefined),
    },
  };
  apply(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/plugins-bridge');
  assert.equal(routes[0].kind, 'prefix');
  return { handler: routes[0].handler, calls, peers, descriptors };
}

/** A stand-in IncomingMessage with an optionally scheduled body. */
function request({ method = 'GET', url = '/plugins-bridge/api/state', headers = {}, body, address = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: address };
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

/** A stand-in ServerResponse that captures the written JSON. */
function response() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.body += body ?? '';
      res.writableEnded = true;
    },
  };
  return res;
}

/** Run one request through the registered route and decode the response. */
async function call(handler, options) {
  const req = request(options);
  const res = response();
  await handler(req, res);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, body: res.body };
}

test('management state lists live descriptor packages', async () => {
  const { handler } = fakeHost();
  const result = await call(handler, {});
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.plugins.length, 2);
  const plugin = result.json.plugins.find((row) => row.package === '@scope/plugin');
  assert.equal(plugin.endpointCount, 2);
  assert.equal(plugin.streamCount, 1);
  assert.equal(plugin.selected, false);
  assert.equal(plugin.endpoints.find((endpoint) => endpoint.endpoint === 'things/list').requiresAgent, 'agentId');
  assert.equal(result.json.plugins.find((row) => row.package === '@scope/other').endpointCount, 1);
  assert.match(result.json.token, /^[0-9a-f]{48}$/u);
  assert.match(result.json.baseUrl, /\/plugins-bridge\/v1$/u);
  assert.equal(result.json.stats.apiPackages, 2);
});

test('a corrupt config file is replaced by a valid default', async () => {
  const profile = `test-corrupt-${Date.now()}`;
  const dir = join(process.env.DSH_HOME, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugins-bridge.json'), '{ not json');
  const { handler } = fakeHost({ profileEnv: profile });
  const result = await call(handler, {});
  assert.equal(result.status, 200);
  assert.equal(result.json.enabled, true);
  const saved = JSON.parse(readFileSync(join(dir, 'plugins-bridge.json'), 'utf8'));
  assert.match(saved.token, /^[0-9a-f]{48}$/u);
});

test('profile is inferred from the Loader base URL when DSH_PROFILE is absent', async () => {
  const { handler } = fakeHost({
    profileEnv: null,
    baseUrl: 'file:///tmp/fake-home/.dsh/profiles/web/',
  });
  const result = await call(handler, {});
  assert.equal(result.json.profile, 'web');
  assert.match(result.json.configPath, /\/profiles\/web\/plugins-bridge\.json$/u);
});

test('management routes require the authenticated DSH browser session', async () => {
  const { handler } = fakeHost({ managementRejection: 401 });
  const denied = await call(handler, {});
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error.code, 'unauthorized');
});

test('non-loopback requests are refused before routing', async () => {
  const { handler } = fakeHost();
  const result = await call(handler, { address: '192.168.1.9' });
  assert.equal(result.status, 403);
  assert.equal(result.json.error.code, 'loopback-only');
});

test('health is public, data routes require the token', async () => {
  const { handler } = fakeHost();
  const health = await call(handler, { url: '/plugins-bridge/v1/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.enabled, true);

  const denied = await call(handler, { url: '/plugins-bridge/v1/plugins' });
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error.code, 'unauthorized');
  assert.match(denied.headers['www-authenticate'], /Bearer/u);
});

test('management config exposes a package and external calls reach the gateway', async () => {
  const { handler, calls } = fakeHost();
  const initial = await call(handler, {});
  const token = initial.json.token;

  const saved = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposedPackages: ['@scope/plugin'] }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.exposedPackages, ['@scope/plugin']);

  const listed = await call(handler, {
    url: '/plugins-bridge/v1/plugins',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.plugins.map((row) => row.package), ['@scope/plugin']);

  const invoked = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ package: '@scope/plugin', endpoint: 'things/list', args: { limit: 3 } }),
  });
  assert.equal(invoked.status, 200);
  assert.deepEqual(invoked.json.result.rows, [{ id: 3 }]);
  assert.equal(invoked.json.result.peer, 'owner');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'things');
  assert.equal(calls[0].method, 'list');
  assert.deepEqual(calls[0].args, { limit: 3 });
});

test('unexposed packages, streams, and unknown endpoints are rejected', async () => {
  const { handler } = fakeHost();
  const initial = await call(handler, {});
  const token = initial.json.token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const unexposed = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers,
    body: JSON.stringify({ package: '@scope/plugin', endpoint: 'things/list', args: {} }),
  });
  assert.equal(unexposed.status, 403);
  assert.equal(unexposed.json.error.code, 'package-not-exposed');

  await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposedPackages: ['@scope/plugin'] }),
  });

  const stream = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers,
    body: JSON.stringify({ package: '@scope/plugin', endpoint: 'things/watch', args: {} }),
  });
  assert.equal(stream.status, 501);
  assert.equal(stream.json.error.code, 'stream-unsupported');

  const unknown = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers,
    body: JSON.stringify({ package: '@scope/plugin', endpoint: 'things/nope', args: {} }),
  });
  assert.equal(unknown.status, 404);
});

test('gateway validation failures keep their status class', async () => {
  const { handler } = fakeHost();
  const initial = await call(handler, {});
  const token = initial.json.token;
  await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposedPackages: ['@scope/plugin'] }),
  });
  const result = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ package: '@scope/plugin', endpoint: 'things/list', args: { limit: 99 } }),
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.error.code, 'gateway/arguments-invalid');
});

test('a unique exposed endpoint may omit its package', async () => {
  const { handler } = fakeHost();
  const initial = await call(handler, {});
  const token = initial.json.token;
  await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposedPackages: ['@scope/plugin'] }),
  });
  const result = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/invoke',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'things/list', args: {} }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.package, '@scope/plugin');
});

test('management writes reject cross-origin browsers and non-JSON bodies', async () => {
  const { handler } = fakeHost();
  const cross = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: '127.0.0.1:3080' },
    body: '{}',
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'cross-origin');

  const wrongType = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
});

test('agent tools stay closed until enabled, then execute', async () => {
  const { handler, calls } = fakeHost();
  const initial = await call(handler, {});
  const token = initial.json.token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const denied = await call(handler, { url: '/plugins-bridge/v1/tools', headers });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'tools-not-exposed');

  await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/api/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeTools: true }),
  });

  const listed = await call(handler, { url: '/plugins-bridge/v1/tools', headers });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.tools.map((tool) => tool.name), ['read']);

  const invoked = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/tools/invoke',
    headers,
    body: JSON.stringify({ name: 'read', arguments: { path: '/tmp/x' }, agentId: 'session-1' }),
  });
  assert.equal(invoked.status, 200);
  assert.equal(invoked.json.ok, true);
  assert.deepEqual(invoked.json.value, { content: 'hello' });
  assert.deepEqual(calls.at(-1), { tool: 'read', args: { path: '/tmp/x' }, agent: 'session-1' });

  const unknownAgent = await call(handler, {
    method: 'POST',
    url: '/plugins-bridge/v1/tools/invoke',
    headers,
    body: JSON.stringify({ name: 'read', arguments: {}, agentId: 'missing' }),
  });
  assert.equal(unknownAgent.status, 404);
  assert.equal(unknownAgent.json.error.code, 'unknown-agent');
});

test('method mismatches and unknown routes answer 405 and 404', async () => {
  const { handler } = fakeHost();
  const mismatch = await call(handler, { method: 'POST', url: '/plugins-bridge/api/state', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(mismatch.status, 405);
  assert.equal(mismatch.headers.allow, 'GET');

  const missing = await call(handler, { url: '/plugins-bridge/api/nope' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not-found');
});

test('management detail returns full parameter schemas', async () => {
  const { handler } = fakeHost();
  const detail = await call(handler, {
    url: '/plugins-bridge/api/plugin?package=' + encodeURIComponent('@scope/plugin'),
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.package, '@scope/plugin');
  const endpoint = detail.json.endpoints.find((entry) => entry.endpoint === 'things/list');
  assert.equal(endpoint.parameters[1].wire, 'limit');
  assert.deepEqual(endpoint.parameters[1].schema, { type: 'integer' });
  assert.deepEqual(endpoint.result.schema, { type: 'object' });
});
