/**
 * dsh-plugins-bridge — Host half.
 *
 * A local HTTP bridge that exposes selected DeepSeek Harness plugin APIs over
 * `dsh-host-webserver`, so an external editor (Emacs, Vim, a script) can
 * discover and call them without speaking the browser's Remote protocol.
 *
 * Two prefixes, one loopback listener:
 *
 *   /plugins-bridge/api  management: loopback + same-origin only, no token
 *   /plugins-bridge/v1   external:   loopback + bearer token
 *
 * The bridge owns no second plugin registry. Every request projects the live
 * `ctx.typert.local` descriptors and the live Loader entries, so plugins that
 * mount or unload after activation appear or disappear immediately.
 *
 * @module dsh-plugins-bridge
 */

import { randomUUID } from 'node:crypto';

import { buildCatalog, hasEndpoints, summarizeEndpoint } from './lib/catalog.js';
import { buildRouteGroups, collectRoutes, findRoute, isThirdPartyPackage, routeSegment } from './lib/routes.js';
import {
  generateToken,
  loadConfigSync,
  maskToken,
  normalizeConfig,
  profileFromBaseUrl,
  resolveConfigPath,
  saveConfigSync,
} from './lib/config.js';
import {
  bearerToken,
  httpError,
  isLoopbackRequest,
  isSameOriginRequest,
  pickLocalized,
  readJsonBody,
  safeJson,
  sendError,
  sendJson,
  timingSafeEqualString,
} from './lib/http.js';

/** Root prefix claimed on the web server. */
const API_PREFIX = '/plugins-bridge';
/** Management API prefix (browser settings page; loopback only). */
const MANAGEMENT_PREFIX = `${API_PREFIX}/api`;
/** External API prefix (editors; bearer token). */
const EXTERNAL_PREFIX = `${API_PREFIX}/v1`;
/** Stable identity returned by discovery routes. */
const BRIDGE_INFO = Object.freeze({
  name: 'dsh-plugins-bridge',
  version: '0.1.0',
  apiVersion: 1,
});
/** Cooperative ceiling for one Remote call. */
const INVOKE_TIMEOUT_MS = 120_000;
/** Cooperative ceiling for one agent-tool call (tools may delegate or run workflows). */
const TOOL_TIMEOUT_MS = 600_000;
/** Maximum accepted POST body; tools such as write may legitimately carry large text. */
const BODY_LIMIT = 8 * 1024 * 1024;
/** Display languages accepted by the catalog projector. */
const LANGUAGE_IDS = new Set(['zh', 'en']);

/** Host services the bridge needs; all are core to the shipped Web profile. */
export const inject = [];

/**
 * Plugin entry point.
 *
 * The `inject` callback keeps the bridge pending until every required service
 * is live, and tears its routes down with the services it depends on. This is
 * deliberately scoped rather than a static export: a Web composition mounts
 * some of these services late, and a scoped child reacts to that.
 *
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.inject(
    ['webServer', 'typert', 'typertGateway', 'connection', 'loader', 'tools', 'agents'],
    (scope) => activate(scope),
  );
}

/**
 * Register the bridge once its required services exist.
 * @param ctx - context carrying every injected service.
 */
