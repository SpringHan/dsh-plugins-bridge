# dsh-plugins-bridge 架构

本文档描述 `dsh-plugins-bridge` 的实际结构、运行时数据流、安全边界与设计取舍。
项目修改后必须同步更新本文档。

## 1. 目标与非目标

### 目标

1. 为 DSH Web 端已安装的其它插件提供一个**稳定的本地 HTTP 出口**，供 Emacs、
   Vim、脚本等外部程序读取插件信息并执行插件能力。能力包括 Typert `@Remote`
   API、插件注册在 `dsh-host-webserver` 上的自定义 HTTP 路由，以及可选的 Agent 工具。
2. 通过 `dsh-host-webserver` 注册路由，不另起 HTTP 服务。
3. 在 DSH 设置中提供管理页，让用户显式选择要暴露的插件、管理访问令牌，并查看
   接口的 JSON Schema。
4. 只暴露用户选中的包；默认不暴露任何插件。

### 非目标

- 不支持 desktop / Electron。
- 不代理流式 Remote 方法（SSE/WebSocket）；后续可扩展。
- 不代理 WebSocket/Upgrade 路由，也不做任意外部 URL 的通用反向代理；HTTP 路由代理仅限
  已发现并已选中的插件路由组。
- 不提供 TLS、用户体系、限流或公网访问；这些属于 `dsh-host-webserver` 和部署层。
- 不尝试推断某个 Agent 工具由哪个插件注册（DSH 工具注册表不携带所有者信息）。

## 2. 运行时组成

```
dsh-plugins-bridge/
├── package.json          # bundle + dsh.client 声明
├── cordis.patch.yml      # 向 profile 插入 plugins-bridge 行
├── index.js              # Host 端：路由、目录投影、调用
├── client.js             # Client 端：设置页
├── lib/
│   ├── config.js         # 配置路径、校验、原子持久化
│   ├── catalog.js        # 纯投影：Descriptor + Loader → 插件目录
│   ├── routes.js         # 纯投影：WebServer 路由表 → 可选路由组/归属
│   └── http.js           # 回环/Origin/令牌/JSON 投影/请求体
├── locale/{en,zh}.json   # 插件管理器的展示元数据
├── icon.svg              # 插件图标
└── docs/
    ├── API.md            # 对外 HTTP 契约
    └── ARCHITECTURE.md   # 本文
```

Host 与 Client 是两个独立入口：

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，Loader 挂载
  `dsh-plugins-bridge` 包，执行 `index.js` 的 `apply`。
- `package.json` 的 `dsh.client` 声明 `platform: web`、`immediately: true` 和依赖
  的 Client 模块；`@deepseek-ai/dsh-client-modules` 把 `./client` 导出作为浏览器端
  lazy factory 提供给 Web shell。

## 3. Host 启动与依赖注入

`index.js` 导出 `apply(ctx)`，内部使用**作用域注入**而不是静态 `inject`：

```js
export const inject = [];

export function apply(ctx) {
  ctx.inject(
    ['webServer', 'typert', 'typertGateway', 'connection', 'loader', 'tools', 'agents'],
    (scope) => activate(scope),
  );
}
```

原因：

- 正式 Web 组合中部分服务（Gateway、Connection、WebServer）在启动顺序上较晚
  出现；静态 `inject` 会让插件停在 pending，或在服务替换后不再重新激活。
- `ctx.inject` 的回调在依赖全部可用时执行，并把路由、effect 绑定到该子作用域；
  任一依赖卸载时路由随之清理，服务恢复时重新激活。

`activate` 完成四件事：

1. 解析配置路径，读取/初始化配置，首次使用时生成令牌并落盘。
2. 构造目录读取函数（Loader 行 + Typert 描述符）。
3. 构造管理 API 与外部 API 的请求处理器。
4. 用 `ctx.effect(() => ctx.webServer.register(...))` 注册唯一的
   `/plugins-bridge` 前缀路由。

## 4. 插件目录与 API 投影

目录不是缓存，也不是第二份注册表：**每个请求都从运行中的 Host 重建**。

### 4.1 Loader 行

`readEntryRows(lang)` 遍历 `ctx.loader.entries()`：

- 跳过 `options.group` 的结构组行。
- `moduleName` 取 `entry.options.name`。
- 包名优先通过可选服务 `pluginPackages.packageOf(module, entry.ctx.baseUrl)`
  解析；服务缺失或解析失败时，用 `guessPackageName()` 粗粒度截断。
