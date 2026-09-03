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

console.log(`\n===== 线上烟雾测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);