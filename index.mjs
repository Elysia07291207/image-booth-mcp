#!/usr/bin/env node
/**
 * image-booth-mcp —— 出图台 · MCP（本地 stdio 服务）
 * =====================================================================
 * 它是什么：一个可以被**任何支持 MCP 的 Agent 平台**装上的出图工具。
 *   · Hana  → 当作 MCP 连接器装（transport: stdio + command + env）
 *   · 其他平台（Claude Desktop / Cursor / DSH …）→ 各自 MCP 配置里加一条同样的东西
 * 同一份代码，装哪儿都行。这不是 Hana 私有插件，是通用件。
 *
 * 为什么是 MCP 而不是网页：
 *   网页版最大的枷锁是 **CORS** —— 浏览器只能连那些开了跨域的厂商。
 *   MCP 是本地进程，没有这个限制，能覆盖的通道反而更多。
 *   代价是它没有界面：界面就是 Agent 本身。
 *
 * 钥匙归使用者（这是全部设计的前提）：
 *   本进程不持有任何 key。key 从**你自己那份 MCP 配置的 env** 里读，
 *   也就是说：你装就用你的额度，别人装就用别人的。谁也不用替谁付钱。
 *
 * 零依赖、零构建。只有两个工具：
 *   image_channels —— 看这个进程认得哪些通道、哪几个配了钥匙
 *   image_generate —— 出图
 *
 * 已验证的通道（2026-10-08 实测其 HTTP 形状与鉴权方式）：
 *   dashscope  阿里云百炼 / 通义万相 —— 异步任务制：先拿 task_id，再轮询
 *   ark        火山方舟 / 豆包 Seedream —— OpenAI 形状，直接回 url
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const VERSION = "0.1.0";
const NAME = "image-booth-mcp";

/* ── 通道 ─────────────────────────────────────────────────────────────
   每一家的请求形状都不一样，所以逐条写清楚，不硬抽象成"通用格式"。 */

const PROVIDERS = {
  dashscope: {
    label: "阿里云百炼 · 通义万相",
    envKey: "DASHSCOPE_API_KEY",
    models: ["wan2.7-image-pro", "wan2.7-image", "qwen-image-2.0-pro", "qwen-image-plus"],
    sizes: { "1:1": "1024*1024", "3:4": "720*1280", "16:9": "1280*720" },
    async generate(ctx) {
      const { key, model, size, prompt } = ctx;
      const base = "https://dashscope.aliyuncs.com/api/v1";
      const res = await fetch(base + "/services/aigc/text2image/image-synthesis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify({ model, input: { prompt }, parameters: { size, n: 1 } }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error("提交失败 HTTP " + res.status + "：\n" + text);
      const taskId = (JSON.parse(text).output || {}).task_id;
      if (!taskId) throw new Error("没拿到 task_id：\n" + text);

      // 百炼是任务制的：票在手里要自己去取，最多等 3 分钟
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r2 = await fetch(base + "/tasks/" + encodeURIComponent(taskId), {
          headers: { Authorization: "Bearer " + key },
        });
        const t2 = await r2.text();
        if (!r2.ok) throw new Error("查询失败 HTTP " + r2.status + "：\n" + t2);
        const d2 = JSON.parse(t2);
        const st = (d2.output || {}).task_status;
        if (st === "SUCCEEDED") {
          const url = ((d2.output.results || [])[0] || {}).url;
          if (!url) throw new Error("成功但没给图：\n" + t2);
          return url;
        }
        if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
          throw new Error("厂商说 " + st + "：\n" + t2);
        }
      }
      throw new Error("等了 3 分钟仍未完成，task_id = " + taskId);
    },
  },

  ark: {
    label: "火山方舟 · 豆包 Seedream",
    envKey: "ARK_API_KEY",
    models: ["doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128", "doubao-seedream-4-0-250828"],
    sizes: { "1:1": "1024x1024", "3:4": "864x1152", "16:9": "1344x768" },
    async generate(ctx) {
      const { key, model, size, prompt } = ctx;
      const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ model, prompt, size, response_format: "url" }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status + "：\n" + text);
      const d = JSON.parse(text);
      const url = (((d.data || [])[0]) || {}).url;
      if (!url) throw new Error("返回里没有图：\n" + text);
      return url;
    },
  },
};

function keyOf(id) {
  const v = process.env[PROVIDERS[id].envKey];
  return typeof v === "string" ? v.trim() : "";
}
function readyProviders() {
  return Object.keys(PROVIDERS).filter((id) => keyOf(id));
}

