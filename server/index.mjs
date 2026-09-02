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
 *   WX_APP_SECRET      微信开放平台 AppSecret（微信一键登录换 openid 用，未配置时 /auth/wechat 返回明确错误）
 *   PORT               自定义运行时监听端口，默认 9000
 *
 * 账号体系：uid 统一标识（手机号登录 uid=p:手机号，微信登录 uid=w:openid），
 *           云同步按 uid 存，两种登录方式互不串号（后续可加绑定把两个 uid 合并）。
 *
 * 路由：
 *   POST /chat        → DeepSeek 代理
 *   POST /pay/create  → 微信支付 Native 下单（返回 code_url + out_trade_no）
 *   POST /pay/app-create → 微信支付 APP 下单（返回调起参数 payParams，App 内直接拉起微信收银台）
 *   GET  /pay/status  → 查微信支付订单状态（out_trade_no）
 *   POST /pay/callback→ 微信支付回调（无状态：以查询 API 为准）
 *   POST /auth/send-code → 手机号验证码（dev 模式直接返回 devCode，配 SMS_WEBHOOK 后走 webhook）
 *   POST /auth/login  → 手机号+验证码换 token
 *   POST /auth/wechat → 微信一键登录（code → openid → token）
 *   GET  /auth/me     → token 换账号信息（启动恢复登录态）
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

/* ---------------- 登录：自签名验证码 challenge + 无状态 token（不依赖实例内存） ---------------- */
/* 为什么不用内存存验证码/会话：
   FC 多实例下 send-code 与 login 可能落到不同实例 → 内存方案登录概率性失败。
   改为 HMAC 自签名：challenge 内嵌 code+exp（验签防伪），token 内嵌 phone+exp（验签恢复），
   任何实例都能独立校验，天然跨实例。 */
const AUTH_SECRET = ENV.AUTH_SECRET || "resume_dev_secret_2026_change_me";
const CODE_TTL = 5 * 60 * 1000;
const SEND_COOLDOWN = 60 * 1000;
const SESS_TTL = 90 * 24 * 3600 * 1000; // 90 天

const PHONE_RE = /^1\d{10}$/;

/* uid 统一标识：手机号登录 p:<phone>，微信登录 w:<openid>。
   云同步按 uid 存，两种登录方式互不串号。
   历史数据是用明文手机号存的，读取时做一次兼容回查，老用户不掉数据。 */
const uidOfPhone = (phone) => `p:${phone}`;
const uidOfWx = (openid) => `w:${openid}`;

async function hmac(content) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}
const b64url = (s) => Buffer.from(s).toString("base64url");

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
    return { devMode: true, code, error: e.message };
  }
}

/* cooldown 尽力而为（内存，多实例下可能放宽，可接受） */
const codeStore = new Map(); // phone -> { lastSent }

async function sendCode(phone) {
  if (!phone || !PHONE_RE.test(phone)) return { ok: false, error: "手机号格式不正确" };
  const now = Date.now();
  const prev = codeStore.get(phone);
  if (prev && now - prev.lastSent < SEND_COOLDOWN) {
    const wait = Math.ceil((SEND_COOLDOWN - (now - prev.lastSent)) / 1000);
    return { ok: false, error: `发送太频繁，请 ${wait} 秒后再试`, retryAfter: wait };
  }
  codeStore.set(phone, { lastSent: now });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const exp = now + CODE_TTL;
  const challenge = await hmac(`code:${phone}:${code}:${exp}`);
  const sms = await deliverSms(phone, code);
  const ret = { ok: true, ttl: CODE_TTL / 1000, cooldown: SEND_COOLDOWN / 1000, exp, challenge };
  if (sms.devMode) ret.devCode = code; /* 仅 dev 模式回传 */
  return ret;
}

async function login(phone, code, challenge, exp) {
  if (!phone || !PHONE_RE.test(phone)) return { ok: false, error: "手机号格式不正确" };
  if (!code || !challenge || !exp) return { ok: false, error: "验证码错误" };
  exp = Number(exp);
  if (!(exp > Date.now())) return { ok: false, error: "验证码已过期，请重新获取" };
  const expect = await hmac(`code:${phone}:${String(code).trim()}:${exp}`);
  if (expect !== String(challenge)) return { ok: false, error: "验证码错误" };
  /* 签发无状态 token：payload.signature（uid 统一标识，手机号/微信两种登录共用） */
  const uid = uidOfPhone(phone);
  const { token, expiresAt } = await issueToken(uid, { phone });
  return { ok: true, token, uid, phone, maskPhone: maskPhone(phone), provider: "phone", expiresAt };
}

/* 签发 token：payload = base64url({uid, ...extra, exp}) + HMAC 签名 */
async function issueToken(uid, extra = {}) {
  const expiresAt = Date.now() + SESS_TTL;
  const payload = b64url(JSON.stringify({ uid, ...extra, exp: expiresAt }));
  const sig = await hmac(`tok:${payload}`);
  return { token: `${payload}.${sig}`, expiresAt };
}