- 展示标题/描述通过 `pluginPackages.metaOf(...)` + `pickLocalized(lang)` 读取；
  失败时保留包名。
- `phase` 取 `entry.fiber?.state`；`enabled` 取 `!entry.disabled`；entry id 取
  `entry.id`。所有 getter 都做了防御，避免一个坏行拖垮整次请求。

### 4.2 Typert 描述符

`ctx.typert.local.list()` 返回当前已注册的生成式 Remote 描述符。每个描述符的
`id` 形如：

```
<package>#<namespace>/<method>
```

`lib/catalog.js` 用 `id` 的 `#` 前缀确定包归属，这是把“插件功能”归属于“插件包”
的关键：不依赖工具名猜测，也不扫描源码。

`projectEndpoint(descriptor)` 投影为稳定结构：

| 字段 | 来源 |
|---|---|
| `package` | `id` 的 `#` 前缀 |
| `endpoint` | `namespace/method` |
| `kind` | `mode === 'stream' ? 'stream' : 'unary'` |
| `description` | 描述符 JSDoc |
| `requiresAgent` | `scope.context === 'agent'` 时的 `scope.wire`（通常是 `agentId`） |
| `parameters[]` | `name`、`wire`、`required`（`acceptsUndefined !== true`）、`source`、`description`、JSON Schema |
| `result` | 结果描述与 JSON Schema |
| `source` | 生成源文件与行号（仅诊断） |

JSON Schema 优先取 `strictCodec.jsonSchema`，其次 `codec.jsonSchema`；缺失时为
`null`，设置页显示为 `json`。

### 4.3 合并

`buildCatalog(entries, descriptors)`：

1. 按包名合并 Loader 行。同一包的多个 entry（子路径、嵌套 Includes）合并且保留
   `entries[]`；`phase` 取“最活跃”的阶段（active > loading > pending >
   unloading > failed > disposed）；`enabled` 为逻辑或。
2. 合并 API 包。仅在预设树中挂载、宿主 Loader 没有对应行的包也会生成一条
   “API-only” 行，`entries: []`、`enabled: true`。
3. 按标题、再按包名排序。

结果行同时用于设置页和外部目录。管理状态只返回**接口摘要**（名称、类型、是否
需要 agent、截断描述）；展开某插件时再调用 `/api/plugin` 获取**完整 schema**，
避免一次状态响应过大。

### 4.4 为什么不用 Agent 工具做插件归属

DSH 的 `ToolDefinition` 不携带注册者信息，`ctx.tools.register` 也没有所有者参数。
把工具按插件分组只能靠栈回溯或事后猴子补丁，既脆弱又会在 HMR/预设切换时失真。
因此本项目采用两条明确的能力线：

- **插件 API**：按 Typert 包归属，可精确到包。
- **Agent 工具**：作为单一内置能力整体开关，调用时可选绑定 `agentId`。

这一取舍写入 README 的限制章节，避免向用户暗示不存在的归属关系。

### 4.5 插件 HTTP 路由组

部分第三方插件不生成 Typert 反射，而是直接调用
`ctx.webServer.register({kind:'exact'|'prefix', path, handler})`。`lib/routes.js`
在每次请求时读取 WebServer 的 `exact` / `prefixes` 两张 Map，投影为“路由组”：

1. 用路径首段作为组 id（`/dsh-session-manager/delete` → `dsh-session-manager`）。
2. 排除桥接自己的 `/plugins-bridge` 前缀与根路径 `/`。
3. 用首段与目录中的包名做启发式匹配：
   - 完全相等（含去掉 `dsh-` 前缀后的形式）→ 100 分；
   - 包名以 `<segment>-` 开头或以 `-<segment>` 结尾 → 80 分；短于 4 字符的段不做
     前后缀匹配，避免 `api` 之类的误归属；
   - 取最高分；无匹配则 `package: null`、`system: true`。
4. 组字段包括 `id`、`title`、`package`、`thirdParty`、`system`、`selected`、
   `routeCount`、`kinds`、`prefixes`、`paths`。
5. 第三方组排在前面；设置页默认只显示第三方组，DSH 内置路由需手动显示。

