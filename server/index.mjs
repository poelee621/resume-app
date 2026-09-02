/**
 * 简历 App 后端 —— 阿里云函数计算 FC 3.0 自定义运行时版（HTTP Server 模式）
 * 无状态设计：不依赖 KV/数据库（订单状态直接查微信支付订单 API）
 *
 * 环境变量（函数计算控制台配置）：
 *   DEEPSEEK_API_KEY   DeepSeek API Key
 *   WX_MCH_ID          微信支付商户号
 *   WX_CERT_SERIAL     商户证书序列号
 *   WX_API_V3_KEY      APIv3 密钥（32 位）
 *   WX_PRIVATE_KEY     商户 API 私钥（PEM，\n 要换成真实换行，可粘贴整段）
 *   WX_APP_ID          公众号 AppID
 *   WX_APP_APPID       微信开放平台 AppID（APP 支付专用，与公众号 AppID 不同；未配置时 /pay/app-create 返回明确错误）
 *   PORT               自定义运行时监听端口，默认 9000
 *
 * 路由：
 *   POST /chat        → DeepSeek 代理
 *   POST /pay/create  → 微信支付 Native 下单（返回 code_url + out_trade_no）
 *   POST /pay/app-create → 微信支付 APP 下单（返回调起参数 payParams，App 内直接拉起微信收银台）
 *   GET  /pay/status  → 查微信支付订单状态（out_trade_no）
 *   POST /pay/callback→ 微信支付回调（无状态：以查询 API 为准）
 *   POST /auth/send-code → 手机号验证码（dev 模式直接返回 devCode，配 SMS_WEBHOOK 后走 webhook）
 *   POST /auth/login  → 手机号+验证码换 token
 *   GET  /auth/me     → token 换手机号（启动恢复登录态）
 *   POST /auth/logout → 注销 token
 *   POST /sync/upload   → 简历/证件照/会员 备份到云端（需登录）
 *   GET  /sync/download → 从云端拉取备份（需登录）
 *   GET  /health      → 健康检查
 *
 * 启动：node index.mjs
 * - 阿里云 FC 自定义运行时：自动监听 PORT（默认 9000）
 * - 本地开发：相同命令，监听 9000
 */

import { createServer } from "node:http";

const ENV = process.env;
const CORS = {
  "Content-Type": "application/json;charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(obj), isBase64Encoded: false };
}

/* ---------------- 签名（RSA-SHA256 / PKCS#1 v1.5） ---------------- */
async function signRSA(privateKeyPem, content) {
  const b64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(Buffer.from(b64, "base64"));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(content));
  return Buffer.from(new Uint8Array(sig)).toString("base64");
}

/* 构造微信支付 Authorization 头（签名串：方法\n路径\n时间戳\n随机串\n请求体\n） */
async function wxAuth(method, urlPath, bodyStr) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2, 18);
  const signStr = `${method}\n${urlPath}\n${ts}\n${nonce}\n${bodyStr}\n`;
  const signature = await signRSA(ENV.WX_PRIVATE_KEY, signStr);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${ENV.WX_MCH_ID}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${ENV.WX_CERT_SERIAL}"`;
}

/* headers 不分大小写读取 */
function getHeader(headers, name) {
  if (!headers) return "";
  const k = name.toLowerCase();
  for (const hk of Object.keys(headers)) {
    if (hk.toLowerCase() === k) return headers[hk];
  }
  return "";
}

/* ---------------- AI：DeepSeek 代理 ---------------- */
async function chat(messages, temperature = 0.7, maxTokens = 2048) {
  if (!Array.isArray(messages) || !messages.length) return { ok: false, error: "messages required" };
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENV.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: "deepseek-chat", messages, temperature, max_tokens: maxTokens, stream: false }),
  });
  const data = await resp.json();
  if (!resp.ok) return { ok: false, status: resp.status, error: data?.error?.message || "AI 服务异常" };
  return { ok: true, content: data.choices?.[0]?.message?.content || "" };
}

