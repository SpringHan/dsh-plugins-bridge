/**
 * Durable bridge configuration.
 *
 * The file lives beside the active DSH profile so one profile's token and
 * allowlist never leak into another profile:
 *
 *   $DSH_HOME/profiles/<DSH_PROFILE>/plugins-bridge.json
 *
 * without a profile it falls back to `$DSH_HOME/plugins-bridge.json`. The file
 * contains a secret (the bearer token), so it is written with mode 0600.
 *
 * This module is intentionally free of Harness imports: the host plugin loads
 * it in-process, and the unit tests load it directly with Node.
 *
 * @module dsh-plugins-bridge/config
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Current on-disk shape. */
export const CONFIG_VERSION = 1;

/** Package names accepted in the allowlist. Deliberately permissive but bounded. */
const PACKAGE_NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
/** Bearer tokens are generated hex; this also bounds hand-edited values. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/u;
/** Guard against an accidentally huge hand-edited allowlist. */
const MAX_PACKAGES = 500;
/** Maximum route groups one file may expose. */
const MAX_ROUTE_GROUPS = 200;
/** Route-group ids are path segments, not arbitrary URLs. */
const ROUTE_GROUP_RE = /^[^\s/?#\u0000-\u001f\u007f]{1,128}$/u;
/** Longest package specifier npm accepts. */
const MAX_PACKAGE_LENGTH = 214;

/**
 * Resolve the config path for an environment.
 * @param env - process environment (or a test double).
 * @param profileHint - profile name inferred from the Loader base URL when the
 *   process does not export `DSH_PROFILE` (the Web server process commonly
 *   does not).
 * @returns absolute path of the JSON config file.
 */
export function resolveConfigPath(env = process.env, profileHint) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh');
  const fromEnv = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== ''
    ? env.DSH_PROFILE
    : undefined;
  const profile = fromEnv ?? (typeof profileHint === 'string' && profileHint !== '' ? profileHint : undefined);
  return profile === undefined
    ? join(home, 'plugins-bridge.json')
    : join(home, 'profiles', profile, 'plugins-bridge.json');
}

/**
 * Infer a profile name from a Loader base URL.
 *
 * The profile root `cordis.yml` anchors the Loader's `baseUrl` at the profile
 * directory (`.../profiles/<name>/`), which is the only profile hint available
 * in a Web process that was not launched with `DSH_PROFILE` exported.
 *
 * @param baseUrl - `ctx.baseUrl` / `ctx.loader.ctx.baseUrl`.
 * @returns profile name, or undefined outside a profile.
 */
export function profileFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined;
  let pathname = baseUrl;
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    // A plain filesystem path is acceptable too.
  }
  const match = /\/profiles\/([^/]+)\/?$/u.exec(pathname);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** A fresh token: 24 random bytes rendered as 48 URL-safe hex characters. */
export function generateToken() {
  return randomBytes(24).toString('hex');
}

/**
 * A complete default configuration.
 * @returns mutable configuration object.
 */
export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    token: generateToken(),
    exposedPackages: [],
    exposedRoutes: [],
    exposeTools: false,
  };
}

/**
 * Coerce arbitrary JSON into a valid configuration.
 *
 * Unknown fields are dropped, so a hand-edited file can never smuggle
 * behaviour into the running bridge. Absent or invalid fields fall back to
 * safe values; a missing token stays `''` so the caller can distinguish "not
 * provisioned yet" from "explicitly invalid".
 *
 * @param raw - parsed JSON value, or anything else.
 * @returns a normalized configuration object.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const token = typeof source.token === 'string' && TOKEN_RE.test(source.token) ? source.token : '';
  const exposed = [];
  if (Array.isArray(source.exposedPackages)) {
    for (const value of source.exposedPackages) {
      if (typeof value !== 'string') continue;
      const name = value.trim();
      if (name === '' || name.length > MAX_PACKAGE_LENGTH) continue;
      if (!PACKAGE_NAME_RE.test(name)) continue;
      if (exposed.includes(name)) continue;
      exposed.push(name);
      if (exposed.length >= MAX_PACKAGES) break;
    }
  }
  const exposedRoutes = [];
  if (Array.isArray(source.exposedRoutes)) {
    for (const value of source.exposedRoutes) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (!ROUTE_GROUP_RE.test(id)) continue;
      if (exposedRoutes.includes(id)) continue;
      exposedRoutes.push(id);
      if (exposedRoutes.length >= MAX_ROUTE_GROUPS) break;
    }
  }
  return {
    version: CONFIG_VERSION,
    enabled: source.enabled !== false,
    token,
    exposedPackages: exposed,
    exposedRoutes,
    exposeTools: source.exposeTools === true,
  };
}

/**
 * Read and normalize the config file.
 *
 * A missing file yields a fresh default (not persisted here). An unreadable or
 * corrupt file also yields a default, plus a diagnostic the caller should log:
 * the bridge must stay usable rather than fail activation over its own state.
 *
 * @param file - absolute config path.
 * @returns `{ config, exists, warning }`.
 */
export function loadConfigSync(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { config: createDefaultConfig(), exists: false, warning: undefined };
    }
    return {
      config: createDefaultConfig(),
      exists: true,
      warning: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const config = normalizeConfig(JSON.parse(text));
    return { config, exists: true, warning: undefined };
  } catch (error) {
    return {
      config: createDefaultConfig(),
      exists: true,
      warning: `ignoring invalid config at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Persist a configuration atomically (write beside the target, then rename).
 * @param file - absolute config path.
 * @param config - normalized configuration.
 */
export function saveConfigSync(file, config) {
  const normalized = normalizeConfig(config);
  if (normalized.token === '') normalized.token = generateToken();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    // A rename over an existing file can fail on some Windows filesystems.
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temporary file is best-effort cleanup only.
    }
    writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs and some filesystems do not expose POSIX modes.
  }
  return normalized;
}

/**
 * Render a token for display without exposing it in full.
 * @param token - the bearer token.
 * @returns masked token, or an empty string when unset.
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return '';
  if (token.length <= 12) return '…';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