`thirdParty` 的判定是包名不以 `@deepseek-ai/` 开头、不是 `cordis:` builtin、也不是
`dsh-plugins-bridge` 自己。这样社区 npm/GitHub 插件（`dsh-session-manager`、
`dsh-mcp-manager-plus`、`dsh-whale-widget` 等）会出现在设置页；没有匹配到路由的
第三方插件仍显示在插件清单中（若开启“显示全部”）。

路由发现依赖 WebServer 的运行时字段，而不是公开 API；所有读取都做了 `instanceof
Map` 与形状检查，未来版本改名时退化为“没有路由组”，不会让桥接加载失败。

## 5. 配置与持久化

`lib/config.js` 负责：

- 路径解析：`resolveConfigPath(env, profileHint)`
  - `DSH_PROFILE` 优先；
  - 否则 `profileFromBaseUrl(baseUrl)` 从 Loader base URL 的
    `/profiles/<name>/` 推断；
  - 都没有时落在 `$DSH_HOME/plugins-bridge.json`。
  - Web 进程通常不导出 `DSH_PROFILE`，所以 base URL 推断是实际路径的主要来源。
- `normalizeConfig()`：严格白名单字段；包名长度/字符集校验；去重；上限 500；
  非法令牌置空，交由启动流程重新生成。
- `loadConfigSync()`：文件缺失返回默认值；损坏/不可读返回默认值 + 诊断，保证
  桥接不会因为自身状态文件损坏而无法启动。
- `saveConfigSync()`：先写同目录临时文件（`0600`），再 rename；Windows 等
  rename 失败场景回退为直接写。目录以 `0700` 创建。
- `maskToken()`：设置页默认只显示首 6 位与末 4 位。

文件格式（版本 1）：

```json
{
  "version": 1,
  "enabled": true,
  "token": "<48 hex>",
  "exposedPackages": ["@scope/pkg"],
  "exposedRoutes": ["mcp-manager-plus"],
  "exposeTools": false
}
```

`exposedRoutes` 的每个值是一个路由组 id（路径首段），经长度/字符集校验、去重，
最多 200 个；未知组保留在文件中但不会命中任何路由。

配置写入后立即替换闭包中的 `config` 对象，后续请求立即生效；不依赖 Loader 重载。

## 6. HTTP 层

### 6.1 路由

整个桥接只注册一条前缀路由：

```js
ctx.webServer.register({ kind: 'prefix', path: '/plugins-bridge', handler })
```

`handle()` 先做回环校验，再按路径分发：

| 路径 | 方法 | 处理 |
|---|---|---|
| `/plugins-bridge/api/state` | GET | 管理状态 |
| `/plugins-bridge/api/plugin` | GET | 单插件完整 schema |
| `/plugins-bridge/api/config` | POST | 修改配置/令牌 |
| `/plugins-bridge/api/test` | POST | 用管理通道试调用 |
| `/plugins-bridge/v1`、`/v1/health` | GET | 公开发现 |
| `/plugins-bridge/v1/plugins` | GET | 已暴露插件摘要 |
| `/plugins-bridge/v1/plugin` | GET | 单插件完整 schema |
| `/plugins-bridge/v1/agents` | GET | 活动会话 |
| `/plugins-bridge/v1/routes` | GET | 所有已发现的路由组及 `selected` 状态 |
| `/plugins-bridge/v1/http/...` | ANY | 把请求转发给已选路由组中的目标路由 |
| `/plugins-bridge/v1/tools` | GET | 工具列表 |
| `/plugins-bridge/v1/invoke` | POST | 调用 Remote |
| `/plugins-bridge/v1/tools/invoke` | POST | 调用工具 |

未匹配路径返回 404；路径存在但方法不符返回 405 并带 `allow` 头。

### 6.2 安全判定顺序

1. `isLoopbackRequest(req)`：根据 `req.socket.remoteAddress` 判断，支持 IPv4、
   IPv6、IPv4-mapped 的点分/十六进制写法与 zone id。失败 → 403。
2. 管理路径：先用 `ctx.connection.requestRejection({headers})` 复用 DSH 自身的
   Host/Origin 校验与签名浏览器 Cookie 认证；没有会话 → 401，不可信来源 → 403。
   随后 POST 必须 `content-type: application/json`（强制浏览器预检）；有 `Origin`
   时必须与 `Host` 完全一致。失败 → 403/415。
