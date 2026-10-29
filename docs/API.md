# dsh-plugins-bridge HTTP API

All routes live under `/plugins-bridge` on the `dsh-host-webserver` listener
(the Web GUI origin, for example `http://127.0.0.1:3080`).

Two prefixes serve different callers:

| Prefix | Caller | Authentication |
|---|---|---|
| `/plugins-bridge/api` | the Settings page in the DSH Web UI | loopback + authenticated DSH browser session |
| `/plugins-bridge/v1` | external editors and scripts | loopback + bearer token |

Every response is `application/json; charset=utf-8` with
`cache-control: no-store`. Every request must originate from a loopback socket;
a non-loopback peer receives `403 loopback-only` before routing.

## External API (`/v1`)

### Discovery

#### `GET /plugins-bridge/v1`

Public. Returns bridge identity, enablement, the authentication scheme, and the
route list.

```json
{
  "ok": true,
  "bridge": { "name": "dsh-plugins-bridge", "version": "0.1.0", "apiVersion": 1 },
  "enabled": true,
  "authentication": "Bearer token in Authorization: Bearer <token>",
  "endpoints": {
    "plugins": "/plugins-bridge/v1/plugins",
    "plugin": "/plugins-bridge/v1/plugin?package=<name>",
    "agents": "/plugins-bridge/v1/agents",
    "invoke": "/plugins-bridge/v1/invoke",
    "routes": "/plugins-bridge/v1/routes",
    "http": "/plugins-bridge/v1/http/<route-group>/<path>",
    "tools": "/plugins-bridge/v1/tools",
    "toolInvoke": "/plugins-bridge/v1/tools/invoke"
  }
}
```

#### `GET /plugins-bridge/v1/health`

Public. Same shape as `/v1` without the route list. Useful as a liveness probe.

A `?lang=zh|en` query parameter selects localized plugin titles and
descriptions; the default is `zh`.

### Authentication

Send the token from **Settings → Plugins Bridge**:

```http
Authorization: Bearer <token>
```

`X-Bridge-Token: <token>` is accepted for clients that cannot set
`Authorization`. A missing or wrong token returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="dsh-plugins-bridge"

