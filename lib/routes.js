/**
 * Best-effort projection of `dsh-host-webserver` route registrations into
 * selectable plugin route groups.
 *
 * The web server keeps its route tables on the service (`exact` and `prefixes`
 * Maps). They are not part of the public package contract, but they are the
 * only runtime source that can see routes registered by plugins without a
 * Typert artifact. Every read is guarded: if a future release renames or hides
 * the fields, the bridge simply reports no route groups instead of failing.
 *
 * @module dsh-plugins-bridge/routes
 */

/** Minimum length before a segment may match a package by prefix/suffix. */
const MIN_PREFIX_MATCH = 4;
/** Package names under this scope are shipped Harness packages, not user plugins. */
const SHIPPED_SCOPE = '@deepseek-ai/';
/** The bridge's own package must never be proxied back into itself. */
const OWN_PACKAGE = 'dsh-plugins-bridge';

/**
 * Whether a package is a user-installed plugin rather than a shipped Harness
 * package, a `cordis:` builtin, or this bridge itself.
 * @param packageName - npm package name.
 * @returns true for third-party plugin packages.
 */
export function isThirdPartyPackage(packageName) {
  if (typeof packageName !== 'string' || packageName === '') return false;
  if (packageName === OWN_PACKAGE) return false;
  if (packageName.startsWith(SHIPPED_SCOPE)) return false;
  if (packageName.startsWith('cordis:')) return false;
  return true;
}

/**
 * The top-level path segment that identifies a route group.
 * @param pathname - absolute pathname.
 * @returns segment, or undefined for the root and malformed paths.
 */
export function routeSegment(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return undefined;
  const rest = pathname.slice(1);
  if (rest === '') return undefined;
  const segment = rest.split('/')[0];
  return segment === '' ? undefined : segment;
}

/**
 * Read the live route tables without mutating them.
 * @param webServer - `ctx.webServer`.
 * @returns `[{ kind, path }]` sorted by path.
 */
export function collectRoutes(webServer) {
  const found = [];
  const exact = webServer?.exact;
  if (exact instanceof Map) {
    for (const route of exact.values()) {
      if (route !== null && typeof route === 'object' && typeof route.path === 'string' && typeof route.handler === 'function') {
        found.push({ kind: 'exact', path: route.path });
      }
    }
  }
  const prefixes = webServer?.prefixes;
  if (prefixes instanceof Map) {
    for (const route of prefixes.values()) {
      if (route !== null && typeof route === 'object' && typeof route.path === 'string' && typeof route.handler === 'function') {
        found.push({ kind: 'prefix', path: route.path });
      }
    }
  }
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}

/**
 * Find the route the web server would dispatch for a pathname: exact first,
 * then the longest matching prefix. The fallback (SPA) is deliberately not
 * returned.
 * @param webServer - `ctx.webServer`.
 * @param pathname - absolute pathname.
 * @returns the route object, or undefined.
 */
export function findRoute(webServer, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return undefined;
  const exact = webServer?.exact;
  if (exact instanceof Map) {
    const route = exact.get(pathname);
    if (route !== undefined && typeof route.handler === 'function') return route;
  }
  const prefixes = webServer?.prefixes;
  if (prefixes instanceof Map) {
    let best;
    for (const [prefix, route] of prefixes) {
      if (typeof prefix !== 'string' || typeof route?.handler !== 'function') continue;
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
      if (best === undefined || prefix.length > best.prefix.length) best = { prefix, route };
    }
    if (best !== undefined) return best.route;
  }
  return undefined;
}

/**
 * Score how well one route segment names one package.
 * @param segment - first path segment.
 * @param packageName - npm package name.
 * @returns score; 0 means unrelated.
 */
function packageScore(segment, packageName) {
  if (typeof packageName !== 'string' || packageName === '') return 0;
  const base = packageName.startsWith('@') ? packageName.split('/')[1] ?? packageName : packageName;
  const variants = new Set([packageName, base, base.replace(/^dsh-/u, '')]);
  for (const variant of variants) {
    if (variant === segment) return 100;
    if (segment.length >= MIN_PREFIX_MATCH
      && (variant.startsWith(`${segment}-`) || variant.endsWith(`-${segment}`))) return 80;
  }
  return 0;
}

/**
 * Attribute a route group to its package and attach display/selection state.
 *
 * A group with no confident match is a system group: selectable only when the
 * operator reveals system routes, and never auto-exposed.
 *
 * @param routes - `collectRoutes()` output.
 * @param packages - catalog rows reduced to `{ package, title }`.
 * @param exposedRoutes - selected route-group ids.
 * @param excludePrefix - route prefix owned by the bridge itself.
 * @returns sorted route groups.
 */
export function buildRouteGroups(routes, packages, exposedRoutes, excludePrefix = '/plugins-bridge') {
  const exposed = new Set(Array.isArray(exposedRoutes) ? exposedRoutes : []);
  const groups = new Map();
  for (const route of Array.isArray(routes) ? routes : []) {
    const path = route?.path;
    if (typeof path !== 'string' || path === '/' || !path.startsWith('/')) continue;
    if (path === excludePrefix || path.startsWith(`${excludePrefix}/`)) continue;
    const id = routeSegment(path);
    if (id === undefined) continue;
    let group = groups.get(id);
    if (group === undefined) {
      group = { id, paths: new Set(), kinds: new Set(), routeCount: 0 };
      groups.set(id, group);
    }
    if (!group.paths.has(path)) {
      group.paths.add(path);
      group.routeCount += 1;
    }
    group.kinds.add(route.kind === 'prefix' ? 'prefix' : 'exact');
  }

  const result = [];
  for (const group of groups.values()) {
    let match;
    let matchScore = 0;
    for (const candidate of Array.isArray(packages) ? packages : []) {
      const score = packageScore(group.id, candidate?.package);
      if (score === 0) continue;
      if (score > matchScore || (score === matchScore && match !== undefined
        && String(candidate.package).localeCompare(String(match.package)) < 0)) {
        match = candidate;
        matchScore = score;
      }
    }
    const thirdParty = match !== undefined && isThirdPartyPackage(match.package);
    const paths = [...group.paths].sort((left, right) => left.localeCompare(right));
    const kinds = [...group.kinds].sort();
    result.push({
      id: group.id,
      title: typeof match?.title === 'string' && match.title !== '' ? match.title : group.id,
      package: match === undefined ? null : match.package,
      thirdParty,
      system: !thirdParty,
      selected: exposed.has(group.id),
      routeCount: group.routeCount,
      kinds,
      prefixes: kinds.includes('prefix'),
      paths,
    });
  }
  return result.sort((left, right) => {
    if (left.thirdParty !== right.thirdParty) return left.thirdParty ? -1 : 1;
    const byTitle = String(left.title).localeCompare(String(right.title));
    return byTitle !== 0 ? byTitle : left.id.localeCompare(right.id);
  });
}