/* ---------------- 微信支付：下单 ---------------- */
async function payCreate(plan, origin) {
  const prices = { once: 990, month: 4900, year: 8900 }; // 分
  const price = prices[plan];
  if (!price) return { ok: false, error: "未知套餐" };
  const desc = { once: "单次解锁", month: "包月会员", year: "体验包年" }[plan];
  const ts = Date.now();
  const outTradeNo = `RS${ts}${Math.floor(Math.random() * 10000)}`;
  const body = {
    appid: ENV.WX_APP_ID,
    mchid: ENV.WX_MCH_ID,
    description: `简历-${desc}`,
    out_trade_no: outTradeNo,
    notify_url: `${origin}/pay/callback`,
    amount: { total: price, currency: "CNY" },
  };
  const bodyStr = JSON.stringify(body);
  const resp = await fetch("https://api.mch.weixin.qq.com/v3/pay/transactions/native", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: await wxAuth("POST", "/v3/pay/transactions/native", bodyStr),
    },
    body: bodyStr,
  });
  const data = await resp.json();
  if (!resp.ok) return { ok: false, status: resp.status, error: data?.message || "下单失败" };
  return { ok: true, out_trade_no: outTradeNo, code_url: data.code_url };
}

/* ---------------- 微信支付：查单（无状态，不依赖数据库） ---------------- */
async function payStatus(outTradeNo) {
  if (!outTradeNo) return { ok: false, error: "缺少 out_trade_no", paid: false };
  const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${ENV.WX_MCH_ID}`;
  const resp = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: await wxAuth("GET", urlPath, "") },
  });
  const data = await resp.json();
  if (!resp.ok) return { ok: false, paid: false, error: data?.message || "查询失败", state: null };
  return { ok: true, paid: data.trade_state === "SUCCESS", state: data.trade_state };
}

/* ---------------- 微信支付：APP 下单（App 内直接拉起微信收银台，无需扫码） ---------------- */
async function payAppCreate(plan, origin) {
  if (!ENV.WX_APP_APPID) {
    return { ok: false, error: "未配置开放平台 AppID（WX_APP_APPID）。需先在微信开放平台注册 App（企业认证）并开通 APP 支付产品" };
  }
  const prices = { once: 990, month: 4900, year: 8900 }; // 分
  const price = prices[plan];
  if (!price) return { ok: false, error: "未知套餐" };
  const desc = { once: "单次解锁", month: "包月会员", year: "体验包年" }[plan];
  const ts = Date.now();
  const outTradeNo = `RS${ts}${Math.floor(Math.random() * 10000)}`;
  const body = {
    appid: ENV.WX_APP_APPID,
    mchid: ENV.WX_MCH_ID,
    description: `简历-${desc}`,
    out_trade_no: outTradeNo,
    notify_url: `${origin}/pay/callback`,
    amount: { total: price, currency: "CNY" },
  };
  const bodyStr = JSON.stringify(body);
  const resp = await fetch("https://api.mch.weixin.qq.com/v3/pay/transactions/app", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: await wxAuth("POST", "/v3/pay/transactions/app", bodyStr),
    },
    body: bodyStr,
  });
  const data = await resp.json();
  if (!resp.ok) return { ok: false, status: resp.status, error: data?.message || "APP 下单失败" };
  /* 二次签名：用商户私钥对 appId\npartnerId\nprepayId\nnonceStr\ntimeStamp\npackage\n 签名（调起参数） */
  const prepayId = data.prepay_id;
  const nonceStr = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const packageVal = "Sign=WXPay";
  const signStr = [ENV.WX_APP_APPID, ENV.WX_MCH_ID, prepayId, nonceStr, timeStamp, packageVal].join("\n") + "\n";
  const sign = await signRSA(ENV.WX_PRIVATE_KEY, signStr);
  return {
    ok: true,
    out_trade_no: outTradeNo,
    payParams: {
      appid: ENV.WX_APP_APPID,
      partnerid: ENV.WX_MCH_ID,
      prepayid: prepayId,
      package: packageVal,
      noncestr: nonceStr,
      timestamp: timeStamp,
      sign,
    },
  };
}

/* ---------------- 登录：内存验证码 + 会话（MVP 无 DB，单实例内存） ---------------- */
/* ⚠️ 生产注意：
   1. FC 冷启动/多实例时内存会丢 → 验证码重发、token 失效重登即可（无感知）
   2. 真短信：配置 SMS_WEBHOOK 环境变量（http(s) 地址），服务端会 POST {phone, code} 到该地址；
      未配置时进入 dev 模式，验证码直接在响应里返回（devCode），方便真机联调
   3. 正式接入阿里云短信：申请签名+模板后，在 sendSms 里实现（需 AccessKey + 计算签名） */
const codeStore = new Map();   // phone -> { code, exp, lastSent }
const sessStore = new Map();   // token  -> { phone, exp }
const CODE_TTL = 5 * 60 * 1000;
const SEND_COOLDOWN = 60 * 1000;
const SESS_TTL = 90 * 24 * 3600 * 1000; // 90 天

const PHONE_RE = /^1\d{10}$/;

function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + "****" + phone.slice(7) : "";
}

/* 验证码 → 短信（dev 模式直接返回，配 SMS_WEBHOOK 走 webhook） */
async function deliverSms(phone, code) {
  const webhook = ENV.SMS_WEBHOOK;
  if (!webhook) return { devMode: true, code };
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code, ts: Date.now() }),
    });
    if (!resp.ok) throw new Error("webhook status " + resp.status);
    return { devMode: false };
  } catch (e) {
    /* webhook 失败也退回 dev 模式，避免把测试者卡死 */
    return { devMode: true, code, error: e.message };
  }
}

async function sendCode(phone) {
  if (!phone || !PHONE_RE.test(phone)) return { ok: false, error: "手机号格式不正确" };
  const now = Date.now();
  const prev = codeStore.get(phone);
  if (prev && now - prev.lastSent < SEND_COOLDOWN) {
    const wait = Math.ceil((SEND_COOLDOWN - (now - prev.lastSent)) / 1000);
    return { ok: false, error: `发送太频繁，请 ${wait} 秒后再试`, retryAfter: wait };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  codeStore.set(phone, { code, exp: now + CODE_TTL, lastSent: now });
  const sms = await deliverSms(phone, code);
  const ret = { ok: true, ttl: CODE_TTL / 1000, cooldown: SEND_COOLDOWN / 1000 };
  if (sms.devMode) ret.devCode = code; // 仅 dev 模式回传，方便测试
  return ret;
}

function login(phone, code) {
  if (!phone || !PHONE_RE.test(phone)) return { ok: false, error: "手机号格式不正确" };
  const rec = codeStore.get(phone);
  if (!rec || !code || rec.code !== String(code).trim()) return { ok: false, error: "验证码错误" };
  if (Date.now() > rec.exp) {
    codeStore.delete(phone);
    return { ok: false, error: "验证码已过期，请重新获取" };
  }
  codeStore.delete(phone); // 用后即焚
  const token = "t_" + crypto.randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
  sessStore.set(token, { phone, exp: Date.now() + SESS_TTL });
  return { ok: true, token, phone, maskPhone: maskPhone(phone), expiresAt: Date.now() + SESS_TTL };
}

function me(token) {
  if (!token) return { ok: false, error: "未登录", code: "NO_AUTH" };
  const rec = sessStore.get(token);
  if (!rec) return { ok: false, error: "登录已失效", code: "NO_AUTH" };
  if (Date.now() > rec.exp) {
    sessStore.delete(token);
    return { ok: false, error: "登录已过期", code: "NO_AUTH" };
  }
  return { ok: true, phone: rec.phone, maskPhone: maskPhone(rec.phone), expiresAt: rec.exp };
}

function logout(token) {
  if (token) sessStore.delete(token);
  return { ok: true };
}

/* ---------------- 云同步：简历/证件照/会员（MVP 存实例内存，按手机号） ---------------- */
/* ⚠️ 与验证码同一限制：FC 冷启动/多实例会丢。正式上线换阿里云 OTS/Redis（见部署指南备注） */
const syncStore = new Map(); // phone -> { resumes, idPhoto, memberUntil, version, updatedAt }

function authedPhone(evt) {
  const auth = getHeader(evt.headers, "authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const m = me(token);
  return m.ok ? m.phone : null;
}

function syncUpload(phone, b) {
  if (!Array.isArray(b.resumes)) return { ok: false, error: "resumes 必须是数组" };
  const record = {
    resumes: b.resumes,
    idPhoto: typeof b.idPhoto === "string" ? b.idPhoto : null,
    memberUntil: Number(b.memberUntil) || 0,
    version: Number(b.version) || Date.now(),
    updatedAt: Date.now(),
  };
  syncStore.set(phone, record);
  return { ok: true, updatedAt: record.updatedAt, count: record.resumes.length };
}

function syncDownload(phone) {
  const record = syncStore.get(phone);
  return { ok: true, data: record || null };
}

/* ---------------- 核心：路由分发（FC event → json response） ---------------- */
async function handleEvent(evt) {
  const method = (evt.httpMethod || evt.method || "GET").toUpperCase();
  const urlPath = evt.path || evt.url || "/";
  const body = evt.body
    ? (evt.isBase64Encoded ? Buffer.from(evt.body, "base64").toString() : evt.body.toString())
    : "";
  const host = getHeader(evt.headers, "host") || "resume-api";
  const origin = `https://${host}`;
  const q = evt.queryParameters || evt.queryStringParameters || {};
  const getQuery = (k) => q[k] || q[k.toLowerCase()];

  try {
    if (method === "OPTIONS") return json({ ok: true });
    if (urlPath === "/health" || urlPath === "/healthz")
      return json({ ok: true, ts: Date.now(), service: "resume-api-aliyun-fc" });

    if (urlPath === "/chat" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(await chat(b.messages, b.temperature, b.max_tokens));
    }
    if (urlPath === "/pay/create" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(await payCreate(b.plan, origin));
    }
    if (urlPath === "/pay/app-create" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(await payAppCreate(b.plan, origin));
    }
    if (urlPath === "/pay/status" && method === "GET") {
      const outTradeNo = getQuery("out_trade_no") || getQuery("outTradeNo");
      return json(await payStatus(outTradeNo));
    }
    if (urlPath === "/pay/callback" && method === "POST") {
      /* 无状态：状态以订单查询 API 为准 */
      return json({ code: "SUCCESS", message: "成功" });
    }
    /* ------- 登录 / 会话 ------- */
    if (urlPath === "/auth/send-code" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(await sendCode(b.phone));
    }
    if (urlPath === "/auth/login" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(login(b.phone, b.code));
    }
    if (urlPath === "/auth/me" && (method === "GET" || method === "POST")) {
      const auth = getHeader(evt.headers, "authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return json(me(token));
    }
    if (urlPath === "/auth/logout" && method === "POST") {
      const auth = getHeader(evt.headers, "authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return json(logout(token));
    }
    /* ------- 云同步（需登录） ------- */
    if (urlPath === "/sync/upload" && method === "POST") {
      const phone = authedPhone(evt);
      if (!phone) return json({ ok: false, error: "请先登录", code: "NO_AUTH" }, 401);
      const b = body ? JSON.parse(body) : {};
      return json(syncUpload(phone, b));
    }
    if (urlPath === "/sync/download" && (method === "GET" || method === "POST")) {
      const phone = authedPhone(evt);
      if (!phone) return json({ ok: false, error: "请先登录", code: "NO_AUTH" }, 401);
      return json(syncDownload(phone));
    }
    return json({ ok: false, error: "not found: " + urlPath }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ---------------- HTTP Server（自定义运行时要求） ---------------- */
/* 任意来源 HTTP 请求 → 转 FC event → handleEvent → 写回响应 */
function startHttpServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      const url = req.url || "/";
      const event = {
        path: url.split("?")[0],
        httpMethod: req.method,
        headers: req.headers,
        body: bodyBuf.toString(),
        isBase64Encoded: false,
        queryParameters: Object.fromEntries(new URL(url, `http://${req.headers.host}`).searchParams),
      };
      const result = await handleEvent(event);
      res.statusCode = result.statusCode || 200;
      const headers = result.headers || {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "set-cookie") continue; // 多值，跳过避免报错
        res.setHeader(k, v);
      }
      res.end(result.body);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  server.listen(port, () => console.log(`resume-api listening on :${port}`));
}

/* 启动 */
const PORT = +(ENV.PORT || ENV.FC_SERVER_PORT || 9000);
startHttpServer(PORT);

/* 同时也 export handler（兼容其他触发场景/本地测试） */
export const handler = async (event) => handleEvent(event);
