/**
 * Pure catalog projection over live Typert invocation descriptors and Loader
 * plugin rows.
 *
 * The bridge does not maintain a second registry: every request rebuilds this
 * view from the running Host, so a plugin mounted or unloaded a moment ago is
 * reflected immediately. The module is Harness-independent so the projection
 * rules can be tested without booting DSH.
 *
 * @module dsh-plugins-bridge/catalog
 */

/** Most descriptive phase wins when several Loader rows share a package. */
const PHASE_RANK = {
  active: 6,
  loading: 5,
  pending: 4,
  unloading: 3,
  failed: 2,
  disposed: 1,
};

/** Longest endpoint description retained in a summary listing. */
const SUMMARY_DESCRIPTION_LIMIT = 280;

/**
 * Extract the npm package from a generated invocation id (`<package>#<endpoint>`).
 * @param descriptor - live Typert descriptor.
 * @returns package name, or `undefined` for an id without a package part.
 */
export function packageOfDescriptor(descriptor) {
  const id = typeof descriptor?.id === 'string' ? descriptor.id : '';
  const separator = id.indexOf('#');
  return separator > 0 ? id.slice(0, separator) : undefined;
}

/**
 * The canonical `<namespace>/<method>` endpoint of a descriptor.
 * @param descriptor - live Typert descriptor.
 * @returns endpoint string.
 */
export function endpointOfDescriptor(descriptor) {
  if (typeof descriptor?.namespace === 'string' && typeof descriptor?.method === 'string') {
    return `${descriptor.namespace}/${descriptor.method}`;
  }
  const id = typeof descriptor?.id === 'string' ? descriptor.id : '';
  const separator = id.indexOf('#');
  return separator >= 0 ? id.slice(separator + 1) : id;
}

/**
 * Read the JSON Schema a codec carries, preferring its strict projection.
 * @param codec - Typert codec or result codec.
 * @returns a JSON Schema object, or `null` when unavailable.
 */
export function jsonSchemaOf(codec) {
  const schema = codec?.strictCodec?.jsonSchema ?? codec?.jsonSchema;
  return schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

/**
 * Project one parameter for an editor.
 * @param parameter - descriptor parameter.
 * @returns plain parameter description.
 */
export function projectParameter(parameter) {
  return {
    name: typeof parameter?.name === 'string' ? parameter.name : 'argument',
    wire: typeof parameter?.wire === 'string' ? parameter.wire : String(parameter?.name ?? 'argument'),
    required: parameter?.acceptsUndefined !== true,
    source: parameter?.source === 'lookup' ? 'lookup' : 'json',
    description: typeof parameter?.description === 'string' ? parameter.description : undefined,
    schema: jsonSchemaOf(parameter?.codec),
  };
}

/**
 * Project one live descriptor into the bridge's stable endpoint shape.
 * @param descriptor - live Typert invocation descriptor.
 * @returns endpoint description, or `undefined` when it is not a generated API.
 */
export function projectEndpoint(descriptor) {
  const pkg = packageOfDescriptor(descriptor);
  if (pkg === undefined) return undefined;
  const endpoint = endpointOfDescriptor(descriptor);
  if (endpoint === '') return undefined;
  const scope = descriptor?.scope;
  const invocation = descriptor?.invocation;
  const requiresAgent = scope !== null && typeof scope === 'object' && scope.context === 'agent' && typeof scope.wire === 'string'
    ? scope.wire
    : invocation !== null && typeof invocation === 'object' && invocation.kind === 'context'
      && invocation.context === 'agent' && typeof invocation.wire === 'string'
      ? invocation.wire
      : null;
  return {
    package: pkg,
    endpoint,
    namespace: typeof descriptor.namespace === 'string' ? descriptor.namespace : endpoint.slice(0, endpoint.indexOf('/')),
    method: typeof descriptor.method === 'string' ? descriptor.method : endpoint.slice(endpoint.indexOf('/') + 1),
    kind: descriptor?.mode === 'stream' ? 'stream' : 'unary',
    description: typeof descriptor?.description === 'string' ? descriptor.description : undefined,
    requiresAgent,
    parameters: Array.isArray(descriptor?.parameters) ? descriptor.parameters.map(projectParameter) : [],
    result: {
      description: typeof descriptor?.result?.description === 'string' ? descriptor.result.description : undefined,
      schema: jsonSchemaOf(descriptor?.result),
    },
    source: descriptor?.sourceLocation !== null && typeof descriptor?.sourceLocation === 'object'
      ? { file: String(descriptor.sourceLocation.file ?? ''), line: Number(descriptor.sourceLocation.line ?? 0) }
      : undefined,
  };
}

/**
 * Short description for a listing, capped at a stable length.
 * @param endpoint - projected endpoint.
 * @returns summary row.
 */
export function summarizeEndpoint(endpoint) {
  const description = typeof endpoint.description === 'string'
    ? endpoint.description.length > SUMMARY_DESCRIPTION_LIMIT
      ? `${endpoint.description.slice(0, SUMMARY_DESCRIPTION_LIMIT - 1)}…`
      : endpoint.description
    : undefined;
  return {
    endpoint: endpoint.endpoint,
    namespace: endpoint.namespace,
    method: endpoint.method,
    kind: endpoint.kind,
    requiresAgent: endpoint.requiresAgent,
    description,
  };
}

/**
 * Group projected endpoints by package.
 * @param descriptors - live Typert descriptors.
 * @returns `Map<package, projected[]>` sorted by endpoint.
 */
export function groupEndpoints(descriptors) {
  const grouped = new Map();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    const endpoint = projectEndpoint(descriptor);
    if (endpoint === undefined) continue;
    const list = grouped.get(endpoint.package);
    if (list === undefined) grouped.set(endpoint.package, [endpoint]);
    else list.push(endpoint);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  }
  return grouped;
}