function activate(ctx) {
  const profile = profileFromBaseUrl(loaderBaseUrl(ctx)) ?? null;
  const configPath = resolveConfigPath(process.env, profile ?? undefined);
  let config = readInitialConfig(ctx, configPath);

  /**
   * Read the current Loader rows, resolving package identity and display
   * metadata through the optional `pluginPackages` service.
   * @param lang - preferred display language.
   * @returns plain entry rows for the catalog.
   */
  const readEntryRows = (lang) => {
    const packages = safeGet(ctx, 'pluginPackages');
    const rows = [];
    for (const entry of ctx.loader.entries()) {
      let options;
      try {
        options = entry.options ?? {};
      } catch {
        continue;
      }
      if (options.group) continue;
      const moduleName = typeof options.name === 'string' ? options.name : '';
      if (moduleName === '') continue;
      let packageName = guessPackageName(moduleName);
      let version;
      let title;
      let description;
      if (packages !== undefined) {
        try {
          const resolved = packages.packageOf(moduleName, entry.ctx?.baseUrl ?? ctx.baseUrl);
          if (resolved !== undefined) {
            packageName = resolved.name;
            version = resolved.version;
          }
        } catch {
          // Package resolution is best-effort; the module specifier remains a
          // usable identity when the resolver cannot locate a manifest.
        }
        try {
          const meta = packages.metaOf(moduleName, entry.ctx?.baseUrl ?? ctx.baseUrl);
          title = pickLocalized(meta?.title, lang);
          description = pickLocalized(meta?.description, lang);
        } catch {
          // Display metadata is optional.
        }
      }
      let phase = null;
      try {
        phase = entry.fiber?.state ?? null;
      } catch {
        phase = null;
      }
      let enabled = true;
      try {
        enabled = entry.disabled !== true;
      } catch {
        enabled = true;
      }
      let entryId = null;
      try {
        entryId = entry.id;
      } catch {
        entryId = null;
      }
      rows.push({ package: packageName, moduleName, entryId, phase, enabled, title, description, version });
    }
    return rows;
  };

  /**
   * Rebuild the live catalog.
   * @param lang - display language.
   * @returns catalog rows.
   */
  const readCatalog = (lang) => buildCatalog(readEntryRows(lang), ctx.typert.local.list());

  /**
   * Discover route groups registered on the web server and attribute them to
   * catalog packages. The same projection feeds the settings page and the
   * external route listing.
   * @param catalog - current catalog rows.
   * @returns route groups.
   */
  const readRouteGroups = (catalog) => buildRouteGroups(
    collectRoutes(ctx.webServer),
    catalog.map((row) => ({ package: row.package, title: row.title })),
    config.exposedRoutes,
    API_PREFIX,
  );

  /** The full management state for one language. */
  const readState = (lang) => {
    const catalog = readCatalog(lang);
    const routeGroups = readRouteGroups(catalog);
    const routeCountByPackage = new Map();
    for (const group of routeGroups) {
      if (typeof group.package !== 'string') continue;
      routeCountByPackage.set(group.package, (routeCountByPackage.get(group.package) ?? 0) + group.routeCount);
    }
    const exposed = new Set(config.exposedPackages);
    const endpointCount = catalog.reduce((total, row) => total + row.endpoints.length, 0);
    return {
      ok: true,
      bridge: BRIDGE_INFO,
      enabled: config.enabled,
      token: config.token,
      tokenMasked: maskToken(config.token),
      exposedPackages: config.exposedPackages,
      exposedRoutes: config.exposedRoutes,
      exposeTools: config.exposeTools,
      baseUrl: externalBaseUrl(ctx),
      managementPath: MANAGEMENT_PREFIX,
      configPath,
      profile,
      stats: {
        plugins: catalog.length,
        apiPackages: catalog.filter(hasEndpoints).length,
        endpoints: endpointCount,
        exposed: catalog.filter((row) => exposed.has(row.package) && hasEndpoints(row)).length,
        routeGroups: routeGroups.length,
        exposedRouteGroups: routeGroups.filter((group) => group.selected).length,
      },
      routes: routeGroups,
      tools: readToolState(),
      agents: readAgents(),
      plugins: catalog.map((row) => ({
        package: row.package,
        title: row.title,
        description: row.description,
        version: row.version,
        phase: row.phase,
        enabled: row.enabled,
        selected: exposed.has(row.package),
        endpointCount: row.endpoints.length,
        httpRouteCount: routeCountByPackage.get(row.package) ?? 0,
        thirdParty: isThirdPartyPackage(row.package),
        streamCount: row.endpoints.filter((endpoint) => endpoint.kind === 'stream').length,
        endpoints: row.endpoints.map(summarizeEndpoint),
        entries: row.entries,
      })),
    };
  };

  /** One plugin's full detail, including parameter and result schemas. */
  const readPluginDetail = (lang, packageName, endpointName) => {
    const catalog = readCatalog(lang);
    const row = catalog.find((candidate) => candidate.package === packageName);
    if (row === undefined) {
      throw httpError(404, 'unknown-package', `no plugin package named ${JSON.stringify(packageName)} is available`, 'package');
    }
    if (endpointName !== undefined) {
      const endpoint = row.endpoints.find((candidate) => candidate.endpoint === endpointName);
      if (endpoint === undefined) {
        throw httpError(404, 'unknown-endpoint', `package ${packageName} has no endpoint ${JSON.stringify(endpointName)}`, 'endpoint');
      }
      return { ...publicRow(row), endpoint };
    }
    return publicRow(row);
  };

  /** `{...}` projection shared by management and external detail routes. */
  const publicRow = (row) => ({
    package: row.package,
    title: row.title,
    description: row.description,
    version: row.version,
    phase: row.phase,
    enabled: row.enabled,
    selected: config.exposedPackages.includes(row.package),
    thirdParty: isThirdPartyPackage(row.package),
    entries: row.entries,
    endpointCount: row.endpoints.length,
    endpoints: row.endpoints,
  });

  /** Live agent tools metadata for the settings page. */
  const readToolState = () => {
    let count = 0;
    try {
      count = ctx.tools.schemas().length;
    } catch {
      count = 0;
    }
    return { available: true, count, exposed: config.exposeTools };
  };

  /** Live sessions an external caller can pass as `agentId`. */
  const readAgents = () => {
    try {
      return ctx.agents.list().map((agent) => ({
        id: agent.id,
        status: typeof agent.status === 'string' ? agent.status : 'unknown',
        cwd: readAgentCwd(agent),
      }));
    } catch {
      return [];
    }
  };

  /**
   * Invoke one Remote method through the Host gateway with an owner peer.
   *
   * `ctx.typertGateway.invoke` is the same dispatch path the browser UI uses;
   * it validates the descriptor's named arguments, resolves `agentId` lookups,
   * injects cancellation, and enforces strict result codecs.
   *
   * @param packageName - exposed package owning the endpoint.
   * @param endpointName - `<namespace>/<method>`.
   * @param args - named wire arguments.
   * @param signal - caller cancellation.
   * @returns the raw business result.
   */
  const invokeRemote = async (packageName, endpointName, args, signal) => {
    if (!config.enabled) {
      throw httpError(503, 'bridge-disabled', 'the plugins bridge is disabled in Settings');
    }
    if (!config.exposedPackages.includes(packageName)) {
      throw httpError(403, 'package-not-exposed', `package ${packageName} is not exposed; enable it in Settings`, 'package');
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw httpError(400, 'invalid-arguments', 'args must be a JSON object', 'args');
    }
    const descriptor = ctx.typert.local.get(endpointName);
    if (descriptor === undefined || descriptor.id !== `${packageName}#${endpointName}`) {
      throw httpError(404, 'unknown-endpoint', `package ${packageName} has no live endpoint ${JSON.stringify(endpointName)}`, 'endpoint');
    }
    if (descriptor.mode === 'stream') {
      throw httpError(501, 'stream-unsupported', `endpoint ${endpointName} is a streaming method; this bridge currently supports unary methods only`, 'endpoint');
    }
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    try {
      return await ctx.typertGateway.invoke({
        namespace: descriptor.namespace,
        method: descriptor.method,
        args,
        peer,
        signal,
      });
    } finally {
      try {
        await peer.dispose();
      } catch {
        // Peer disposal is connection-lifetime cleanup; a failure here must not
        // replace the call outcome.
      }
    }
  };

  /**
   * Execute one agent tool.
   * @param request - `{ name, arguments, agentId }`.
   * @param signal - caller cancellation.
   * @returns structured tool outcome.
   */
  const invokeTool = async (request, signal) => {
    if (!config.exposeTools) {
      throw httpError(403, 'tools-not-exposed', 'agent tools are not exposed; enable them in Settings');
    }
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (name === '') throw httpError(400, 'missing-tool-name', 'name must be a non-empty string', 'name');
    const agentId = typeof request.agentId === 'string' && request.agentId !== '' ? request.agentId : undefined;
    let agent;
    if (agentId !== undefined) {
      agent = ctx.agents.get(agentId);
      if (agent === undefined) throw httpError(404, 'unknown-agent', `no live session ${JSON.stringify(agentId)}`, 'agentId');
    }
    if (ctx.tools.get(name, agent) === undefined) {
      throw httpError(404, 'unknown-tool', `no tool named ${JSON.stringify(name)} is visible${agentId === undefined ? '' : ' to that session'}`, 'name');
    }
    const args = request.arguments === undefined ? {} : request.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw httpError(400, 'invalid-arguments', 'arguments must be a JSON object', 'arguments');
    }
    const result = await ctx.tools.execute({
      callId: `bridge-${randomUUID()}`,
      name,
      arguments: args,
      agent,
      signal,
    });
    return {
      ok: result.isError !== true,
      isError: result.isError === true,
      value: safeJson(result.value),
      content: safeJson(result.content),
      error: result.error === undefined ? undefined : safeJson(result.error),
      meta: result.meta === undefined ? undefined : safeJson(result.meta),
    };
  };

  /**
   * Resolve a request's target, accepting `package` + `endpoint`, a combined
   * `package#endpoint`, or a unique endpoint with the package omitted.
   * @returns `{ package, endpoint }`.
   */
  const resolveTarget = (body) => {
    let packageName = typeof body.package === 'string' ? body.package.trim() : '';
    let endpointName = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (endpointName.includes('#')) {
      const separator = endpointName.indexOf('#');
      if (packageName === '') packageName = endpointName.slice(0, separator);
      endpointName = endpointName.slice(separator + 1);
    }
    if (endpointName === '') throw httpError(400, 'missing-endpoint', 'endpoint must be "<namespace>/<method>"', 'endpoint');
    if (packageName === '') {
      const candidates = config.exposedPackages.filter((candidate) => {
        const descriptor = ctx.typert.local.get(endpointName);
        return descriptor !== undefined && descriptor.id === `${candidate}#${endpointName}`;
      });
      if (candidates.length !== 1) {
        throw httpError(
          400,
          'package-required',
          candidates.length === 0
            ? `no exposed package provides endpoint ${endpointName}`
            : `endpoint ${endpointName} is provided by several packages; pass package`,
          'package',
        );
      }
      packageName = candidates[0];
    }
    return { package: packageName, endpoint: endpointName };
  };

  /** Apply a management configuration body. */
  const updateConfig = (body) => {
    const next = { ...config };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.exposeTools === 'boolean') next.exposeTools = body.exposeTools;
    if (body.exposedPackages !== undefined) {
      if (!Array.isArray(body.exposedPackages)) {
        throw httpError(400, 'invalid-exposed-packages', 'exposedPackages must be an array of package names', 'exposedPackages');
      }
      if (body.exposedPackages.length > 500) {
        throw httpError(400, 'too-many-packages', 'exposedPackages may hold at most 500 names', 'exposedPackages');
      }
      for (const value of body.exposedPackages) {
        if (typeof value !== 'string' || value.trim() === '') {
          throw httpError(400, 'invalid-exposed-packages', 'every exposedPackages entry must be a non-empty string', 'exposedPackages');
        }
      }
      next.exposedPackages = body.exposedPackages;
    }
    if (body.exposedRoutes !== undefined) {
      if (!Array.isArray(body.exposedRoutes)) {
        throw httpError(400, 'invalid-exposed-routes', 'exposedRoutes must be an array of route-group ids', 'exposedRoutes');
      }
      if (body.exposedRoutes.length > 200) {
        throw httpError(400, 'too-many-routes', 'exposedRoutes may hold at most 200 groups', 'exposedRoutes');
      }
      for (const value of body.exposedRoutes) {
        if (typeof value !== 'string' || value.trim() === '') {
          throw httpError(400, 'invalid-exposed-routes', 'every exposedRoutes entry must be a non-empty string', 'exposedRoutes');
        }
      }
      next.exposedRoutes = body.exposedRoutes;
    }
    if (body.regenerateToken === true) next.token = generateToken();
    config = saveConfigSync(configPath, normalizeConfig(next));
  };

  /**
   * Dispatch one HTTP request under `/plugins-bridge`.
   * @param req - incoming request.
   * @param res - server response.
   */
  const handle = async (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendError(res, 403, 'loopback-only', 'the plugins bridge only answers requests from this machine');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const lang = languageFrom(url);
    try {
      if (path === MANAGEMENT_PREFIX || path.startsWith(`${MANAGEMENT_PREFIX}/`)) {
        await handleManagement(req, res, url, path, lang);
        return;
      }
      if (path === EXTERNAL_PREFIX || path.startsWith(`${EXTERNAL_PREFIX}/`)) {
        await handleExternal(req, res, url, path, lang);
        return;
      }
      sendError(res, 404, 'not-found', `unknown bridge path ${path}`);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = statusForError(error);
      const code = typeof error?.code === 'string' ? error.code : 'internal-error';
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, status, code, message, error?.field === undefined ? {} : { field: error.field });
      if (status >= 500) {
        try {
          ctx.logger?.warn?.(`[dsh-plugins-bridge] ${req.method} ${path} failed: ${message}`);
        } catch {
          // Logging is best-effort.
        }
      }
    }
  };

  /** Management routes: browser settings page, loopback + authenticated browser session. */
  const handleManagement = async (req, res, url, path, lang) => {
    const route = path.slice(MANAGEMENT_PREFIX.length) || '/';
    const method = req.method ?? 'GET';
    // The management page returns the bearer token and can invoke endpoints,
    // so loopback alone is not enough: require the same signed DSH browser
    // session that protects the Web UI itself. Local processes without that
    // cookie must use /v1 and the token.
    let rejection;
    try {
      rejection = ctx.connection.requestRejection({ headers: req.headers });
    } catch {
      rejection = 403;
    }
    if (rejection !== undefined) {
      sendError(
        res,
        rejection,
        rejection === 403 ? 'forbidden' : 'unauthorized',
        rejection === 403
          ? 'management requests must come from a trusted DSH origin'
          : 'the authenticated DSH browser session is required',
      );
      return;
    }
    if (method === 'POST' && !isSameOriginRequest(req)) {
      sendError(res, 403, 'cross-origin', 'management writes must come from the same origin');
      return;
    }
    if (method === 'POST') requireJsonContentType(req);
    if (route === '/state' && method === 'GET') {
      sendJson(res, 200, readState(lang));
      return;
    }
    if (route === '/plugin' && method === 'GET') {
      const packageName = url.searchParams.get('package');
      if (packageName === null || packageName === '') {
        throw httpError(400, 'missing-package', 'the package query parameter is required', 'package');
      }
      const endpointName = url.searchParams.get('endpoint') ?? undefined;
      sendJson(res, 200, { ok: true, ...readPluginDetail(lang, packageName, endpointName ?? undefined) });
      return;
    }
    if (route === '/config' && method === 'POST') {
      updateConfig(await readJsonBody(req, BODY_LIMIT));
      sendJson(res, 200, readState(lang));
      return;
    }
    if (route === '/test' && method === 'POST') {
      const body = await readJsonBody(req, BODY_LIMIT);
      const target = resolveTarget(body);
      const args = body.args === undefined ? {} : body.args;
      const outcome = await callWithTimeout(
        (signal) => invokeRemote(target.package, target.endpoint, args, signal),
        req,
      );
      sendJson(res, 200, { ok: true, package: target.package, endpoint: target.endpoint, result: safeJson(outcome) });
      return;
    }
    sendMethodOrNotFound(res, method, route, {
      '/state': ['GET'],
      '/plugin': ['GET'],
      '/config': ['POST'],
      '/test': ['POST'],
    });
  };

  /**
   * Forward one request to an exposed plugin route.
   *
   * The target handler is called directly with the original request object so
   * its body stream, method, headers, and response ownership are preserved.
   * Only `req.url` is rewritten to the target path. The target route's own
   * checks (loopback, browser session, method, body) still run.
   *
   * @param req - incoming request.
   * @param res - server response.
   * @param url - parsed external URL.
   */
  const forwardRoute = async (req, res, url) => {
    const prefix = `${EXTERNAL_PREFIX}/http`;
    const targetPath = url.pathname.slice(prefix.length);
    if (targetPath === '' || targetPath === '/') {
      throw httpError(400, 'missing-route-path', 'use /v1/http/<route-group>/<path>', 'path');
    }
    if (targetPath === API_PREFIX || targetPath.startsWith(`${API_PREFIX}/`)) {
      throw httpError(403, 'recursive-route', 'the bridge cannot proxy its own routes');
    }
    const segment = routeSegment(targetPath);
    if (segment === undefined) {
      throw httpError(400, 'invalid-route-path', 'the target path has no route group', 'path');
    }
    if (!config.exposedRoutes.includes(segment)) {
      throw httpError(403, 'route-not-exposed', `route group ${JSON.stringify(segment)} is not exposed; enable it in Settings`, 'path');
    }
    const route = findRoute(ctx.webServer, targetPath);
    if (route === undefined || routeSegment(route.path) !== segment) {
      throw httpError(404, 'route-not-found', `no registered route matches ${JSON.stringify(targetPath)}`, 'path');
    }
    const originalUrl = req.url;
    req.url = `${targetPath}${url.search}`;
    try {
      await route.handler(req, res);
    } finally {
      req.url = originalUrl;
    }
  };

  /** External routes: bearer token, loopback. */
  const handleExternal = async (req, res, url, path, lang) => {
    const route = path.slice(EXTERNAL_PREFIX.length) || '/';
    const method = req.method ?? 'GET';
    if (route === '' || route === '/' || route === '/health') {
      if (method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', 'use GET', { headers: { allow: 'GET' } });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        bridge: BRIDGE_INFO,
        enabled: config.enabled,
        authentication: 'Bearer token in Authorization: Bearer <token>',
        endpoints: {
          plugins: `${EXTERNAL_PREFIX}/plugins`,
          plugin: `${EXTERNAL_PREFIX}/plugin?package=<name>`,
          agents: `${EXTERNAL_PREFIX}/agents`,
          invoke: `${EXTERNAL_PREFIX}/invoke`,
          routes: `${EXTERNAL_PREFIX}/routes`,
          http: `${EXTERNAL_PREFIX}/http/<route-group>/<path>`,
          tools: `${EXTERNAL_PREFIX}/tools`,
          toolInvoke: `${EXTERNAL_PREFIX}/tools/invoke`,
        },
      });
      return;
    }
    if (!config.enabled) {
      throw httpError(503, 'bridge-disabled', 'the plugins bridge is disabled in Settings');
    }
    const token = bearerToken(req);
    if (config.token === '' || token === undefined || !timingSafeEqualString(token, config.token)) {
      sendError(res, 401, 'unauthorized', 'a valid bearer token is required', {
        headers: { 'www-authenticate': 'Bearer realm="dsh-plugins-bridge"' },
      });
      return;
    }
    if (route === '/http' || route.startsWith('/http/')) {
      await forwardRoute(req, res, url);
      return;
    }
    if (route === '/plugins' && method === 'GET') {
      const catalog = readCatalog(lang);
      const exposed = catalog.filter((row) => config.exposedPackages.includes(row.package) && hasEndpoints(row));
      sendJson(res, 200, {
        ok: true,
        bridge: BRIDGE_INFO,
        plugins: exposed.map((row) => ({
          package: row.package,
          title: row.title,
          description: row.description,
          version: row.version,
          phase: row.phase,
          enabled: row.enabled,
          endpointCount: row.endpoints.length,
          endpoints: row.endpoints.map(summarizeEndpoint),
        })),
      });
      return;
    }
    if (route === '/plugin' && method === 'GET') {
      const packageName = url.searchParams.get('package');
      if (packageName === null || packageName === '') {
        throw httpError(400, 'missing-package', 'the package query parameter is required', 'package');
      }
      if (!config.exposedPackages.includes(packageName)) {
        throw httpError(404, 'package-not-exposed', `package ${packageName} is not exposed`, 'package');
      }
      const endpointName = url.searchParams.get('endpoint') ?? undefined;
      sendJson(res, 200, { ok: true, ...readPluginDetail(lang, packageName, endpointName ?? undefined) });
      return;
    }
    if (route === '/routes' && method === 'GET') {
      const catalog = readCatalog(lang);
      const groups = readRouteGroups(catalog);
      sendJson(res, 200, {
        ok: true,
        routes: groups.map((group) => ({
          id: group.id,
          title: group.title,
          package: group.package,
          thirdParty: group.thirdParty,
          selected: group.selected,
          kinds: group.kinds,
          prefixes: group.prefixes,
          routeCount: group.routeCount,
          paths: group.paths,
        })),
      });
      return;
    }
    if (route === '/agents' && method === 'GET') {
      sendJson(res, 200, { ok: true, agents: readAgents() });
      return;
    }
    if (route === '/tools' && method === 'GET') {
      requireToolsExposed();
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const agent = resolveAgent(agentId);
      let tools;
      try {
        tools = ctx.tools.schemas(agent).map((schema) => ({
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        }));
      } catch (error) {
        throw httpError(500, 'tools-unavailable', error instanceof Error ? error.message : String(error));
      }
      sendJson(res, 200, { ok: true, agentId: agentId ?? null, tools });
      return;
    }
    if (route === '/invoke' && method === 'POST') {
      requireJsonContentType(req);
      const body = await readJsonBody(req, BODY_LIMIT);
      const target = resolveTarget(body);
      const args = body.args === undefined ? {} : body.args;
      const outcome = await callWithTimeout(
        (signal) => invokeRemote(target.package, target.endpoint, args, signal),
        req,
      );
      sendJson(res, 200, {
        ok: true,
        package: target.package,
        endpoint: target.endpoint,
        result: safeJson(outcome),
      });
      return;
    }
    if (route === '/tools/invoke' && method === 'POST') {
      requireToolsExposed();
      requireJsonContentType(req);
      const body = await readJsonBody(req, BODY_LIMIT);
      const outcome = await callWithTimeout((signal) => invokeTool(body, signal), req, TOOL_TIMEOUT_MS);
      sendJson(res, 200, outcome);
      return;
    }
    sendMethodOrNotFound(res, method, route, {
      '/plugins': ['GET'],
      '/plugin': ['GET'],
      '/routes': ['GET'],
      '/agents': ['GET'],
      '/tools': ['GET'],
      '/invoke': ['POST'],
      '/tools/invoke': ['POST'],
    });
  };

  /** Fail loudly when tools are switched off. */
  const requireToolsExposed = () => {
    if (!config.exposeTools) {
      throw httpError(403, 'tools-not-exposed', 'agent tools are not exposed; enable them in Settings');
    }
  };

  /** Resolve an optional session id for tool scoping. */
  const resolveAgent = (agentId) => {
    if (agentId === undefined) return undefined;
    const agent = ctx.agents.get(agentId);
    if (agent === undefined) throw httpError(404, 'unknown-agent', `no live session ${JSON.stringify(agentId)}`, 'agentId');
    return agent;
  };

  /** Register the one route and report the bridge is live. */
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
    'dsh-plugins-bridge: loopback API',
  );
  try {
    ctx.logger?.info?.(
      `[dsh-plugins-bridge] ${externalBaseUrl(ctx)} — ${config.exposedPackages.length} exposed package(s)`,
    );
  } catch {
    // Logging must never prevent activation.
  }
}