async function parseToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = await hmac(`tok:${payload}`);
  if (expect !== sig) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!obj.exp || obj.exp < Date.now()) return null;
    /* 兼容老版本 token（只有 phone、无 uid）：自动推导 uid，老用户不掉线 */
    const uid = obj.uid || (obj.phone ? uidOfPhone(obj.phone) : null);
    if (!uid) return null;
    return { uid, phone: obj.phone || "", nick: obj.nick || "", avatar: obj.avatar || "", exp: obj.exp };
  } catch (e) { return null; }
}

async function me(token) {
  const p = await parseToken(token);
  if (!p) return { ok: false, error: "未登录或已过期", code: "NO_AUTH" };
  const isWx = p.uid.startsWith("w:");
  return {
    ok: true, uid: p.uid, phone: p.phone,
    maskPhone: p.phone ? maskPhone(p.phone) : "",
    nick: p.nick, avatar: p.avatar,
    provider: isWx ? "wechat" : "phone",
    display: isWx ? (p.nick || "微信用户") : maskPhone(p.phone),
    expiresAt: p.exp,
  };
}

/* ---------------- 微信一键登录（开放平台移动应用 OAuth） ---------------- */
/* 流程：App 用微信 SDK 拿 code → 本函数用 code+AppSecret 换 openid → 签发自家 token。
   注意：code 只能用一次、5 分钟有效；AppSecret 绝不下发到客户端。 */
async function wechatLogin(code) {
  if (!ENV.WX_APP_APPID || !ENV.WX_APP_SECRET) {
    return { ok: false, code: "NOT_CONFIGURED", error: "服务端未配置微信开放平台凭证（WX_APP_APPID / WX_APP_SECRET）" };
  }
  code = String(code || "").trim();
  if (!code) return { ok: false, error: "缺少微信授权 code" };

  const tkUrl = "https://api.weixin.qq.com/sns/oauth2/access_token"
    + `?appid=${encodeURIComponent(ENV.WX_APP_APPID)}`
    + `&secret=${encodeURIComponent(ENV.WX_APP_SECRET)}`
    + `&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  let tj;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(tkUrl, { signal: ctrl.signal });
    clearTimeout(t);
    tj = await r.json();
  } catch (e) {
    return { ok: false, error: "微信接口请求失败：" + e.message };
  }
  /* 微信错误样例：{"errcode":40029,"errmsg":"invalid code"} */
  if (tj.errcode) return { ok: false, code: "WX_ERR", error: `微信登录失败(${tj.errcode})：${tj.errmsg || "未知错误"}` };
  const openid = tj.openid;
  if (!openid) return { ok: false, code: "WX_ERR", error: "未取到 openid" };

  /* 昵称头像只是装饰，拉取失败不阻断登录 */
  let nick = "", avatar = "";
  try {
    const uUrl = "https://api.weixin.qq.com/sns/userinfo"
      + `?access_token=${encodeURIComponent(tj.access_token)}`
      + `&openid=${encodeURIComponent(openid)}&lang=zh_CN`;
    const ur = await fetch(uUrl);
    const uj = await ur.json();
    if (!uj.errcode) { nick = uj.nickname || ""; avatar = uj.headimgurl || ""; }
  } catch (e) { /* 忽略 */ }

  const uid = uidOfWx(openid);
  const { token, expiresAt } = await issueToken(uid, { nick, avatar });
  return { ok: true, token, uid, nick, avatar, provider: "wechat", expiresAt };
}

function logout(token) {
  return { ok: true }; /* 无状态 token，注销即前端丢弃 */
}

/* ---------------- 云同步：简历/证件照/会员（OTS 持久化优先，内存兜底） ---------------- */
/* 持久化：配置 OTS_ACCESS_KEY_ID/SECRET/INSTANCE_NAME 后自动启用阿里云表格存储，
   数据真正持久（服务器重启/部署/多实例都不丢）；未配置时退回实例内存（开发环境） */
const syncStore = new Map(); // phone -> record（内存兜底 + 读缓存）
const OTS_CFG = {
  enabled: !!(ENV.OTS_ACCESS_KEY_ID && ENV.OTS_ACCESS_KEY_SECRET && ENV.OTS_INSTANCE_NAME),
  table: ENV.OTS_TABLE_NAME || "sync_data",
};
let otsMod = null; // 懒加载 @alicloud/ots2

async function getOtsClient() {
  if (!OTS_CFG.enabled) return null;
  if (otsMod) return otsMod.client;
  try {
    const mod = await import("@alicloud/ots2");
    const client = mod.createClient({
      accessKeyID: ENV.OTS_ACCESS_KEY_ID,
      accessKeySecret: ENV.OTS_ACCESS_KEY_SECRET,
      endpoint: ENV.OTS_ENDPOINT || `https://${ENV.OTS_INSTANCE_NAME}.cn-hangzhou.ots.aliyuncs.com/`,
      instance: ENV.OTS_INSTANCE_NAME,
      maxRetries: 3,
    });
    otsMod = { mod, client };
    console.log("[ots] 已启用 OTS 持久化, instance=", ENV.OTS_INSTANCE_NAME);
    return client;
  } catch (e) {
    console.error("[ots] 初始化失败（未配置则忽略）:", e.message);
    return null;
  }
}

