# 出图台 · MCP（image-booth-mcp）

让**任何支持 MCP 的 Agent 平台**都会云端出图的一个小服务。

不用显卡、不用装模型、不用下十几个 G。装上去，跟 Agent 说一句「画一张……」，图就出来。

一份代码 12 KB，零依赖，零构建。

---

## 它凭什么能装到别的平台

因为它不是某个平台的私有插件，是一个**本地 stdio MCP 服务**——Hana、Claude Desktop、Cursor、DSH，以及任何支持 MCP 的宿主，装的是同一个东西。

### 顺手回答一个问题：为什么不做成网页？

网页版最大的枷锁是 **CORS**：浏览器只能连那些主动开了跨域的厂商，能不能用取决于厂商的心情（实测：阿里云百炼和火山方舟开了，别家不一定）。

MCP 是本地进程，**没有这个限制**，能覆盖的通道反而更多。代价是它没有界面——界面就是 Agent 本身。

## 钥匙归你自己（这是全部设计的前提）

这个服务**不持有任何 API key**。key 从你那份 MCP 配置的 `env` 里读：

```
你装上   → 用你的 key、你的额度
别人装上 → 用自己的 key、自己的额度
```

没有中转服务器，没有共享密钥。所以「给别人用」这件事，是给一份配置，不是给一把钥匙。

## 装法

需要 Node 18+（自带 `fetch`）。

### Hana

在 MCP 连接器的界面里添加一个 stdio 服务（推荐）。等价的配置是：

```json
{
  "id": "image-booth",
  "name": "出图台",
  "description": "云端出图：不用 GPU、不装模型",
  "transport": "stdio",
  "command": "node",
  "args": ["<这个目录的绝对路径>/index.mjs"],
  "env": { "DASHSCOPE_API_KEY": "sk-..." },
  "enabled": true,
  "autoStart": true,
  "permissionMode": "allowlist"
}
```

Hana 会在首次连接时把工具清单填进 `tools[]`，其余字段保持默认即可。

### Claude Desktop / 其他 MCP 宿主

```json
{
  "mcpServers": {
    "image-booth": {
      "command": "node",
      "args": ["<这个目录的绝对路径>/index.mjs"],
      "env": { "DASHSCOPE_API_KEY": "sk-..." }
    }
  }
}
```

### 不落地，直接从仓库跑

```bash
npx -y github:Elysia07291207/image-booth-mcp
```

（前提是仓库已推上去。没发布到 npm 也能用，`npx github:` 直接拉仓库跑。）

## 通道与 key

| 通道 | env 变量 | 模型 |
|:--|:--|:--|
| 阿里云百炼 · 通义万相 | `DASHSCOPE_API_KEY` | `wan2.7-image-pro` / `wan2.7-image` / `qwen-image-2.0-pro` / `qwen-image-plus` |
| 火山方舟 · 豆包 Seedream | `ARK_API_KEY` | `doubao-seedream-4-5-251128` / `doubao-seedream-5-0-260128` / `doubao-seedream-4-0-250828` |

填一个就够；两个都填，两个都能用。

## 两个工具

| 工具 | 作用 |
|:--|:--|
| `image_channels` | 看认得哪些通道、哪些配了 key。**只读、不花钱**，报错先看它 |
| `image_generate` | 出图。`prompt` 必填；`provider` / `model` / `size`（`1:1` / `3:4` / `16:9`）可省；给了 `save_dir` 就顺手存本地并返回绝对路径 |

两家的请求形状不一样，所以在 `index.mjs` 里逐条写清楚了，没硬抽象成「通用格式」：

- **百炼**是任务制：先拿 `task_id`，再轮询 `/tasks/{id}`（最多等 3 分钟）
- **方舟**是 OpenAI 形状，一次请求直接回 url

## 自己手测（不用装任何平台）

这个服务说 MCP over stdio，一行一条 JSON-RPC。所以可以直接喂它：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"image_channels","arguments":{}}}' \
  | node index.mjs
```

应该看到：`initialize` 回协议版本与 serverInfo、通知**不回**、`tools/list` 回两个工具、`image_channels` 回通道表（没配 key 时 `hasKey: false`）。

## 已知与未知

- **已验证**：MCP 协议层（`initialize` / `notifications/initialized` / `tools/list` / `tools/call`）实测回执正确；未配 key 时失败干净（`isError: true` + 可照做的提示），不假装成功；两个通道的 HTTP 形状与鉴权方式按官方接口写成。
- **未验证**：一次**真实出图**。写这份代码的机器上没有可用的 key，所以没跑。如果你跑出问题，把返回里的错误原文贴出来——厂商的原话会原样透出来，模型名写错、尺寸不支持、额度不够，答案都在那行字里。

## 许可

MIT，见 [LICENSE](LICENSE)。