/* ── 工具 ──────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "image_channels",
    description:
      "看这个出图服务认得哪些云端通道、每个通道有哪些模型/画幅、以及**哪几个真的配了 API key**。" +
      "只读，不出图、不花钱。换通道或报 key 相关错误时先调它。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "image_generate",
    description:
      "用云端通道出一张图，返回图片直链；给了 save_dir 就顺手存到本地并返回绝对路径。" +
      "不需要本机 GPU、不装模型——这就是它的意义。" +
      "通道与模型可省：只有一个通道配了 key 就用它，多的话按顺序取第一个能用的。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正向提示词（必填）" },
        provider: { type: "string", description: "通道 id：dashscope（通义万相）/ ark（豆包 Seedream）。省略则自动选。" },
        model: { type: "string", description: "模型 id；省略用该通道第一个。" },
        size: { type: "string", description: "画幅：1:1 / 3:4 / 16:9。省略用 1:1。" },
        save_dir: { type: "string", description: "可选：把图存到这个目录（必须已存在），返回绝对路径。" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "image_channels") {
    const channels = Object.keys(PROVIDERS).map((id) => ({
      id,
      label: PROVIDERS[id].label,
      env: PROVIDERS[id].envKey,
      hasKey: Boolean(keyOf(id)),
      models: PROVIDERS[id].models,
      sizes: Object.keys(PROVIDERS[id].sizes),
    }));
    return {
      ready: channels.filter((c) => c.hasKey).map((c) => c.id),
      note: readyProviders().length
        ? "有通道可用。"
        : "一个通道都没配。请在 MCP 配置的 env 里填 DASHSCOPE_API_KEY 或 ARK_API_KEY，然后重启这个服务。",
      channels,
    };
  }

  if (name === "image_generate") {
    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt 是必填的");

    const sizeKey = String(args?.size || "1:1");
    if (!["1:1", "3:4", "16:9"].includes(sizeKey)) throw new Error("size 只认 1:1 / 3:4 / 16:9");

    let id = String(args?.provider || "").trim();
    if (id && !PROVIDERS[id]) throw new Error("没有这个通道：" + id + "（有：" + Object.keys(PROVIDERS).join(" / ") + "）");
    if (!id) {
      const ready = readyProviders();
      if (!ready.length) {
        throw new Error(
          "没有任何通道配好 key。请在 MCP 配置的 env 里填 DASHSCOPE_API_KEY 或 ARK_API_KEY。（先调 image_channels 看现状）"
        );
      }
      id = ready[0];
    }
    const p = PROVIDERS[id];
    const key = keyOf(id);
    if (!key) throw new Error("通道 " + id + " 没有 key：env 里缺 " + p.envKey);

    const model = String(args?.model || p.models[0]);
    const size = p.sizes[sizeKey] || p.sizes["1:1"];

    const t0 = Date.now();
    const url = await p.generate({ key, model, size, prompt });
    const ms = Date.now() - t0;

    const out = { ok: true, url, provider: id, providerLabel: p.label, model, size, size_key: sizeKey, elapsed_ms: ms };

    const saveDir = String(args?.save_dir || "").trim();
    if (saveDir) {
      const res = await fetch(url);
      if (!res.ok) throw new Error("图拿到了但下载失败 HTTP " + res.status + "：" + url);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp)$/i) || [, "png"])[1].toLowerCase();
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const file = path.join(saveDir, `image_${stamp}_${Math.random().toString(36).slice(2, 7)}.${ext}`);
      fs.writeFileSync(file, buf);
      out.saved_path = file;
      out.bytes = buf.length;
    }
    return out;
  }

  throw new Error("没有这个工具：" + name);
}

/* ── MCP over stdio（JSON-RPC，一行一条） ───────────────────────────── */

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(method, params) {
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params?.name;
      try {
        const data = await callTool(name, params?.arguments || {});
        // 出图成功时，人先看一行摘要，完整结构跟在后面——省得 Agent 从 JSON 里挖链接
        const head =
          name === "image_generate"
            ? `已出图 · ${data.providerLabel} / ${data.model} / ${data.size} · ${(data.elapsed_ms / 1000).toFixed(1)}s\n${data.url}` +
              (data.saved_path ? `\n已存到：${data.saved_path}` : "")
            : "";
        return {
          content: [{ type: "text", text: (head ? head + "\n\n" : "") + JSON.stringify(data, null, 2) }],
        };
      } catch (e) {
        // 厂商原文原样带出：模型名写错、尺寸不支持、额度不够，答案都在那行字里
        return { content: [{ type: "text", text: "出图失败：" + (e?.message || e) }], isError: true };
      }
    }
    default:
      throw new Error("不支持的方法：" + method);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return; // 不是 JSON 就丢掉，别把 stdin 弄崩
  }
  if (msg.id === undefined || msg.id === null) return; // 通知，不需要回
  handle(msg.method, msg.params).then(
    (result) => send({ jsonrpc: "2.0", id: msg.id, result }),
    (err) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message || err) } })
  );
});

process.stderr.write(
  `[${NAME} v${VERSION}] 就绪。已配 key 的通道：${readyProviders().join(", ") || "（无）"}\n`
);