/**
 * Load configuration, provision a token on first use, and persist the result.
 * @param ctx - context for diagnostics.
 * @param file - absolute config path.
 * @returns normalized live configuration.
 */
function readInitialConfig(ctx, file) {
  const loaded = loadConfigSync(file);
  let config = loaded.config;
  if (loaded.warning !== undefined) {
    try {
      ctx.logger?.warn?.(`[dsh-plugins-bridge] ${loaded.warning}`);
    } catch {
      // Diagnostics are best-effort.
    }
  }
  if (config.token === '' || !loaded.exists || loaded.warning !== undefined) {
    if (config.token === '') config.token = generateToken();
    try {
      config = saveConfigSync(file, config);
    } catch (error) {
      try {
        ctx.logger?.warn?.(
          `[dsh-plugins-bridge] cannot persist ${file}: ${error instanceof Error ? error.message : String(error)}; the token is session-only`,
        );
      } catch {
        // Diagnostics are best-effort.
      }
    }
  }
  return config;
}

/**
 * Map a thrown value to an HTTP status without hiding the gateway's own codes.
 * @param error - thrown value.
 * @returns HTTP status code.
 */
function statusForError(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case 'gateway/arguments-invalid':
    case 'gateway/input-invalid':
    case 'gateway/signature-invalid':
    case 'gateway/ambiguous-endpoint':
    case 'gateway/binding-invalid':
    case 'gateway/provider-mismatch':
      return 400;
    case 'gateway/interactions-forbidden':
      return 403;
    case 'gateway/lookup-not-found':
    case 'gateway/context-not-found':
    case 'gateway/method-unavailable':
    case 'gateway/definition-unavailable':
      return 404;
    case 'gateway/service-unavailable':
    case 'gateway/context-unavailable':
    case 'gateway/invocation-unavailable':
      return 503;
    default:
      return 500;
  }
}

