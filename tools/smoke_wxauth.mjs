/**
 * 冒烟：微信登录 + uid 账号体系（本地起 server，端口 9099）
 * 验证点：
 *   1. 手机号登录老链路不破（token 解出 uid=p:手机号）
 *   2. 云同步按 uid 存/取正常
 *   3. /auth/wechat 未配 AppSecret 时返回结构化错误（不是 500 甩锅）
 *   4. 微信登录拿到假 code 时不被当成成功
 *
 * 运行： node tools/smoke_wxauth.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..", "server");
const PORT = 9099;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ✅ " + n + (extra ? "  " + extra : ""))) : (fail++, console.log("  ❌ " + n + "  " + extra)); };

async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const srv = spawn(process.execPath, ["index.mjs"], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

let srvOut = "";
srv.stdout.on("data", (d) => { srvOut += d.toString(); });

const cleanup = () => { try { srv.kill(); } catch (e) {} };
process.on("exit", cleanup);

if (!(await waitHealth())) {
  console.error("❌ 服务未启动"); srv.kill(); process.exit(1);
}
console.log("✅ 服务已启动 :" + PORT + "\n");

const phone = "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");

/* 1) 手机号登录 */
console.log("【1】手机号登录（老链路回归）");
const sc = await (await fetch(BASE + "/auth/send-code", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone }),
})).json();
ok("send-code 返回 devCode", !!sc.devCode, JSON.stringify(sc).slice(0, 90));

const li = await (await fetch(BASE + "/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone, code: sc.devCode, challenge: sc.challenge, exp: sc.exp }),
})).json();
ok("login 成功", !!li.ok);
ok("uid 格式 = p:手机号", li.uid === "p:" + phone, "uid=" + li.uid);
ok("provider = phone", li.provider === "phone");

/* 2) me 返回 uid / provider / display */
console.log("\n【2】/auth/me 账号信息");
const me = await (await fetch(BASE + "/auth/me", { headers: { Authorization: "Bearer " + li.token } })).json();
ok("me.ok", !!me.ok);
ok("me.uid 一致", me.uid === "p:" + phone, "uid=" + me.uid);
ok("me.display 为脱敏手机号", /^\d{3}\*{4}\d{4}$/.test(me.display || ""), "display=" + me.display);

/* 3) 云同步按 uid */
console.log("\n【3】云同步（uid 主键）");
const up = await (await fetch(BASE + "/sync/upload", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + li.token },
  body: JSON.stringify({ resumes: [{ id: "r1", name: "测试简历", updatedAt: Date.now() }], idPhoto: null, memberUntil: 0, version: 1 }),
})).json();
ok("upload 成功", !!up.ok, "storage=" + up.storage + " count=" + up.count);
const down = await (await fetch(BASE + "/sync/download", { headers: { Authorization: "Bearer " + li.token } })).json();
ok("download 取回数据", down.ok && down.data && down.data.resumes.length === 1, "key=" + (down.key || "-"));

/* 4) 未登录访问 sync 必须 401 */
const noAuth = await fetch(BASE + "/sync/download", { headers: { Authorization: "Bearer garbage.token" } });
ok("无效 token → 401", noAuth.status === 401, "status=" + noAuth.status);

/* 5) 微信登录：未配置凭证 */
console.log("\n【4】微信登录（未配置 AppSecret）");
const w1 = await (await fetch(BASE + "/auth/wechat", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: "FAKE_CODE_123" }),
})).json();
ok("未配置 → 结构化错误 NOT_CONFIGURED", w1.ok === false && w1.code === "NOT_CONFIGURED", w1.error || "");

/* 6) 微信登录：缺 code（未配置凭证时优先报配置问题，这里只要求不返回成功） */
const w2 = await (await fetch(BASE + "/auth/wechat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
})).json();
ok("缺 code → 绝不返回成功", w2.ok === false, w2.error || "");

/* 7) 篡改 token 必须拒绝 */
const forged = li.token.slice(0, -3) + "xxx";
const forgedMe = await (await fetch(BASE + "/auth/me", { headers: { Authorization: "Bearer " + forged } })).json();
ok("篡改 token → 拒绝", forgedMe.ok === false && forgedMe.code === "NO_AUTH");

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
srv.kill();
process.exit(fail ? 1 : 0);