3. 外部路径：`/v1` 与 `/v1/health` 之外，`config.enabled` 必须为真，且
   bearer token 与配置常量时间比较。失败 → 503/401。
4. 业务校验：包是否在白名单、端点是否存在、是否流式、参数是否对象。
5. HTTP 路由代理：目标路径的首段必须在 `exposedRoutes` 中；目标必须是已注册路由
   （exact 优先、最长前缀）；禁止代理 `/plugins-bridge` 自身。目标路由随后执行它
   自己的鉴权、方法与请求体检查。

### 6.3 请求与响应

- 请求体上限 8 MiB；空体视为 `{}`；只接受 JSON 对象（数组/标量拒绝）。
- 响应统一 `application/json; charset=utf-8`、`cache-control: no-store`、
  显式 `content-length`。
- 结果经 `safeJson()` 投影：`bigint` → 字符串、二进制 → base64、`Date` →
  ISO、`Error` → `{name,message}`、循环 → `"[Circular]"`、深度/数组/键数量
  有界，避免不可序列化值或超大对象破坏响应。
- 调用超时：Remote 120 秒，Agent 工具 600 秒；客户端断开通过 `aborted` 事件
  触发 `AbortController`。
- 错误统一为 `{ok:false,error:{code,message,field?}}`；未知异常折叠为 500
  `internal-error`，不返回堆栈。

## 7. 调用链

### 7.1 Remote 插件 API

```
POST /v1/invoke
  → 白名单 / 端点 / 参数校验
  → ctx.typert.local.get(endpoint) 并核对 descriptor.id === `${package}#${endpoint}`
  → ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  → ctx.typertGateway.invoke({ namespace, method, args, peer, signal })
  → 结果 safeJson
  → finally peer.dispose()
```

采用 `typertGateway` 而不是直接反射调用 Service 方法的原因：

- 它执行与浏览器 UI 相同的严格参数校验、`agentId` 查找、上下文注入、取消与结果
  codec。
- 描述符的 `scope.wire`（如 `agentId`）由 Gateway 解析为活动 Agent，
  外部调用方只需传字符串 id。
- peer 使用 `owner` 身份；白名单是授权边界。

每个请求创建并销毁一个 peer，避免跨请求累积 peer 作用域内的注册。

### 7.2 Agent 工具

```
POST /v1/tools/invoke
  → config.exposeTools
  → ctx.agents.get(agentId)（可选）
  → ctx.tools.get(name, agent) 可见性校验
  → ctx.tools.execute({ callId, name, arguments, agent, signal })
  → {ok, isError, value, content, error, meta}
```

工具错误是**业务结果**，因此返回 HTTP 200 + `ok:false`；路由/授权错误才使用
非 2xx。工具执行仍受 DSH 的审批、沙箱与超时策略约束。

### 7.3 插件 HTTP 路由代理

```
ANY /v1/http/<group>/<path>
  → 首段是否在 exposedRoutes
  → 禁止 /plugins-bridge 自身（防递归）
  → ctx.webServer.exact / prefixes 查找同一套 exact → longest-prefix 路由
  → 校验 routeSegment(route.path) === group
  → 保存 req.url，改写为目标 path + 原 query
  → await route.handler(req, res)   // body、method、headers、响应所有权保持原样
  → finally 恢复 req.url
```

选择直接调用目标 handler，而不是发起内部 HTTP 请求，原因：

- 请求体是单次流；内部转发需要重新编码/解码，容易破坏插件自定义格式（multipart、
  原始文本）。
- 目标 handler 拥有完整响应生命周期（包括 SSE/长连接）。
- 目标路由自身的回环、浏览器会话、方法、请求体检查仍然执行；桥接令牌不替代它们。

代价：目标路由仍可能因为缺少 DSH 浏览器 Cookie 而返回 401。设置页明确提示这一点。

## 8. 设置页（Client 端）

`client.js` 使用 Web shell 的 lazy-CJS 协议：

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugins-bridge',
  factory(require) { /* 返回 {name, inject, apply} */ },
});
```

- 只依赖模块表中的 `react`，不导入任何 Harness Client UI 包，避免与产品内部
  组件耦合。
- `inject: ['slots']` 是**声明式**的：空 `inject` 列表下 `ctx.get('slots')` 即使
  服务已存在也可能读到 `undefined`，声明后 `apply` 执行时服务必然就绪。