async function authedUid(evt) {
  const auth = getHeader(evt.headers, "authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const p = await parseToken(token);
  return p ? { uid: p.uid, phone: p.phone } : null;
}

/* 兼容回查链：新格式 uid（p:138…）读不到时，回查历史明文手机号 */
function syncKeys(uid) {
  const keys = [uid];
  if (uid.startsWith("p:")) keys.push(uid.slice(2));
  return keys;
}

async function syncUpload(uid, b) {
  if (!Array.isArray(b.resumes)) return { ok: false, error: "resumes 必须是数组" };
  const record = {
    resumes: b.resumes,
    idPhoto: typeof b.idPhoto === "string" ? b.idPhoto : null,
    memberUntil: Number(b.memberUntil) || 0,
    version: Number(b.version) || Date.now(),
    updatedAt: Date.now(),
  };
  const ots = await getOtsClient();
  if (ots) {
    try {
      const m = otsMod.mod;
      const RowExistenceExpectation = m.RowExistenceExpectation || (m.default && m.default.RowExistenceExpectation);
      await ots.putRow(OTS_CFG.table, { row_existence: RowExistenceExpectation.IGNORE }, { phone: uid }, {
        data: JSON.stringify(record),
        updated_at: record.updatedAt,
      });
      syncStore.set(uid, record); /* 内存缓存同步一份（读加速） */
      return { ok: true, updatedAt: record.updatedAt, count: record.resumes.length, storage: "ots" };
    } catch (e) {
      console.error("[ots] upload 失败，回退内存:", e.message);
    }
  }
  syncStore.set(uid, record);
  return { ok: true, updatedAt: record.updatedAt, count: record.resumes.length, storage: "memory" };
}

async function syncDownload(uid) {
  const ots = await getOtsClient();
  if (ots) {
    for (const key of syncKeys(uid)) {
      try {
        const g = await ots.getRow(OTS_CFG.table, { phone: key });
        const row = g && g.row;
        if (row && row.data) {
          try {
            const record = JSON.parse(row.data);
            syncStore.set(key, record); /* 回填缓存 */
            return { ok: true, data: record, key };
          } catch (e) { /* data 损坏则继续回查 */ }
        }
      } catch (e) {
        console.error("[ots] download 失败（key=" + key + "）:", e.message);
      }
    }
  }
  /* OTS 不可用或全未命中 → 内存兜底（同样按兼容链回查） */
  for (const key of syncKeys(uid)) {
    const record = syncStore.get(key);
    if (record) return { ok: true, data: record, key, storage: "memory" };
  }
  return { ok: true, data: null };
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

    /* Apple Universal Link 关联文件（iOS 微信 SDK 的硬要求：不配会在初始化时崩溃）。
       必须返回 application/json 且不能重定向 —— GitHub Pages 对无扩展名文件返回
       text/plain，iOS 不认，所以由后端直接托管。微信开放平台后台填同一个域名。 */
    if (urlPath === "/apple-app-site-association" || urlPath === "/.well-known/apple-app-site-association") {
      const teamId = ENV.APPLE_TEAM_ID || "L25SJ9LB9N";
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          applinks: {
            apps: [],
            details: [{ appIDs: [teamId + ".com.coldtank.resume"], paths: ["/wx/*"] }],
          },
        }),
        isBase64Encoded: false,
      };
    }

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
      return json(await login(b.phone, b.code, b.challenge, b.exp));
    }
    if (urlPath === "/auth/wechat" && method === "POST") {
      const b = body ? JSON.parse(body) : {};
      return json(await wechatLogin(b.code));
    }
    if (urlPath === "/auth/me" && (method === "GET" || method === "POST")) {
      const auth = getHeader(evt.headers, "authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return json(await me(token));
    }
    if (urlPath === "/auth/logout" && method === "POST") {
      const auth = getHeader(evt.headers, "authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return json(logout(token));
    }
    /* ------- 云同步（需登录） ------- */
    if (urlPath === "/sync/upload" && method === "POST") {
      const a = await authedUid(evt);
      if (!a) return json({ ok: false, error: "请先登录", code: "NO_AUTH" }, 401);
      const b = body ? JSON.parse(body) : {};
      return json(await syncUpload(a.uid, b));
    }
    if (urlPath === "/sync/download" && (method === "GET" || method === "POST")) {
      const a = await authedUid(evt);
      if (!a) return json({ ok: false, error: "请先登录", code: "NO_AUTH" }, 401);
      return json(await syncDownload(a.uid));
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