/**
 * The Loader's configured base URL, if the context exposes one.
 * @param ctx - host context.
 * @returns base URL text, or undefined.
 */
function loaderBaseUrl(ctx) {
  const candidates = [ctx?.baseUrl, ctx?.loader?.ctx?.baseUrl, ctx?.loader?.context?.baseUrl];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  try {
    for (const entry of ctx.loader.entries()) {
      const fromEntry = entry?.ctx?.baseUrl;
      if (typeof fromEntry === 'string' && fromEntry !== '') return fromEntry;
    }
  } catch {
    // No Loader entries readable; fall back to the global config path.
  }
  return undefined;
}

/**
 * Derive a package name from a Loader module specifier when no package
 * resolver is available.
 * @param specifier - configured module specifier.
 * @returns best-effort package name.
 */
function guessPackageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

/**
 * Optional service lookup that never throws.
 * @param ctx - host context.
 * @param name - service key.
 * @returns the service, or undefined.
 */
function safeGet(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Read the preferred language from `?lang=`.
 * @param url - request URL.
 * @returns `'en'` or `'zh'`.
 */
function languageFrom(url) {
  const lang = url.searchParams.get('lang');
  return lang !== null && LANGUAGE_IDS.has(lang) ? lang : 'zh';
}

/**
 * The external API root for this listener.
 * @param ctx - host context.
 * @returns absolute URL.
 */
function externalBaseUrl(ctx) {
  let origin;
  try {
    origin = ctx.webServer.getOrigin();
  } catch {
    origin = `http://127.0.0.1:${ctx.webServer.port ?? 3080}`;
  }
  return `${origin}${EXTERNAL_PREFIX}`;
}

/** Reject a POST that is not JSON; forces a CORS preflight for browsers. */
function requireJsonContentType(req) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw httpError(415, 'unsupported-media-type', 'POST requests must use content-type: application/json');
  }
}

