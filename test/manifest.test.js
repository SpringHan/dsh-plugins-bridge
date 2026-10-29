import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('the manifest declares the bundle, client, and runtime exports', () => {
  assert.equal(manifest.name, 'dsh-plugins-bridge');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.exports['.'], './index.js');
  assert.deepEqual(manifest.exports['./client'], './client.js');
  assert.deepEqual(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.deepEqual(manifest.exports['./icon'], './icon.svg');
  assert.ok(Array.isArray(manifest.files));
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'LICENSE']) {
    assert.ok(manifest.files.includes(required), `files must include ${required}`);
  }
  assert.ok(manifest.files.includes('lib/**/*.js'));
  assert.ok(existsSync(join(root, 'lib/routes.js')), 'the route projector must be present');
});

test('the bundle patch mounts the package it belongs to', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^\s*- insert:/mu);
  assert.match(patch, /name:\s*dsh-plugins-bridge\b/u);
});

test('both locale files carry display metadata', () => {
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(read(`locale/${lang}.json`));
    assert.equal(typeof locale.meta.title, 'string', lang);
    assert.equal(typeof locale.meta.description, 'string', lang);
    assert.ok(locale.meta.title.length > 0, lang);
    assert.ok(locale.meta.description.length > 0, lang);
  }
});

test('the icon is a small, self-contained SVG', () => {
  const icon = read('icon.svg');
  assert.match(icon, /^<svg\b/u);
  assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(icon, /<\/svg>\s*$/u);
  assert.ok(statSync(join(root, 'icon.svg')).size < 256 * 1024);
  assert.doesNotMatch(icon, /<script|<image\b|href="https?:/iu);
});

test('the client half uses the lazy module protocol and the settings seat', () => {
  const client = read('client.js');
  assert.match(client, /window\.__ModuleLoader__\.load\(/u);
  assert.match(client, /id:\s*'dsh-plugins-bridge'/u);
  assert.match(client, /ctx\.slots\.inject\('settings\.section'/u);
  assert.match(client, /ctx\.slots\.register\(/u);
  assert.match(client, /exposedRoutes/u);
  assert.match(client, /routesTitle/u);
  assert.doesNotMatch(client, /@deepseek-ai\/dsh-client-ui-primitives/u);
});

test('the host half registers its prefix on the web server', () => {
  const host = read('index.js');
  assert.match(host, /ctx\.webServer\.register\(/u);
  assert.match(host, /kind:\s*'prefix'/u);
  assert.match(host, /path:\s*API_PREFIX/u);
});