- 在 `ctx.effect` 中调用
  `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, BridgePage))`，
  注册 id `plugins-bridge`、order 36、动态本地化 label。
- 若存在 `locale` 服务：注册 `{zh, en}` 字典，订阅语言变化，页面与导航标签随之
  更新；没有 locale 服务时退回内置字典。
- 页面状态分为：
  - `state`：服务端事实（目录、配置、令牌、统计）。
  - `draft`：内存编辑（enabled、exposeTools、selected Set）。
  - `dirty`：两者结构比较；保存按钮只在有差异时可用。
- 保存调用 `POST /api/config`，成功后以响应覆盖 state/draft 并清空展开详情。
- 页面结构是“内部滚动内容区 + 固定页脚”：`.dpb-root` 填充设置内容区，`.dpb-scroll`
  承载标题、卡片并自行滚动，`.dpb-foot` 作为 flex 尾部固定在面板底部（不再使用
  `position: sticky`，避免浮在内容中间或留下底部空隙）。滚动区的直接子项使用
  `flex: 0 0 auto`，否则 flex 会压缩卡片、由 `overflow: hidden` 裁掉卡片正文，表现为
  “页面不能滚动/内容被截断”。页脚显示未保存状态与保存
  按钮；主按钮使用 `--dsw-alias-button-primary-fill` 与
  `--dsw-alias-label-primary-foreground`，在明暗主题下都有对比度。所有按钮使用
  `inline-flex`，图标与文字保持同一行。
- 发放新令牌会先确认，且与当前草稿一起保存，避免“保存草稿”覆盖新令牌。
- 样式用 `<style>` 渲染在组件树内，卸载即移除；颜色只使用
  `--dsw-alias-*` 主题令牌，自动适配明暗主题。
- 插件行默认显示有 Typert API 的包，以及有 HTTP 路由的第三方包；可切换“显示全部”
  来查看其余 Loader 行。
- 独立的“插件 HTTP 接口”卡片列出路由组：默认只显示第三方组，可显示 DSH 内置组；
  勾选后写入 `draft.selectedRoutes`，与包选择一起保存。
- 没有 Typert API 但有路由的插件行会显示“无 Typert API；HTTP 路由在下方选择”及
  路由数量。
- 展开行按需请求 `/api/plugin`，展示参数 wire 名、类型、必填性、描述和返回
  schema。令牌默认遮罩，可显示/复制/重新生成；基础 URL、配置文件路径均可复制。

## 9. 安全模型与威胁

| 威胁 | 缓解 |
|---|---|
| 局域网其它主机访问 | 仅接受回环 socket；`dsh-host-webserver` 默认也绑定回环。 |
| 本机其它用户/程序 | `/v1` 需要令牌；管理接口需要 DSH 签名浏览器 Cookie。配置文件 `0600`；令牌可重新生成。 |
| 恶意网页 CSRF 管理接口 | 管理接口要求 DSH 浏览器会话；写请求强制 JSON content-type（触发预检）；Origin 与 Host 必须一致；无 CORS 头。 |
| 恶意网页读取外部接口 | 无 CORS 头，浏览器无法读取；令牌也不在页面 URL 中。 |
| 越权调用未选插件 | 每次调用都校验 `exposedPackages`，并核对描述符真实包名。 |
| 越权代理未选 HTTP 路由 | 每次调用都校验 `exposedRoutes` 与目标路径首段；禁止代理桥接自身。 |
| 目标路由鉴权被绕过 | 直接调用目标 handler，保留其回环/会话/方法/请求体检查；不注入浏览器 Cookie。 |
| 结果不可序列化/过大 | 有界 `safeJson`；请求体 8 MiB 上限；调用超时。 |
| 令牌泄漏 | 设置页默认遮罩；文档提示不要提交；可一键重新生成。 |

明确不防：拿到令牌的本地进程、能读取设置页的浏览器扩展、拥有 Host 进程权限的
攻击者。`owner` 权限意味着桥接不提供细粒度的只读/写权限划分；需要更细粒度时，
应把配置、审批和沙箱策略放在 DSH 侧。

## 10. 限制与后续方向

当前限制：

