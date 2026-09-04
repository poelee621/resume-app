// 线上 FC 全链路验证（不打本地 server，直接打线上）
const BASE = "https://resume-api-v-vzmoobafoo.cn-hangzhou.fcapp.run";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  c ? (pass++, console.log("  ✅ " + n + (extra ? "  " + extra : "")))
    : (fail++, console.log("  ❌ " + n + "  " + extra));
};

console.log("【1】健康检查");
const h = await (await fetch(BASE + "/health")).json();
ok("health.ok", h.ok && h.service === "resume-api-aliyun-fc", "service=" + h.service);

console.log("\n【2】/auth/wechat 缺 code");
const w0 = await (await fetch(BASE + "/auth/wechat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
})).json();
ok("缺 code → 绝不返回成功", w0.ok === false, "err=" + (w0.error || w0.code || ""));

console.log("\n【3】/auth/wechat 真凭证路径（fake code → 微信 invalid code）");
const w1 = await (await fetch(BASE + "/auth/wechat", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: "FAKE_CODE_FOR_SMOKE_TEST" }),
})).json();
// 关键判据：不是 NOT_CONFIGURED（说明 WX_APP_SECRET 已生效）
ok("非 NOT_CONFIGURED（凭证已生效）", w1.code !== "NOT_CONFIGURED", "code=" + w1.code + " err=" + w1.error);
ok("fake code → 微信 40029 invalid code", w1.code === "WX_ERR" && /40029/.test(w1.error || ""), "err=" + w1.error);

console.log("\n【4】/auth/send-code + /auth/login 链路");
const phone = "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const sc = await (await fetch(BASE + "/auth/send-code", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone }),
})).json();
ok("send-code devMode", !!sc.devCode, "phone=" + phone);

const li = await (await fetch(BASE + "/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone, code: sc.devCode, challenge: sc.challenge, exp: sc.exp }),
})).json();
ok("login ok", li.ok === true);
ok("uid = p:phone", li.uid === "p:" + phone, "uid=" + li.uid);
ok("provider = phone", li.provider === "phone");

const me = await (await fetch(BASE + "/auth/me", { headers: { Authorization: "Bearer " + li.token } })).json();
ok("me.uid 一致", me.uid === "p:" + phone);
ok("me.provider = phone", me.provider === "phone");
ok("me.display 脱敏", /^1\d{2}\*{4}\d{4}$/.test(me.display || ""));

console.log("\n【5】/pay/app-create 凭证检查（应不再报 NOT_CONFIGURED）");
const pay = await (await fetch(BASE + "/pay/app-create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "once" }),
})).json();
// 判据：报错不是 "未配置开放平台 AppID"（说明 WX_APP_APPID 已生效），是商户号 403（产品权限未开通）
ok("非 '未配置 WX_APP_APPID' 错误", !/未配置开放平台 AppID/.test(pay.error || ""), "err=" + pay.error);

console.log("\n【6】/pay/create（公众号 JSAPI / Native）");
const pay2 = await (await fetch(BASE + "/pay/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "once" }),
})).json();
ok("Native 下单成功", pay2.ok === true && /^weixin:\/\/wxpay\//.test(pay2.code_url || ""), "code_url=" + (pay2.code_url || "").slice(0, 40));

console.log("\n【7】/pay/h5-create 参数校验（应业务拒，不是微信服务器拒）");
const h5bad = await (await fetch(BASE + "/pay/h5-create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "forever" }),
})).json();
ok("错 plan → 业务拒", h5bad.ok === false && /未知套餐/.test(h5bad.error || ""));

console.log("\n【8】/pay/h5-create 真下单（绕过 APP 支付审核的方案 A 主链路）");
const h5 = await (await fetch(BASE + "/pay/h5-create", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-forwarded-for": "14.23.150.211" },
  body: JSON.stringify({ plan: "once", scene: "Wap" }),
})).json();
// 关键判据：服务端真向微信服务器发请求，签名/请求体/参数全部正确才会走到商户号权限这层
// 预期：返 403 NO_AUTH = 商户号 H5 支付产品未开通（这是坡哥要去 pay.weixin.qq.com 后台开通的）
ok("真请求微信服务器（不是本地参数拒）", h5.code === "NO_AUTH" || !!h5.h5_url, "code=" + h5.code + " err=" + (h5.error || ""));
ok("错误是 NO_AUTH 或成功拿到 h5_url", h5.code === "NO_AUTH" || /^https:\/\/wx\.tenpay\.com\//.test(h5.h5_url || ""), "h5_url=" + (h5.h5_url || "").slice(0, 50));

console.log("\n【9】/pay/h5-create iOS / Android scene 不被拒（参数正确性）");
const h5ios = await (await fetch(BASE + "/pay/h5-create", {
  method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "14.23.150.211" },
  body: JSON.stringify({ plan: "once", scene: "iOS" }),
})).json();
ok("iOS scene 通过请求体校验", h5ios.code === "NO_AUTH" || !!h5ios.h5_url, "code=" + h5ios.code);
const h5and = await (await fetch(BASE + "/pay/h5-create", {
  method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "14.23.150.211" },
  body: JSON.stringify({ plan: "once", scene: "Android" }),
})).json();
ok("Android scene 通过请求体校验", h5and.code === "NO_AUTH" || !!h5and.h5_url, "code=" + h5and.code);

console.log("\n【10】/pay/h5-create 不传 payer_client_ip（FC x-real-ip 兜底）");
const h5noip = await (await fetch(BASE + "/pay/h5-create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "once", scene: "Wap" }),
})).json();
ok("无 IP 也能走到微信（FC 兜底）", h5noip.code === "NO_AUTH" || !!h5noip.h5_url, "code=" + h5noip.code);

console.log(`\n===== 线上烟雾测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);