{ "ok": false, "error": { "code": "unauthorized", "message": "..." } }
```

A wrong `content-type` on a POST returns `415 unsupported-media-type`. A body
larger than 8 MiB returns `413 body-too-large`.

### List exposed plugins

#### `GET /plugins-bridge/v1/plugins`

Returns every exposed package that currently has a callable endpoint. Endpoint
entries are summaries; fetch `/plugin` for full parameter and result schemas.

```json
{
  "ok": true,
  "bridge": { "name": "dsh-plugins-bridge", "version": "0.1.0", "apiVersion": 1 },
  "plugins": [
    {
      "package": "@deepseek-ai/dsh-commands",
      "title": "Commands",
      "description": "Human-command registry.",
      "version": "0.2.1-rc.2",
      "phase": "active",
      "enabled": true,
      "endpointCount": 2,
      "endpoints": [
        {
          "endpoint": "commands/execute",
          "namespace": "commands",
          "method": "execute",
          "kind": "unary",
          "requiresAgent": "agentId",
          "description": "Parse and execute a known command without sending it to the model."
        },
        {
          "endpoint": "commands/list",
          "namespace": "commands",
          "method": "list",
          "kind": "unary",
          "requiresAgent": "agentId",
          "description": "List the effective immutable command descriptors for one agent."
        }
      ]
    }
  ]
}
```

An empty `plugins` array means the bridge is enabled but nothing is selected, or
no selected package currently contributes a unary endpoint.

### Read one plugin

#### `GET /plugins-bridge/v1/plugin?package=<name>[&endpoint=<namespace/method>]`

Requires the package to be exposed. Without `endpoint`, returns the plugin with
**full** endpoint descriptors:

```json
{
  "ok": true,
  "package": "@deepseek-ai/dsh-commands",
  "title": "Commands",
  "version": "0.2.1-rc.2",
  "phase": "active",
  "enabled": true,
  "selected": true,
  "entries": [
    { "id": "include:commands", "moduleName": "@deepseek-ai/dsh-commands", "phase": "active", "enabled": true }
  ],
  "endpointCount": 2,
  "endpoints": [
    {
      "package": "@deepseek-ai/dsh-commands",
      "endpoint": "commands/list",
      "namespace": "commands",
      "method": "list",
      "kind": "unary",
      "description": "List the effective immutable command descriptors for one agent.",
      "requiresAgent": "agentId",
      "parameters": [
        {
          "name": "agent",
          "wire": "agentId",
          "required": false,
          "source": "lookup",
          "description": "exact receiving agent and scoped-layer key.",
          "schema": { "type": "string" }
        }
      ],
      "result": {
        "description": "name-sorted descriptors after scoped shadowing.",
        "schema": { "type": "array", "items": { "type": "object" } }
      },
      "source": { "file": "packages/interaction/commands/src/index.ts", "line": 420 }
    }
  ]
}
```

With `endpoint`, the response carries the plugin summary plus a single
`endpoint` object.

- `package` is absent from the catalog → `404 unknown-package`.
- The endpoint is absent → `404 unknown-endpoint`.
- The package is not exposed → `404 package-not-exposed`.

### List live sessions

#### `GET /plugins-bridge/v1/agents`

Lists live Agents so a caller can pass a valid `agentId` to scoped endpoints or
tools.

```json
{
  "ok": true,
  "agents": [
    { "id": "session-…", "status": "running", "cwd": "/home/me/project" }
  ]
}
```

`status` is the Agent's live status (`idle`, `running`, …). `cwd` is the
Session's working directory when known, otherwise `null`.

### Invoke an endpoint

#### `POST /plugins-bridge/v1/invoke`

```json
{
  "package": "@deepseek-ai/dsh-commands",
  "endpoint": "commands/list",
  "args": { "agentId": "session-…" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `package` | yes¹ | Exposed npm package name. |
| `endpoint` | yes | `<namespace>/<method>` from discovery. |
| `args` | no | Named wire arguments, matching the descriptor's `wire` fields. Defaults to `{}`. |

¹ `package` may be omitted when exactly one exposed package provides the
endpoint. `endpoint` may also be written as `"<package>#<namespace>/<method>"`.

Success:

```json
{
  "ok": true,
  "package": "@deepseek-ai/dsh-commands",
  "endpoint": "commands/list",
  "result": [ { "name": "compact", "description": "…" } ]
}
```

The call runs through `ctx.typertGateway.invoke()` with an `owner` peer. The
gateway validates the descriptor's named arguments, resolves `agentId` through
the live Agent lookup, injects cancellation, and validates the result codec.
The bridge then projects the result onto JSON (bytes become base64, `bigint`
becomes a string, cycles become `"[Circular]"`, and huge arrays/objects are
bounded).

Failures use the standard error envelope:

```json
{ "ok": false, "error": { "code": "unknown-endpoint", "message": "…", "field": "endpoint" } }
```

Common codes:

| Code | HTTP | Meaning |
|---|---:|---|
| `bridge-disabled` | 503 | The bridge is switched off in Settings. |
| `package-not-exposed` | 403 | The package is not in the allowlist. |
| `unknown-package` | 404 | No live package by that name. |
| `unknown-endpoint` | 404 | No live descriptor for that package + endpoint. |
| `stream-unsupported` | 501 | The endpoint is a stream method. |
| `invalid-arguments` | 400 | `args` is not a JSON object. |
| `package-required` | 400 | The endpoint is ambiguous across exposed packages. |
| `unauthorized` | 401 | Missing or invalid token. |
| `gateway/*` | 400–503 | The Host Gateway rejected the call (validation, unavailable service, or method). |

Business errors thrown by the method are reported with their own code and a
5xx status; the bridge does not reinterpret them.

**Timeouts.** A Remote call is aborted after 120 seconds or when the client
disconnects.

### List HTTP route groups

#### `GET /plugins-bridge/v1/routes`

Lists every route group discovered on `dsh-host-webserver`, including groups
that are not selected. `selected` says whether group calls are currently
allowed.

```json
{
  "ok": true,
  "routes": [
    {
      "id": "mcp-manager-plus",
      "title": "MCP Manager",
      "package": "dsh-mcp-manager-plus",
      "thirdParty": true,
      "selected": true,
      "kinds": ["prefix"],
      "prefixes": true,
      "routeCount": 1,
      "paths": ["/mcp-manager-plus"]
    },
    {
      "id": "dsh-session-manager",
      "title": "dsh-session-manager",
      "package": "dsh-session-manager",
      "thirdParty": true,
      "selected": false,
      "kinds": ["exact"],
      "prefixes": false,
      "routeCount": 8,
      "paths": ["/dsh-session-manager/delete", "/dsh-session-manager/pause", "…"]
    }
  ]
}
```

A group is attributed to a package by its top-level path segment. Unmatched
groups have `package: null` and `thirdParty: false` (DSH built-in); they are
selectable only after "Show DSH built-in routes" is enabled in Settings.

### Proxy an HTTP route

#### `ANY /plugins-bridge/v1/http/<route-group>/<path>`

Forwards the request to the matching registered route after checking that the
group is selected. The method, headers, request body, and response are passed
through unchanged; only `req.url` is rewritten to the target path. The target
route's own checks still run — loopback, method, body, and (when it uses
`ctx.connection.requestRejection`) the DSH browser session.

```sh
# Session Manager (exact routes)
curl -s -X POST "$BASE/http/dsh-session-manager/delete" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"session-…"}'

# MCP Manager (prefix route)
curl -s "$BASE/http/mcp-manager-plus/servers" \
  -H "Authorization: Bearer $TOKEN"
```

Only paths under a selected group are forwarded. The bridge rejects its own
prefix, and `findRoute` uses the same exact → longest-prefix order as the Web
server. Upgrade (WebSocket) routes are not proxied.

| Code | HTTP | Meaning |
|---|---:|---|
| `route-not-exposed` | 403 | The route group is not in `exposedRoutes`. |
| `recursive-route` | 403 | The target is the bridge's own `/plugins-bridge` prefix. |
| `missing-route-path` | 400 | `/v1/http` was called without a target path. |
| `route-not-found` | 404 | No registered route matches the target path. |

If the target route itself returns an error (401 for a missing browser session,
405 for a method mismatch, 400 for its own body validation), that response is
passed through unchanged.

### Agent tools

Agent tools are disabled by default; enable **Expose agent tools** in Settings.

#### `GET /plugins-bridge/v1/tools[?agentId=<session>]`

Without `agentId`, lists globally visible tools. With `agentId`, lists the tools
that exact session can see (including scoped registrations and restrictions).

```json
{
  "ok": true,
  "agentId": "session-…",
  "tools": [
    {
      "name": "working_directory",
      "description": "Read the current working directory, or change it with cd.",
      "parameters": { "type": "object", "properties": { "cd": { "type": "string" } } }
    }
  ]
}
```

#### `POST /plugins-bridge/v1/tools/invoke`

```json
{
  "name": "working_directory",
  "arguments": {},
  "agentId": "session-…"
}
```

```json
{
  "ok": true,
  "isError": false,
  "value": { "cwd": "/home/me/project" },
  "content": [ { "type": "text", "text": "/home/me/project" } ]
}
```

| Code | HTTP | Meaning |
|---|---:|---|
| `tools-not-exposed` | 403 | Agent tools are switched off. |
| `unknown-tool` | 404 | No visible tool by that name. |
| `unknown-agent` | 404 | `agentId` names no live session. |
| `missing-tool-name` | 400 | `name` is empty. |

A tool that fails normally returns **HTTP 200** with `ok:false`,
`isError:true`, and the tool's structured error/content; only routing and
authorization failures use non-2xx statuses. Tools run with the bridge caller's
Host authority; interactive approvals still apply and may fail without a
browser answerer. Tool calls have a 10-minute budget.

## Management API (`/api`)

The Settings page uses these routes. They require loopback **and** the
authenticated DSH browser session — the same signed cookie that protects the
Web UI — because they return the bearer token and can invoke endpoints. They are
not an external API; use `/v1` from editors and scripts.

They are documented here because they are useful for debugging an authenticated
page and for building another in-app UI.

| Route | Method | Purpose |
|---|---|---|
| `/plugins-bridge/api/state` | GET | Full state: catalog, route groups, stats, config, token, agents, tools. |
| `/plugins-bridge/api/plugin?package=…` | GET | Full endpoint schemas for one package. |
| `/plugins-bridge/api/config` | POST | Replace enablement/allowlist/tools; optionally regenerate the token. |
| `/plugins-bridge/api/test` | POST | Invoke one exposed endpoint with the management handler (no token). |

`POST /api/config` accepts:

```json
{
  "enabled": true,
  "exposedPackages": ["@deepseek-ai/dsh-commands"],
  "exposedRoutes": ["mcp-manager-plus", "dsh-session-manager"],
  "exposeTools": false,
  "regenerateToken": false
}
```

Every field is optional; omitted fields keep their current value. The response
is the new state. `exposedRoutes` holds route-group ids from `GET /v1/routes`.
Regenerating the token immediately revokes old clients.

Writes require `content-type: application/json`; a browser `Origin` must match
the request `Host`. A request without the DSH browser cookie receives
`401 unauthorized`; a cross-site or untrusted authority receives
`403 forbidden`.

## Editor examples

### Emacs Lisp

```elisp
(defvar dsh-bridge-token (or (getenv "DSH_BRIDGE_TOKEN")
                             (read-string "DSH bridge token: ")))

(defun dsh-bridge-call (package endpoint args)
  "Invoke ENDPOINT of PACKAGE through dsh-plugins-bridge."
  (let* ((token dsh-bridge-token)
         (url "http://127.0.0.1:3080/plugins-bridge/v1/invoke")
         (payload (json-encode `((package . ,package)
                                 (endpoint . ,endpoint)
                                 (args . ,args))))
         (url-request-method "POST")
         (url-request-extra-headers
          `(("content-type" . "application/json")
            ("authorization" . ,(concat "Bearer " token))))
         (url-request-data payload))
    (with-current-buffer (url-retrieve-synchronously url)
      (goto-char url-http-end-of-headers)
      (json-parse-buffer))))
```

For a package whose descriptor declares `requiresAgent`, pass
`'((agentId . "session-…"))` as `args`; get a live id from
`GET /v1/agents`.

### Vimscript

```vim
function! DshBridgeInvoke(package, endpoint, args) abort
  let token = $DSH_BRIDGE_TOKEN
  if empty(token)
    throw 'dsh-plugins-bridge: set $DSH_BRIDGE_TOKEN from Settings first'
  endif
  let body = json_encode({'package': a:package, 'endpoint': a:endpoint, 'args': a:args})
  let cmd = ['curl', '-sS', '-X', 'POST',
        \ 'http://127.0.0.1:3080/plugins-bridge/v1/invoke',
        \ '-H', 'authorization: Bearer ' . token,
        \ '-H', 'content-type: application/json',
        \ '-d', body]
  return json_decode(join(systemlist(cmd), ''))
endfunction
```

Copy the token from **Settings → Plugins Bridge** into `DSH_BRIDGE_TOKEN` (or
your editor's secret store) once; do not re-read the config file on every call.

### Shell

See [Quick start](../README.md#quick-start) and the `curl` examples above.
