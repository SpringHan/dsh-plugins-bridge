# dsh-plugins-bridge

面向 **DeepSeek Harness** Web 插件的本地 HTTP 桥接。它让 Emacs、Vim、脚本等
任何能发 HTTP 请求的外部程序发现并调用已安装插件的 API，而无需理解 Harness
浏览器端的 Remote 协议。

本项目本身就是一个 DSH bundle：

- **Host 端**（`index.js`）通过 `@deepseek-ai/dsh-host-webserver` 注册两个回环
  路由前缀，并从 `ctx.typert.local` 与 Cordis Loader 实时投影插件目录。
- **Client 端**（`client.js`）在 **设置 → 插件桥接** 中添加管理页：选择要暴露
  的插件、管理访问令牌、查看每个接口的 JSON Schema。

[English](README.md) | 中文

## 暴露的内容

| 能力 | 说明 |
|---|---|
| **插件 API** | 所选 npm 包的全部一元 `@Remote` 方法。每次请求都从 Web UI 所用的同一份生成反射中实时发现，按包分组，附带参数/返回 JSON Schema、说明和 `agentId` 要求。 |
| **插件信息** | 每个已安装插件的 Loader entry id、模块说明符、Fiber 阶段、启用状态、包版本与展示元数据。 |
| **Agent 工具**（可选） | Host 的模型工具（`read`、`grep`、`subagent`、MCP 工具等），通过 `ctx.tools` 列出与执行，可绑定到活动会话。 |

没有生成 Typert 反射的包不贡献可调用 API，但仍会带着 Loader 信息出现在目录中。
流式方法会被列出，但暂不桥接。

## 环境要求

- DeepSeek Harness **Web** profile（按项目约定不考虑 desktop）。
- `@deepseek-ai/dsh-host-webserver`、`typert`、`typertGateway`、`connection`、
  `loader`、`tools`、`agents` 服务；正式 Web 组合均包含。
- Node.js 20+（运行时只使用 Node 内置模块）。

## 安装

在活动 profile 中把本目录作为 bundle 安装：

```sh
plugin_manager install_bundle /absolute/path/to/dsh-plugins-bridge
```

也可以通过插件页面安装该目录。包在 `cordis.patch.yml` 中声明 bundle patch，
在 `dsh.client` 中声明浏览器端，无需构建步骤。

安装后桥接**默认启用，但不暴露任何插件**。打开 **设置 → 插件桥接**，勾选要暴露
的包并点击**保存**。

## 快速开始

设置页会显示实际的基础 URL 与令牌。在 shell 中：

```sh
TOKEN='<设置页中的令牌>'
BASE='http://127.0.0.1:3080/plugins-bridge/v1'

curl -s "$BASE/plugins" -H "Authorization: Bearer $TOKEN"
```

调用插件清单 API：

```sh
curl -s "$BASE/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"package":"@deepseek-ai/dsh-host-plugin-inventory",
       "endpoint":"pluginInventory/list",
       "args":{}}'
```

带会话的 API 传入描述符声明的 `agentId`：

```sh
curl -s "$BASE/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"package":"@deepseek-ai/dsh-commands",
       "endpoint":"commands/list",
       "args":{"agentId":"session-..."}}'
```

列出并执行 Agent 工具：

```sh
curl -s "$BASE/tools?agentId=session-..." -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/tools/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"working_directory","arguments":{},"agentId":"session-..."}'
```

完整路由、错误码与编辑器示例见 [docs/API.md](docs/API.md)。

## 安全模型

- **仅回环。** 对端不是 `127.0.0.0/8`、`::1` 或其映射形式时直接拒绝。
- **Bearer 令牌。** 除发现接口（`/v1`、`/v1/health`）外，所有 `/v1` 路由都要求
  `Authorization: Bearer <token>`（或 `X-Bridge-Token`）。令牌为 24 字节随机数，
  以 `0600` 权限持久化，可在设置页重新生成。
- **显式白名单。** 只有设置中勾选的包才能调用；每次调用都校验，而不仅是发现时。
- **Owner 权限。** 调用通过 `ctx.typertGateway` 以 `owner` peer 执行，与浏览器 UI
  权限相同。暴露某个包就等于把该包的全部 Remote 能力（包括破坏性方法）交给任何
  拿到令牌的本地程序。
- **管理接口需要 DSH 浏览器会话。** 除回环外，`/plugins-bridge/api` 还要求有效的
  DSH 签名浏览器 Cookie；没有该会话的本地进程无法读取令牌或通过管理接口调用。
  写请求还必须使用 `content-type: application/json`，且 `Origin` 与 `Host` 匹配。
- **不返回 CORS 头。** 其它源的浏览器页面无法读取响应。
- **两条信任边界。** 设置页走管理前缀；外部程序走 `/v1` 的 Bearer 令牌，互不削弱。

请像对待密码一样对待令牌。桥接不提供限流或 TLS；监听地址由
`dsh-host-webserver` 配置决定。

## 配置

状态保存在一个 JSON 文件中：

```
$DSH_HOME/profiles/<profile>/plugins-bridge.json   # 能识别 profile 时
$DSH_HOME/plugins-bridge.json                      # 否则
```

设置了 `DSH_PROFILE` 时优先使用；否则从 Loader 的 base URL 推断。文件权限为
`0600`，内容如下：

```json
{
  "version": 1,
  "enabled": true,
  "token": "…",
  "exposedPackages": ["@deepseek-ai/dsh-commands"],
  "exposeTools": false
}
```

设置页的修改立即生效并原子写回；手工编辑文件则在下次插件重载时生效。

## 限制

- **仅一元方法。** 流式方法标记为 `"kind": "stream"`，调用返回
  `501 stream-unsupported`。
- **基于反射。** 只有导出生成 `./typert` 产物并由 `typert-loader` 注册的包才可调用。
  仅注册 Cordis 服务或自定义 HTTP 路由的插件不会出现在可调用目录中（但仍显示在
  插件清单里）。
- **无接口级白名单。** 勾选一个包会暴露其全部一元接口，请谨慎选择。
- **Agent 工具没有插件归属。** 工具是单独的内置能力，不按注册它的包分组。
- **工具审批仍然生效。** 需要交互审批的工具在没有浏览器应答者时可能失败。
- **仅 Web。** Desktop 使用不同传输方式，不在范围内。

## 开发

```sh
npm test          # node:test 单元 + 伪 Host 集成测试
npm run check     # 语法检查 Host 与 Client 模块
```

测试覆盖配置解析/持久化、回环与 Origin 判定、清单与展示资源、JSON 安全投影、
目录合并、HTTP 路由、Bearer 认证、管理会话拒绝、调用与 Agent 工具执行；不会真正
启动 DSH。

Host 代码每个模块代际只加载一次。修改 `index.js` 或 `lib/*` 后需要重载插件或重启
`dsh web`；HMR 不会替换已加载的 Host 模块。

架构与设计决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

MIT。