- 仅一元方法；流式方法需新增 SSE/WebSocket 承载。
- 依赖生成式 Typert 反射；没有 `./typert` 导出且没有自定义路由的插件不可调用。
- HTTP 路由发现依赖 WebServer 的 `exact` / `prefixes` 运行时字段；改名则退化为无路由。
- HTTP 路由归属按路径首段启发式匹配；未匹配组只能通过“显示 DSH 内置路由”手动选择。
- 仅代理 HTTP 路由，不代理 Upgrade/WebSocket 路由。
- 目标路由若要求 DSH 浏览器会话，外部调用会得到目标自己的 401；桥接不注入会话。
- 包/路由组级白名单，没有接口级或参数级策略。
- Agent 工具无插件归属。
- 无调用审计日志、无速率限制、无 OpenAPI 文档生成。

可扩展方向：

1. 流式接口：按 descriptor 的 `mode: 'stream'` 提供 NDJSON/SSE。
2. 接口级白名单：配置从 `string[]` 升级为 `{package, endpoints?}[]`，保留旧格式
   迁移。
3. 审计与限流：记录调用方、端点、耗时、结果码（不记录参数敏感值）。
4. OpenAPI 3.1：从已投影的 JSON Schema 生成，方便编辑器自动补全。
5. 自定义路由桥：允许插件在 manifest 中声明额外的 HTTP 能力，由本桥统一鉴权与
   发现。

## 11. 测试与验证

- `test/config.test.js`：路径推断、字段校验、令牌、原子写、损坏恢复、掩码。
- `test/http.test.js`：回环地址、Origin、Bearer、常量时间比较、请求体解析、
  `safeJson`、本地化选择。
- `test/catalog.test.js`：包/端点身份、schema 提取、agent scope、分组、合并、
  排序、查询。
- `test/routes.test.js`：路由表读取、exact/最长前缀查找、首段解析、第三方判定、
  包归属、桥接自身/根路径排除、系统组。
- `test/host.test.js`：用伪 Cordis Context 启动 Host 端，覆盖管理状态、回环拒绝、
  公开健康检查、401、配置保存、真实调用路径（伪 Gateway）、未暴露/流式/未知端点、
  包名省略、跨源管理写、工具开关与执行、405/404、完整 schema 详情；以及路由组
  发现/配置、`/v1/routes`、`/v1/http` 的 exact/前缀转发、请求体透传、未选/递归/
  缺路径拒绝。

实际运行环境验证（2026-10-29，Web profile）：

- 安装 bundle 后 `/plugins-bridge/v1/health` 正常；`/api/state` 在无浏览器会话时
  返回 401，符合加固后的管理接口契约；
- 目录发现 25 个 API 包、130 个端点；
- 通过 `/v1/invoke` 成功调用
  `@deepseek-ai/dsh-host-plugin-inventory#pluginInventory/list`（198 条 Loader 行）
  与 `@deepseek-ai/dsh-commands#commands/list`（传入活动 `agentId`）；
- 通过 `/v1/tools/invoke` 成功执行 `working_directory`，返回会话 cwd；
- 通过 `plugin_manager` 禁用/启用触发模块替换后，新 Host 代码生效；`/v1/routes`
  实时发现 7 个路由组，其中 3 个正确归属为第三方插件：`dsh-session-manager`
  （8 条）、`dsh-whale`（23 条）、`mcp-manager-plus`（1 条）；
- 临时暴露 `mcp-manager-plus` 与 `dsh-session-manager` 后：
  `/v1/http/mcp-manager-plus/servers` 返回 200 与 MCP 服务器列表；
  `/v1/http/dsh-session-manager/trash` 返回 200；
  `/v1/http/dsh-session-manager/stats` 返回目标路由自己的 400（缺少 session id），
  证明请求体/方法/目标校验均按原样执行；未暴露的 `dsh-whale` 返回 403，
  递归代理 `/plugins-bridge` 返回 403。验证后已恢复默认配置（未暴露任何包/路由）；
- 设置页的 `settings.section` occupant `plugins-bridge` 处于 active；插件清单返回
  了本插件的中英文标题、描述与 SVG 图标；Client 端新增的路由卡片需要刷新页面后
  才会加载新 bundle；
- 管理接口的 `requestRejection` 浏览器会话校验与拒绝路径由伪 Host 测试覆盖，
  并已在运行实例上确认无会话时返回 401；实际页面点击流程尚未验证；
