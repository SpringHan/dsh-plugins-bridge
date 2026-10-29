import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createDefaultConfig,
  generateToken,
  loadConfigSync,
  maskToken,
  normalizeConfig,
  profileFromBaseUrl,
  resolveConfigPath,
  saveConfigSync,
} from '../lib/config.js';

test('resolveConfigPath uses the active profile', () => {
  assert.equal(
    resolveConfigPath({ DSH_HOME: '/home/u/.dsh', DSH_PROFILE: 'web' }),
    '/home/u/.dsh/profiles/web/plugins-bridge.json',
  );
  assert.equal(
    resolveConfigPath({ DSH_HOME: '/home/u/.dsh' }),
    '/home/u/.dsh/plugins-bridge.json',
  );
  assert.equal(
    resolveConfigPath({ DSH_HOME: '/home/u/.dsh' }, 'web'),
    '/home/u/.dsh/profiles/web/plugins-bridge.json',
  );
  assert.equal(
    resolveConfigPath({ DSH_HOME: '/home/u/.dsh', DSH_PROFILE: 'env' }, 'hint'),
    '/home/u/.dsh/profiles/env/plugins-bridge.json',
  );
});

test('profileFromBaseUrl reads the profile root', () => {
  assert.equal(profileFromBaseUrl('file:///home/u/.dsh/profiles/web/'), 'web');
  assert.equal(profileFromBaseUrl('/home/u/.dsh/profiles/my%20profile/'), 'my profile');
  assert.equal(profileFromBaseUrl('file:///home/u/.dsh/'), undefined);
  assert.equal(profileFromBaseUrl(undefined), undefined);
});

test('normalizeConfig keeps valid fields and drops invalid packages', () => {
  const config = normalizeConfig({
    enabled: false,
    token: 'a'.repeat(32),
    exposeTools: true,
    exposedPackages: [
      '@scope/pkg',
      'plain',
      '@scope/pkg',
      '',
      'bad name',
      'x'.repeat(300),
      42,
      null,
    ],
    exposedRoutes: ['mcp-manager-plus', 'dsh-session-manager', 'mcp-manager-plus', '', 'bad route', 42],
    extra: 'ignored',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.exposeTools, true);
  assert.deepEqual(config.exposedPackages, ['@scope/pkg', 'plain']);
  assert.deepEqual(config.exposedRoutes, ['mcp-manager-plus', 'dsh-session-manager']);
  assert.equal(config.version, 1);
  assert.equal('extra' in config, false);
});

test('normalizeConfig defaults enabled on and tools off', () => {
  const config = normalizeConfig(null);
  assert.equal(config.enabled, true);
  assert.equal(config.exposeTools, false);
  assert.deepEqual(config.exposedPackages, []);
  assert.deepEqual(config.exposedRoutes, []);
  assert.equal(config.token, '');
});

test('a missing token is detected rather than fabricated by normalize', () => {
  assert.equal(normalizeConfig({ token: 'short' }).token, '');
  assert.equal(normalizeConfig({ token: generateToken() }).token.length, 48);
});

test('loadConfigSync returns a default for a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpb-config-'));
  const { config, exists, warning } = loadConfigSync(join(dir, 'absent.json'));
  assert.equal(exists, false);
  assert.equal(warning, undefined);
  assert.equal(config.enabled, true);
  assert.match(config.token, /^[0-9a-f]{48}$/u);
});

test('saveConfigSync round-trips atomically with a private mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpb-config-'));
  const file = join(dir, 'plugins-bridge.json');
  const saved = saveConfigSync(file, {
    enabled: true,
    token: 'b'.repeat(48),
    exposedPackages: ['@scope/pkg'],
    exposedRoutes: ['mcp-manager-plus'],
    exposeTools: true,
  });
  assert.equal(saved.token, 'b'.repeat(48));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(parsed.exposedPackages, ['@scope/pkg']);
  assert.deepEqual(parsed.exposedRoutes, ['mcp-manager-plus']);
  assert.equal(parsed.exposeTools, true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const loaded = loadConfigSync(file);
  assert.deepEqual(loaded.config, parsed);
  assert.equal(loaded.warning, undefined);
});

test('saveConfigSync provisions a token when one is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpb-config-'));
  const file = join(dir, 'plugins-bridge.json');
  const saved = saveConfigSync(file, { enabled: true, exposedPackages: [], exposedRoutes: [], exposeTools: false });
  assert.equal(saved.token.length, 48);
});

test('loadConfigSync survives corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpb-config-'));
  const file = join(dir, 'plugins-bridge.json');
  saveConfigSync(file, createDefaultConfig());
  // Corrupt it after writing.
  writeFileSync(file, '{ not json');
  const loaded = loadConfigSync(file);
  assert.equal(loaded.exists, true);
  assert.match(loaded.warning ?? '', /ignoring invalid config/u);
  assert.equal(loaded.config.enabled, true);
});

test('maskToken never exposes the full token', () => {
  assert.equal(maskToken(''), '');
  assert.equal(maskToken('short'), '…');
  const masked = maskToken('0123456789abcdef0123456789abcdef');
  assert.notEqual(masked, '0123456789abcdef0123456789abcdef');
  assert.match(masked, /^012345…cdef$/u);
});
