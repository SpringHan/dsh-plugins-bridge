import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRouteGroups,
  collectRoutes,
  findRoute,
  isThirdPartyPackage,
  routeSegment,
} from '../lib/routes.js';

/** Minimal route table pair. */
function webServer(routes) {
  const exact = new Map();
  const prefixes = new Map();
  for (const route of routes) {
    (route.kind === 'exact' ? exact : prefixes).set(route.path, { ...route, handler: () => {} });
  }
  return { exact, prefixes };
}

test('routeSegment reads the first path segment', () => {
  assert.equal(routeSegment('/mcp-manager-plus'), 'mcp-manager-plus');
  assert.equal(routeSegment('/dsh-whale/balance.json'), 'dsh-whale');
  assert.equal(routeSegment('/'), undefined);
  assert.equal(routeSegment('relative'), undefined);
  assert.equal(routeSegment(42), undefined);
});

test('isThirdPartyPackage separates shipped, builtin, own, and user packages', () => {
  assert.equal(isThirdPartyPackage('dsh-session-manager'), true);
  assert.equal(isThirdPartyPackage('@scope/plugin'), true);
  assert.equal(isThirdPartyPackage('@deepseek-ai/dsh-tools'), false);
  assert.equal(isThirdPartyPackage('cordis:include'), false);
  assert.equal(isThirdPartyPackage('dsh-plugins-bridge'), false);
  assert.equal(isThirdPartyPackage(''), false);
});

test('collectRoutes reads both tables without duplicates', () => {
  const server = webServer([
    { kind: 'exact', path: '/a' },
    { kind: 'prefix', path: '/b' },
    { kind: 'exact', path: '/c' },
  ]);
  assert.deepEqual(collectRoutes(server), [
    { kind: 'exact', path: '/a' },
    { kind: 'prefix', path: '/b' },
    { kind: 'exact', path: '/c' },
  ]);
});

test('collectRoutes tolerates missing or renamed tables', () => {
  assert.deepEqual(collectRoutes({}), []);
  assert.deepEqual(collectRoutes({ exact: new Map([['x', null]]) }), []);
});

test('findRoute prefers exact over the longest prefix', () => {
  const server = webServer([
    { kind: 'prefix', path: '/a' },
    { kind: 'prefix', path: '/a/b' },
    { kind: 'exact', path: '/a/b/c' },
  ]);
  assert.equal(findRoute(server, '/a/b/c').path, '/a/b/c');
  assert.equal(findRoute(server, '/a/b/d').path, '/a/b');
  assert.equal(findRoute(server, '/a/z').path, '/a');
  assert.equal(findRoute(server, '/nope'), undefined);
  assert.equal(findRoute(server, '/a/bc').path, '/a');
});

test('buildRouteGroups attributes route groups to packages', () => {
  const routes = [
    { kind: 'exact', path: '/dsh-session-manager/stats' },
    { kind: 'prefix', path: '/mcp-manager-plus' },
    { kind: 'exact', path: '/dsh-whale/balance.json' },
    { kind: 'exact', path: '/plugins-bridge/api/state' },
    { kind: 'prefix', path: '/api' },
  ];
  const packages = [
    { package: 'dsh-session-manager', title: 'Session Manager' },
    { package: 'dsh-mcp-manager-plus', title: 'MCP Manager' },
    { package: 'dsh-whale-widget', title: 'Whale' },
    { package: '@deepseek-ai/dsh-api-gateway', title: 'Gateway' },
  ];
  const groups = buildRouteGroups(routes, packages, ['mcp-manager-plus']);
  assert.deepEqual(groups.map((group) => group.id), [
    'mcp-manager-plus',
    'dsh-session-manager',
    'dsh-whale',
    'api',
  ]);
  const mcp = groups.find((group) => group.id === 'mcp-manager-plus');
  assert.equal(mcp.package, 'dsh-mcp-manager-plus');
  assert.equal(mcp.thirdParty, true);
  assert.equal(mcp.system, false);
  assert.equal(mcp.selected, true);
  assert.deepEqual(mcp.kinds, ['prefix']);
  assert.deepEqual(mcp.paths, ['/mcp-manager-plus']);

  const whale = groups.find((group) => group.id === 'dsh-whale');
  assert.equal(whale.package, 'dsh-whale-widget');
  assert.equal(whale.thirdParty, true);

  const api = groups.find((group) => group.id === 'api');
  assert.equal(api.system, true);
  assert.equal(api.thirdParty, false);
  assert.equal(api.selected, false);
});

test('buildRouteGroups excludes the bridge route and the root', () => {
  const groups = buildRouteGroups(
    [
      { kind: 'prefix', path: '/plugins-bridge' },
      { kind: 'exact', path: '/' },
      { kind: 'exact', path: '/other' },
    ],
    [],
    [],
  );
  assert.deepEqual(groups.map((group) => group.id), ['other']);
});

test('buildRouteGroups keeps unmatched groups as system groups', () => {
  const groups = buildRouteGroups([{ kind: 'exact', path: '/mystery/tool' }], [], []);
  assert.equal(groups[0].id, 'mystery');
  assert.equal(groups[0].package, null);
  assert.equal(groups[0].thirdParty, false);
  assert.equal(groups[0].system, true);
});
