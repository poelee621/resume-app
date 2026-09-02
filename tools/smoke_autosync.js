/**
 * 冒烟：自动同步（真实线上后端）
 * ① 登录后自动拉取云端数据合并（换设备场景）
 * ② 新增简历后自动备份（2.5s 防抖静默上传）
 */
const { chromium } = require("playwright-core");
const path = require("path");

(async () => {
  const exe = process.env.PW_CHROMIUM;
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });
  page.on("dialog", d => d.accept());

  await page.goto("file:///" + path.resolve(__dirname, "../www/index.html").replace(/\\/g, "/"));
  await page.waitForTimeout(1800);

  // 固定账号（云端已有测试数据）验证「登录后自动拉取」
  const phone = "13912345678";

  // 登录
  let devCode = null;
  page.on("response", async r => {
    if (r.url().includes("auth/send-code")) { try { const d = await r.json(); if (d.devCode) devCode = d.devCode; } catch (e) {} }
  });
  await page.click('.tab[data-p="pageMine"]');
  await page.waitForTimeout(300);
  await page.click("#btnOpenLogin");
  await page.waitForTimeout(300);
  await page.type("#loginPhone", phone);
  await page.click("#btnSendCode");
  await page.waitForTimeout(13000);
  if (!devCode) { console.log("[1] ❌ 未拿到 devCode"); await browser.close(); process.exit(1); }
  await page.type("#loginCode", devCode);
  await page.click("#btnLoginOk");
  await page.waitForTimeout(2000);

  // ① 登录后 autoPull（800ms 触发 + 网络/冷启动）→ 等 15s
  await page.waitForTimeout(15000);
  const pullState = await page.evaluate(() => ({
    lib: resumeLib.map(r => r.name),
    toast: document.getElementById("toast").textContent,
  }));
  console.log("[1] 登录后自动拉取:", JSON.stringify(pullState),
    pullState.lib.length > 0 ? "✅ 云端数据已自动合并 (" + pullState.lib.length + " 份)" : "❌ 未拉到");

  // ② 新增简历 → 自动备份
  await page.evaluate(() => {
    const it = { id: "r_auto_" + Date.now(), name: "自动备份验证", profile: { name: "测试" }, curTpl: "minimal", photoData: null, updatedAt: Date.now() };
    resumeLib.unshift(it); saveLib(); renderLib(); markDirty();
  });
  await page.waitForTimeout(6000); // 2.5s 防抖 + 上传
  const cloudAfter = await page.evaluate(async () => {
    try {
      const resp = await fetch(AI_WORKER_URL + "sync/download", { headers: { "Authorization": "Bearer " + authInfo.token } });
      const data = await resp.json();
      const names = (data.data && data.data.resumes || []).map(r => r.name);
      return { ok: data.ok, names };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  const hasAuto = cloudAfter.ok && cloudAfter.names.includes("自动备份验证");
  console.log("[2] 新增后自动备份:", hasAuto ? "✅ 云端已出现「自动备份验证」" : "❌ 未上传", cloudAfter.ok ? "" : JSON.stringify(cloudAfter));

  console.log("JS 错误:", errs.length ? errs.slice(0, 6) : "无 ✅");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