/**
 * Serve a 405 with an `allow` header, or a 404 for an unknown route.
 * @param res - server response.
 * @param method - request method.
 * @param route - path inside the prefix.
 * @param routes - supported methods per route.
 */
function sendMethodOrNotFound(res, method, route, routes) {
  const allowed = routes[route];
  if (allowed === undefined) {
    sendError(res, 404, 'not-found', `unknown route ${route}`);
    return;
  }
  if (!allowed.includes(method)) {
    sendError(res, 405, 'method-not-allowed', `use ${allowed.join(' or ')}`, { headers: { allow: allowed.join(', ') } });
    return;
  }
  sendError(res, 404, 'not-found', `unknown route ${route}`);
}

/**
 * Run one operation under a cooperative timeout and caller cancellation.
 * @param operation - work receiving an AbortSignal.
 * @param req - request whose disconnect cancels the work.
 * @returns the operation result.
 */
async function callWithTimeout(operation, req, timeoutMs = INVOKE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`plugins bridge call exceeded ${timeoutMs} ms`));
  }, timeoutMs);
  const onAborted = () => controller.abort(new Error('client disconnected'));
  req.once?.('aborted', onAborted);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    req.removeListener?.('aborted', onAborted);
  }
}

/**
 * Best-effort session working directory for the agent listing.
 * @param agent - live agent.
 * @returns cwd or null.
 */
function readAgentCwd(agent) {
  try {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string') return cwd;
  } catch {
    // Fall through.
  }
  try {
    const cwd = agent?.options?.cwd;
    if (typeof cwd === 'string') return cwd;
  } catch {
    // Fall through.
  }
  return null;
}

export default { name: 'dsh-plugins-bridge', inject, apply };
