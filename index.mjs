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
 * 通道（形状均以真调用为准，不是照文档抄的）：
 *   dashscope  阿里云百炼 · 通义万相 / 千问图像
 *     异步任务制：POST 拿 task_id → 轮询 /tasks/{id} → 图在 output.choices[].message.content[]
 *     ★ 2026-10-08 真调通：wan2.7-image-pro / 1024*1024 / 约 22s / 1.6MB
 *     ★ 端点必须是 /services/aigc/image-generation/generation + input.messages；
 *       老的 /services/aigc/text2image/image-synthesis + input.prompt 会回 400 url error
 *     ★ base_url 可用 env DASHSCOPE_BASE_URL 覆盖（业务空间专属域名形如
 *       https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1），
 *       不配就用通用的 dashscope.aliyuncs.com（维护中但可用）
 *   ark        火山方舟 · 豆包 Seedream —— OpenAI 形状，直接回 url（尚未真调过，无 key）
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const VERSION = "0.2.0";
const NAME = "image-booth-mcp";

/* ── 通道 ─────────────────────────────────────────────────────────────
   每一家的请求形状都不一样，所以逐条写清楚，不硬抽象成"通用格式"。 */

const PROVIDERS = {
  dashscope: {
    label: "阿里云百炼 · 通义万相 / 千问图像",
    envKey: "DASHSCOPE_API_KEY",
    envBase: "DASHSCOPE_BASE_URL",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    models: ["wan2.7-image-pro", "wan2.7-image", "qwen-image-3.0-pro", "qwen-image-2.1-pro"],
    sizes: { "1:1": "1024*1024", "3:4": "720*1280", "16:9": "1280*720" },

    async generate(ctx) {
      const { key, model, size, prompt, negative, n, watermark, thinking } = ctx;
      const base = (process.env[PROVIDERS.dashscope.envBase] || "").trim() || PROVIDERS.dashscope.baseUrl;

      const parameters = { size, n, watermark: watermark === true };
      if (thinking === true) parameters.thinking_mode = true;

      const payload = {
        model,
        input: {
          messages: [{ role: "user", content: [{ text: prompt }] }],
        },
        parameters,
      };
      if (negative) payload.input.negative_prompt = negative;

      const res = await fetch(base + "/services/aigc/image-generation/generation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(describeDashscopeError(res.status, text));

      const taskId = (JSON.parse(text).output || {}).task_id;
      if (!taskId) throw new Error("没拿到 task_id：\n" + text);

      // 百炼是任务制的：票在手里要自己去取。前 5 次密一点，之后放缓，最多等 4 分钟。
      for (let i = 0; i < 70; i++) {
        await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 4000));
        const r2 = await fetch(base + "/tasks/" + encodeURIComponent(taskId), {
          headers: { Authorization: "Bearer " + key },
        });
        const t2 = await r2.text();
        if (!r2.ok) throw new Error("查询失败 HTTP " + r2.status + "：\n" + t2);
        const out = (JSON.parse(t2).output) || {};
        const st = out.task_status;
        if (st === "SUCCEEDED") {
          // 图在 output.choices[].message.content[] 里，数组元素用 type:"image" 标出来
          const parts = (((out.choices || [])[0] || {}).message || {}).content || [];
          const urls = parts
            .filter((p) => p && (p.type === "image" || p.image))
            .map((p) => p.image || p.url)
            .filter(Boolean);
          if (!urls.length) throw new Error("成功但没给图：\n" + t2);
          return urls;
        }
        if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
          throw new Error("厂商说 " + st + "：" + (out.message || out.code || "") + "\n" + t2);
        }
      }
      throw new Error("等了约 4 分钟仍未完成，task_id = " + taskId);
    },
  },

  ark: {
    label: "火山方舟 · 豆包 Seedream",
    envKey: "ARK_API_KEY",
    envBase: "ARK_BASE_URL",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128", "doubao-seedream-4-0-250828"],
    sizes: { "1:1": "1024x1024", "3:4": "864x1152", "16:9": "1344x768" },

    async generate(ctx) {
      const { key, model, size, prompt, watermark } = ctx;
      const base = (process.env[PROVIDERS.ark.envBase] || "").trim() || PROVIDERS.ark.baseUrl;
      const res = await fetch(base + "/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model,
          prompt,
          size,
          response_format: "url",
          watermark: watermark === true,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status + "：\n" + text);
      const d = JSON.parse(text);
      const urls = (d.data || []).map((x) => x && x.url).filter(Boolean);
      if (!urls.length) throw new Error("返回里没有图：\n" + text);
      return urls;
    },
  },
};

/* 把厂商的原始回话翻成"接下来该干什么"，但原文一律保留 —— 答案都在那行字里 */
function describeDashscopeError(status, text) {
  let code = "";
  try {
    code = JSON.parse(text).code || "";
  } catch {
    /* 不是 JSON 就算了，原文照样透出 */
  }
  const hint =
    /Arrearage/i.test(code)
      ? "\n→ 这个账号在这条链路上被判为欠费/不可用：先去百炼控制台确认余额与开通状态。"
      : /AccessDenied\.Unpurchased|Unpurchased/i.test(code)
        ? "\n→ 这个模型在账号下没开通：换一个已开通的模型，或去控制台开通它。"
        : /InvalidParameter/i.test(text)
          ? "\n→ 参数被拒：模型名、尺寸或参数组合写错了，对照上面的原文改。"
          : "";
  return "提交失败 HTTP " + status + "：" + hint + "\n" + text;
}