- 视觉渲染（明暗主题、实际布局）尚未通过浏览器控制验证；本环境没有已认证的
  Web 浏览器控制通道。2026-10-29 根据用户提供的截图修复了顶部按钮换行、主按钮
  白底白字、保存位置和滚动问题（固定页脚 + 内部滚动内容区 + 子项禁止 flex 收缩）；
  修复后的实际渲染仍需用户刷新 Settings 页面确认。
- 验证使用当前 profile 的配置路径 `$DSH_HOME/profiles/web/plugins-bridge.json`；
  早期实例写入的 `$DSH_HOME/plugins-bridge.json` 已不再读取。

## 12. 文件职责速查

| 文件 | 职责 |
|---|---|
| `index.js` | 激活、目录读取、路由分发、配置更新、Remote/工具调用、错误处理 |
| `lib/config.js` | 配置路径推断、规范化、读写、令牌生成/掩码 |
| `lib/catalog.js` | 纯函数：描述符投影、分组、Loader 行合并、查询 |
| `lib/routes.js` | 纯函数：WebServer 路由表读取、路由组归属、exact/前缀查找 |
| `lib/http.js` | 回环/Origin/Bearer 判定、JSON 响应、请求体、`safeJson` |
| `client.js` | 设置页、locale、草稿/保存、接口详情、样式 |
| `cordis.patch.yml` | 向 profile 插入 `plugins-bridge` 行 |
| `package.json` | bundle/client 声明、导出、文件清单 |
| `docs/API.md` | 对外 HTTP 契约与编辑器示例 |

## 13. 关键设计决策

1. **以 Typert 包为授权单位，而不是以工具名为单位。**
   描述符 id 自带包名，天然可归属；工具注册表没有所有者信息。这样既避免脆弱的
   栈回溯，又让“选择插件”真正对应“调用该包的 API”。
2. **每次请求实时投影，而不是缓存目录。**
   DSH 插件会随 profile、预设、HMR 动态挂载/卸载；缓存需要失效协议。当前规模
   （约 200 行、130 端点）重建成本可接受。
3. **配置文件而非插件 Config 行。**
   管理页需要在运行中即时修改，且不应触发插件重载；独立 JSON 文件支持原子写、
   首次令牌生成和损坏恢复，避免把秘密写进 `cordis.patch.yml`。
4. **管理 API 与外部 API 分离。**
   浏览器页面走管理前缀，并复用 DSH 的签名浏览器会话；外部程序走令牌前缀。两类
   调用者的信任模型不同，混用会让页面必须持有管理令牌或让外部调用获得 CSRF 豁免。
   仅凭回环地址不足以区分“本机用户”，因此管理接口不能只做回环检查。
5. **工具能力整体开关。**
   在无法准确归属的前提下，逐插件选择工具会造成错误承诺；整体开关 + 可选
   `agentId` 是诚实且可用的折中。
6. **在 Typert 之外增加 HTTP 路由适配。**
   社区插件大量使用自定义 HTTP 路由；只做 Typert 会让设置页只剩官方插件。路由组
   适配让这些插件可见、可选，同时保留目标路由自身的鉴权。读取 WebServer 私有 Map
   是刻意接受的风险，已用类型/形状守卫与降级处理控制。
7. **自包含 Client UI。**
   只依赖 `react` 与 `settings.section`，不导入产品内部组件，降低 DSH 版本升级
   造成的破坏面；代价是样式需要自行维护。

## 14. 运维与修改注意事项

- **Host 端代码修改需要重载插件或重启 Web 进程。** 当前 profile 的 HMR 不会替换
  已加载的 Host 模块；安装新 bundle 会激活，但替换同一个包的 JS 需要新的模块
  代际。
- **Client 端修改**由 `dsh-client-modules` 提供 bundle 路由；开发时需确认页面
  刷新后拿到新产物。仅“slot 已注册”不能证明新代码已渲染。
- **修改配置格式**必须保留 `normalizeConfig` 的向后兼容：未知字段丢弃、版本号
  保留、旧文件缺失字段取默认值。
- **修改路由路径**属于 composition 级契约；`webServer.register` 对重复前缀抛错，
  需同步更新设置页、文档与测试。
- **不要移除回环检查或令牌检查**；即使 `dsh-host-webserver` 绑定回环，浏览器
  仍然可以从任意网页发起请求，管理写接口的 Origin/JSON 约束是必要的第二层。
