/**
 * 简历 App 后端 —— 阿里云函数计算（FC）版本
 * 无状态设计：不依赖 KV/数据库（订单状态直接查微信支付订单 API）
 *
 * 环境变量（函数计算控制台配置）：
 *   DEEPSEEK_API_KEY   DeepSeek API Key
 *   WX_MCH_ID          微信支付商户号
 *   WX_CERT_SERIAL     商户证书序列号
 *   WX_API_V3_KEY      APIv3 密钥（32 位）
 *   WX_PRIVATE_KEY     商户 API 私钥（PEM，\n 要换成真实换行或用 \\n 转义）
 *   WX_APP_ID          公众号 AppID
 *
 * 路由：
 *   POST /chat        → DeepSeek 代理
 *   POST /pay/create  → 微信支付 Native 下单（返回 code_url + out_trade_no）
 *   GET  /pay/status  → 查微信支付订单状态（out_trade_no）
 *   POST /pay/callback→ 微信支付回调（直接返回 SUCCESS，状态以查询 API 为准）
 *   GET  /health      → 健康检查
 */

const ENV = process.env;
const CORS = {
  "Content-Type": "application/json;charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

/* ---------------- 入口（阿里云 FC HTTP 触发器） ---------------- */
export const handler = async (event, context, callback) => {
  try {
    const evt = typeof event === "string" || Buffer.isBuffer(event) ? JSON.parse(event.toString()) : event;
    const method = (evt.httpMethod || evt.method || "GET").toUpperCase();
    const path = evt.path || "/";
    const body = evt.body ? (evt.isBase64Encoded ? Buffer.from(evt.body, "base64").toString() : evt.body) : "";
    const origin = `https://${(evt.headers || {})["host"] || "resume-api"}`;

    if (method === "OPTIONS") return callback(null, json({ ok: true }));
    if (path === "/health") return callback(null, json({ ok: true, ts: Date.now(), service: "resume-api-aliyun-fc" }));

    if (path === "/chat" && method === "POST") {
      const b = JSON.parse(body || "{}");
      return callback(null, json(await chat(b.messages, b.temperature, b.max_tokens)));
    }
    if (path === "/pay/create" && method === "POST") {
      const b = JSON.parse(body || "{}");
      return callback(null, json(await payCreate(b.plan, origin)));
    }
    if (path === "/pay/status" && method === "GET") {
      const q = evt.queryParameters || {};
      const outTradeNo = q.out_trade_no || q["out_trade_no"];
      return callback(null, json(await payStatus(outTradeNo)));
    }
    if (path === "/pay/callback" && method === "POST") {
      /* 无状态：状态以订单查询 API 为准，这里直接确认收到 */
      return callback(null, json({ code: "SUCCESS", message: "成功" }));
    }
    return callback(null, json({ ok: false, error: "not found: " + path }, 404));
  } catch (e) {
    return callback(null, json({ ok: false, error: e.message }, 500));
  }
};