function keyOf(id) {
  const v = process.env[PROVIDERS[id].envKey];
  return typeof v === "string" ? v.trim() : "";
}
function readyProviders() {
  return Object.keys(PROVIDERS).filter((id) => keyOf(id));
}
/* 尺寸：认三个比例别名，也直接收 "1024*1024" / "1280x720" 这种具体像素 */
function resolveSize(p, sizeKey) {
  if (p.sizes[sizeKey]) return p.sizes[sizeKey];
  if (/^\d+\s*[*x×]\s*\d+$/.test(sizeKey)) {
    const n = sizeKey.replace(/\s/g, "");
    return p === PROVIDERS.ark ? n.replace(/[*×]/, "x") : n.replace(/[x×]/, "*");
  }
  return null;
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
      "用云端通道出一张图（可多张），返回图片直链；给了 save_dir 就顺手存到本地并返回绝对路径。" +
      "不需要本机 GPU、不装模型——这就是它的意义。" +
      "通道与模型可省：只有一个通道配了 key 就用它，多的话按顺序试，第一个成功的返回。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正向提示词（必填）" },
        negative_prompt: { type: "string", description: "反向提示词：不想在画面里出现的东西。仅 dashscope 支持。" },
        provider: { type: "string", description: "通道 id：dashscope（通义万相/千问图像）/ ark（豆包 Seedream）。省略则自动选。" },
        model: { type: "string", description: "模型 id；省略用该通道第一个。" },
        size: { type: "string", description: "画幅：1:1 / 3:4 / 16:9，也可以直接给像素如 1024*1024。省略用 1:1。" },
        n: { type: "integer", description: "出几张，1~4，默认 1。" },
        watermark: { type: "boolean", description: "是否要厂商水印，默认 false（不要）。" },
        thinking: { type: "boolean", description: "dashscope 的深度思考模式，更慢但通常更贴提示词。默认不开。" },
        save_dir: { type: "string", description: "可选：把图存到这个目录（不存在会自动建），返回绝对路径。" },
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
      base: (process.env[PROVIDERS[id].envBase] || "").trim() || PROVIDERS[id].baseUrl,
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

    const sizeKey = String(args?.size || "1:1").trim();
    const n = Math.min(4, Math.max(1, Number(args?.n) || 1));
    const watermark = args?.watermark === true;
    const thinking = args?.thinking === true;
    const negative = String(args?.negative_prompt || "").trim();

    let id = String(args?.provider || "").trim();
    if (id && !PROVIDERS[id]) throw new Error("没有这个通道：" + id + "（有：" + Object.keys(PROVIDERS).join(" / ") + "）");

    const candidates = id ? [id] : readyProviders();
    if (!candidates.length) {
      throw new Error(
        "没有任何通道配好 key。请在 MCP 配置的 env 里填 DASHSCOPE_API_KEY 或 ARK_API_KEY。（先调 image_channels 看现状）"
      );
    }

    const failures = [];
    for (const cid of candidates) {
      const p = PROVIDERS[cid];
      const key = keyOf(cid);
      if (!key) {
        failures.push(cid + "：没有 key（env 里缺 " + p.envKey + "）");
        continue;
      }
      const size = resolveSize(p, sizeKey);
      if (!size) {
        failures.push(cid + "：不认这个画幅 " + sizeKey + "（可用：" + Object.keys(p.sizes).join(" / ") + "，或直接给 1024*1024）");
        continue;
      }

      const model = String(args?.model || p.models[0]);
      const t0 = Date.now();
      try {
        const urls = await p.generate({ key, model, size, prompt, negative, n, watermark, thinking });
        const ms = Date.now() - t0;
        const out = {
          ok: true,
          urls,
          url: urls[0],
          provider: cid,
          providerLabel: p.label,
          model,
          size,
          size_key: sizeKey,
          count: urls.length,
          elapsed_ms: ms,
        };

        const saveDir = String(args?.save_dir || "").trim();
        if (saveDir) {
          fs.mkdirSync(saveDir, { recursive: true });
          const saved = [];
          for (const u of urls) {
            const res = await fetch(u);
            if (!res.ok) throw new Error("图拿到了但下载失败 HTTP " + res.status + "：" + u);
            const buf = Buffer.from(await res.arrayBuffer());
            const ext = (u.split("?")[0].match(/\.(png|jpe?g|webp)$/i) || [, "png"])[1].toLowerCase();
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
            const file = path.join(saveDir, `image_${stamp}_${Math.random().toString(36).slice(2, 7)}.${ext}`);
            fs.writeFileSync(file, buf);
            saved.push({ path: file, bytes: buf.length });
          }
          out.saved = saved;
          out.saved_path = saved[0] && saved[0].path;
        }
        return out;
      } catch (e) {
        failures.push(cid + "：" + (e?.message || e));
      }
    }
    throw new Error(failures.join("\n\n"));
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
            ? `已出图 ${data.count} 张 · ${data.providerLabel} / ${data.model} / ${data.size} · ${(data.elapsed_ms / 1000).toFixed(1)}s\n` +
              data.urls.join("\n") +
              (data.saved ? `\n已存到：${data.saved.map((s) => s.path).join("\n")}` : "")
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
