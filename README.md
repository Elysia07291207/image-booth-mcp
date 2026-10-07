# 出图台 · MCP（image-booth-mcp）

让**任何支持 MCP 的 Agent 平台**都会云端出图的一个小服务。

不用显卡、不用装模型、不用下十几个 G。装上去，跟 Agent 说一句「画一张……」，图就出来。

一份代码约 14 KB，零依赖，零构建。

---

## 它凭什么能装到别的平台

因为它不是某个平台的私有插件，是一个**本地 stdio MCP 服务**——Hana、Claude Desktop、Cursor、DSH，以及任何支持 MCP 的宿主，装的是同一个东西。

### 顺手回答一个问题：为什么不做成网页？

网页版最大的枷锁是 **CORS**：浏览器只能连那些主动开了跨域的厂商，能不能用取决于厂商的心情。MCP 是本地进程，**没有这个限制**。

代价是它没有界面——界面就是 Agent 本身。

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

（没发布到 npm 也能用，`npx github:` 直接拉仓库跑。）

## 通道与环境变量

| 通道 | key 变量 | 可选 base 变量 | 模型 | 状态 |
|:--|:--|:--|:--|:--|
| 阿里云百炼 · 通义万相 / 千问图像 | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL` | `wan2.7-image-pro` / `wan2.7-image` / `qwen-image-3.0-pro` / `qwen-image-2.1-pro` | **已真调通** |
| 火山方舟 · 豆包 Seedream | `ARK_API_KEY` | `ARK_BASE_URL` | `doubao-seedream-4-5-251128` / `doubao-seedream-5-0-260128` / `doubao-seedream-4-0-250828` | 形状按官方接口写，尚未真调 |

填一个就够；两个都填，两个都能用。

`DASHSCOPE_BASE_URL` 不填时用通用的 `https://dashscope.aliyuncs.com/api/v1`。如果你的 key 属于某个**业务空间**，百度一下就知道该填什么，形如：

```
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
```

## 两个工具

| 工具 | 作用 |
|:--|:--|
| `image_channels` | 看认得哪些通道、哪些配了 key。**只读、不花钱**，报错先看它 |
| `image_generate` | 出图，返回直链；给了 `save_dir` 就顺手存本地并返回绝对路径 |

### `image_generate` 参数

| 参数 | 说明 |
|:--|:--|
| `prompt` | **必填**，正向提示词 |
| `negative_prompt` | 反向提示词（不想出现什么）。dashscope 支持 |
| `provider` | `dashscope` / `ark`，省略则自动选 |
| `model` | 省略用该通道第一个 |
| `size` | `1:1` / `3:4` / `16:9`，或直接给像素 `1024*1024`。默认 `1:1` |
| `n` | 张数，1~4，默认 1 |
| `watermark` | 是否要厂商水印，默认 `false` |
| `thinking` | dashscope 的深度思考模式，更慢通常更贴提示词，默认不开 |
| `save_dir` | 把图存到这个目录（不存在会自动建） |

## 自己手测（不用装任何平台）

这个服务说 MCP over stdio，一行一条 JSON-RPC，可以直接喂它：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"image_channels","arguments":{}}}' \
  | node index.mjs
```

## 排错：看到这些错误码意味着什么

服务会把厂商的原始回话**原样**带出来，另外附一行「接下来该干什么」。常见的几种：

| 你看到的 | 真正的意思 | 怎么办 |
|:--|:--|:--|
| `Arrearage` | 账号在这条链路上被判欠费 / 余额为 0，且免费额度已用尽 | 去控制台看余额，充值或换一个还有额度的模型 |
| `AccessDenied.Unpurchased` | 这个模型在账号下**没开通** | 换一个已开通的模型，或去控制台开通它 |
| `InvalidParameter: url error` | 端点或请求形状写错了（老版 `text2image/image-synthesis` + `input.prompt` 会踩这个） | 本服务已改用 `image-generation/generation` + `input.messages`；自己拼请求时照抄 `index.mjs` 里那段 |
| `AllocationQuota.FreeTierOnly` | 你开了「免费额度用完即停」，额度见了底 | 关掉它（会开始按量计费），或等额度刷新 |

## 已知与未知

**已验证**

- MCP 协议层（`initialize` / `notifications/initialized` / `tools/list` / `tools/call`）回执正确；未配 key 时失败干净（`isError: true` + 可照做的提示），不假装成功。
- **dashscope 通道真出过图**：`wan2.7-image-pro` / `1024*1024` / 约 22 秒 / 1.6 MB，返回直链并能落盘。
- 端点形状以真调用为准，不是照文档抄的：`POST /services/aigc/image-generation/generation`，body 用 `input.messages`，图在 `output.choices[].message.content[]` 里标 `type:"image"`。

**未验证**

- `ark`（火山方舟）通道：请求形状按官方接口写，手上没有 key，没真跑过。
- `3:4` / `16:9` 两档画幅：像素值取自常见支持范围，未逐一实测。写错的话厂商会明说，原文会透给你。

## 许可

MIT，见 [LICENSE](LICENSE)。
