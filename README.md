# dsh-plugins-bridge

A local HTTP bridge for **DeepSeek Harness** Web plugins. It lets external
programs — Emacs, Vim, shell scripts, or anything that can send HTTP — discover
the APIs of installed plugins and invoke them, without speaking Harness's
browser Remote protocol.

The bridge is a DSH bundle:

- **Host half** (`index.js`) registers two loopback route prefixes on
  `@deepseek-ai/dsh-host-webserver` and projects the live plugin catalog from
  `ctx.typert.local` and the Cordis Loader.
- **Client half** (`client.js`) adds **Settings → Plugins Bridge**, where you
  choose which plugins are exposed, manage the bearer token, and inspect every
  endpoint's JSON Schema.

English | [中文](README.zh.md)

## What it exposes

| Surface | Description |
|---|---|
| **Plugin APIs** | Every unary `@Remote` method of a selected package, discovered at request time from the same generated reflection the Web UI uses. Grouped by npm package, with parameter/result JSON Schemas, descriptions, and `agentId` requirements. |
| **Plugin information** | Loader entry ids, module specifiers, fiber phase, enablement, package version, and display metadata for every installed plugin. |
| **Agent tools** (optional) | The Host's model-facing tools (`read`, `grep`, `subagent`, MCP tools, …), listed and invoked through `ctx.tools`, optionally scoped to a live session. |

Packages without generated Typert reflection contribute no callable API; they
still appear in the catalog with their Loader information. Streaming methods
are listed but not bridged yet.

## Requirements

- DeepSeek Harness **Web** profile (desktop is intentionally out of scope).
- `@deepseek-ai/dsh-host-webserver`, `typert`, `typertGateway`, `connection`,
  `loader`, `tools`, and `agents` services — all part of the shipped Web
  composition.
- Node.js 20+ (the project uses only Node built-ins at runtime).

## Install

From this checkout, install the directory as a bundle in the active profile:

```sh
plugin_manager install_bundle /absolute/path/to/dsh-plugins-bridge
```

Or install the directory through the Plugins page. The package declares its
bundle patch in `cordis.patch.yml` and its browser half under `dsh.client`, so
no build step is required.

After installation the bridge is **enabled by default but exposes no plugins**.
Open **Settings → Plugins Bridge**, select the packages to expose, and press
**Save**.

## Quick start

The settings page shows the exact base URL and token. In a shell:

```sh
TOKEN='<token from Settings>'
BASE='http://127.0.0.1:3080/plugins-bridge/v1'

curl -s "$BASE/plugins" -H "Authorization: Bearer $TOKEN"
```

Invoke the plugin-inventory API:

```sh
curl -s "$BASE/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"package":"@deepseek-ai/dsh-host-plugin-inventory",
       "endpoint":"pluginInventory/list",
       "args":{}}'
```

Invoke a session-scoped API by passing the `agentId` the descriptor declares:

```sh
curl -s "$BASE/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"package":"@deepseek-ai/dsh-commands",
       "endpoint":"commands/list",
       "args":{"agentId":"session-..."}}'
```

List and run an agent tool:

```sh
curl -s "$BASE/tools?agentId=session-..." -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/tools/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"working_directory","arguments":{},"agentId":"session-..."}'
```

Full route reference, error codes, and editor examples:
[docs/API.md](docs/API.md).

## Security model

- **Loopback only.** The handler rejects any request whose peer is not
  `127.0.0.0/8`, `::1`, or a mapped form of either.
- **Bearer token.** Every `/v1` route except discovery (`/v1`, `/v1/health`)
  requires `Authorization: Bearer <token>` (or `X-Bridge-Token`). The token is
  24 random bytes, persisted with mode `0600`, and can be regenerated from the
  settings page.
- **Explicit allowlist.** Only packages selected in Settings can be invoked.
  The allowlist is enforced on every call, not just during discovery.
- **Owner authority.** Calls run through `ctx.typertGateway` with an
  `owner` peer — the same authority the browser UI has. Exposing a package
  grants exactly its Remote API, including destructive methods, to any local
  program with the token.
- **Authenticated management API.** `/plugins-bridge/api` requires a valid
  signed DSH browser-session cookie in addition to loopback, so a local process
  without that session cannot read the token or invoke through the management
  routes. Writes also require `content-type: application/json` and an `Origin`
  matching `Host`.
- **No CORS headers.** Browser pages from other origins cannot read responses.
- **Two trust boundaries.** The browser settings page uses the management
  prefix; external programs use `/v1` with the bearer token. Neither prefix
  weakens the other.

Treat the token like a password. The bridge adds no rate limiting and no TLS
listener; `dsh-host-webserver` already binds to the configured local address.

## Configuration

The bridge stores its state in one JSON file:

```
$DSH_HOME/profiles/<profile>/plugins-bridge.json   # when a profile is known
$DSH_HOME/plugins-bridge.json                      # otherwise
```

`DSH_PROFILE` wins when set; otherwise the profile is inferred from the
Loader's base URL. The file is mode `0600` and contains:

```json
{
  "version": 1,
  "enabled": true,
  "token": "…",
  "exposedPackages": ["@deepseek-ai/dsh-commands"],
  "exposeTools": false
}
```

Changes made in Settings take effect immediately and are written atomically.
Editing the file by hand takes effect on the next plugin reload.

## Limitations

- **Unary methods only.** Stream methods are listed with `"kind": "stream"`
  and returned as `501 stream-unsupported`.
- **Reflection-based.** A package is callable only when it ships the generated
  `./typert` artifact and the `typert-loader` has registered it. Plugins that
  only register Cordis services or bespoke HTTP routes are not callable through
  this bridge (they remain visible in the inventory).
- **No per-endpoint allowlist.** Selecting a package exposes all its unary
  endpoints. Use the package-level choice deliberately.
- **Agent tools have no plugin attribution.** The tools surface is a single
  built-in capability, not grouped by the package that registered each tool.
- **Tool approvals still apply.** A tool that needs interactive approval can
  fail when no browser answerer is available.
- **Web only.** Desktop uses a different transport and is out of scope.

## Development

```sh
npm test          # node:test unit + fake-host integration tests
npm run check     # syntax-check the host and client modules
```

The tests cover configuration parsing/persistence, loopback and origin
classification, manifest and display resources, JSON-safe result projection,
catalog merging, HTTP routing, bearer auth, management-session rejection,
invocation, and agent-tool execution against a fake Cordis context. They do not
boot DSH.

Host code is loaded once per module generation. After editing `index.js` or
`lib/*`, reload the plugin or restart `dsh web`; HMR does not replace an
already-loaded Host module.

Architecture and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT.