/** Pick the more informative phase of two Loader rows. */
function betterPhase(left, right) {
  const leftRank = left === null || left === undefined ? 0 : PHASE_RANK[left] ?? 0;
  const rightRank = right === null || right === undefined ? 0 : PHASE_RANK[right] ?? 0;
  return rightRank > leftRank ? right : left;
}

/** Keep the first non-empty text. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Merge Loader rows and API packages into the one list the settings page and
 * the external catalog share.
 *
 * A row may exist only because some package contributes Remote methods (for
 * example a package mounted under an agent preset whose Loader row lives in a
 * separate tree); it then has no `entries`.
 *
 * @param entries - plain Loader rows:
 *   `{ package, moduleName, entryId, phase, enabled, title, description, version, icon }`.
 * @param descriptors - live Typert descriptors.
 * @returns sorted catalog rows.
 */
export function buildCatalog(entries, descriptors) {
  const rows = new Map();
  const ensure = (pkg) => {
    let row = rows.get(pkg);
    if (row === undefined) {
      row = {
        package: pkg,
        title: pkg,
        description: undefined,
        version: undefined,
        icon: undefined,
        phase: null,
        enabled: false,
        entries: [],
        endpoints: [],
      };
      rows.set(pkg, row);
    }
    return row;
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.package !== 'string' || entry.package === '') continue;
    const row = ensure(entry.package);
    row.entries.push({
      id: typeof entry.entryId === 'string' ? entry.entryId : null,
      moduleName: typeof entry.moduleName === 'string' ? entry.moduleName : entry.package,
      phase: entry.phase ?? null,
      enabled: entry.enabled !== false,
    });
    row.title = firstText(row.title === row.package ? undefined : row.title, entry.title, row.package);
    row.description = firstText(row.description, entry.description);
    row.version = firstText(row.version, entry.version);
    row.icon = firstText(row.icon, entry.icon);
    row.phase = betterPhase(row.phase, entry.phase ?? null);
    row.enabled = row.enabled || entry.enabled !== false;
  }

  for (const [pkg, endpoints] of groupEndpoints(descriptors)) {
    const row = ensure(pkg);
    row.endpoints = endpoints;
    // An API package whose Loader row is absent from this tree still counts as
    // available; the methods are registered and callable right now.
    if (row.entries.length === 0) row.enabled = true;
  }

  return [...rows.values()].sort((left, right) => {
    const byTitle = String(left.title).localeCompare(String(right.title));
    return byTitle !== 0 ? byTitle : left.package.localeCompare(right.package);
  });
}

/**
 * Whether a catalog row contributes anything a caller could invoke.
 * @param row - catalog row.
 * @returns true when at least one endpoint exists.
 */
export function hasEndpoints(row) {
  return Array.isArray(row?.endpoints) && row.endpoints.length > 0;
}

/**
 * Validate that a package/endpoint pair names one catalog endpoint.
 * @param catalog - catalog rows.
 * @param pkg - package name.
 * @param endpoint - `<namespace>/<method>`.
 * @returns matching endpoint, or undefined.
 */
export function findEndpoint(catalog, pkg, endpoint) {
  const row = catalog.find((candidate) => candidate.package === pkg);
  if (row === undefined) return undefined;
  return row.endpoints.find((candidate) => candidate.endpoint === endpoint);
}
