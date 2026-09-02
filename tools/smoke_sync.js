/**
 * 冒烟：云端备份/恢复（真实线上后端）
 * 流程：登录 → 造 2 份简历 → 备份 → 清空本地 → 恢复 → 校验
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
  page.on("dialog", d => { console.log("[dialog]", d.message().slice(0, 60)); d.accept(); });

  await page.goto("file:///" + path.resolve(__dirname, "../www/index.html").replace(/\\/g, "/"));
  await page.waitForTimeout(1800);

  // 登录
  let devCode = null;
  page.on("response", async r => {
    if (r.url().includes("auth/send-code")) { try { const d = await r.json(); if (d.devCode) devCode = d.devCode; } catch (e) {} }
  });
  await page.click('.tab[data-p="pageMine"]');
  await page.waitForTimeout(300);
  await page.click("#btnOpenLogin");
  await page.waitForTimeout(300);
  await page.type("#loginPhone", "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"));
  await page.click("#btnSendCode");
  await page.waitForTimeout(9000);
  if (!devCode) { console.log("[login] ❌ 未拿到 devCode，中止"); await browser.close(); process.exit(1); }
  await page.type("#loginCode", devCode);
  await page.click("#btnLoginOk");
  await page.waitForTimeout(2000);

  const logged = await page.evaluate(() => !!JSON.parse(localStorage.getItem("auth_v1") || "null")?.token);
  console.log("[1] 登录成功:", logged ? "✅" : "❌");
  const syncShown = await page.evaluate(() => document.getElementById("syncCard").style.display);
  console.log("[2] 云备份卡片显示:", syncShown !== "none" ? "✅" : "❌");

  // 造数据：2 份简历 + 证件照 + 会员
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await page.evaluate((png) => {
    resumeLib = [
      { id: "r_sync_1", name: "云端测试A", profile: { name: "张三" }, curTpl: "minimal", photoData: null, updatedAt: Date.now() },
      { id: "r_sync_2", name: "云端测试B", profile: { name: "李四" }, curTpl: "modern", photoData: null, updatedAt: Date.now() },
    ];
    saveLib();
    localStorage.setItem("idPhoto_v1", png);
    payInfo = { type: "month", expire: Date.now() + 30 * 864e5 };
    localStorage.setItem(PAY_KEY, JSON.stringify(payInfo));
    renderLib();
  }, PNG);

  // 备份
  await page.click("#btnSyncUp");
  await page.waitForTimeout(4000);
  const upToast = await page.evaluate(() => document.getElementById("toast").textContent);
  const syncHint = await page.evaluate(() => document.getElementById("syncHint").textContent);
  console.log("[3] 备份结果:", upToast.includes("已备份") ? "✅ " + upToast : "❌ " + upToast);
  console.log("[4] 备份时间显示:", /上次备份/.test(syncHint) ? "✅ " + syncHint : "❌ " + syncHint);

  // 清空本地再恢复
  await page.evaluate(() => {
    resumeLib = [];
    saveLib();
    localStorage.removeItem("idPhoto_v1");
    payInfo = { type: null, expire: 0 };
    localStorage.removeItem(PAY_KEY);
    renderLib();
    renderIdPhoto(null);
    if (window.__idPhotoChanged) window.__idPhotoChanged();
  });
  await page.click("#btnSyncDown");
  await page.waitForTimeout(4000);
  const restored = await page.evaluate(() => ({
    lib: resumeLib.map(r => r.name),
    idPhoto: !!localStorage.getItem("idPhoto_v1"),
    member: payInfo.expire > Date.now(),
    libCount: document.querySelectorAll(".lib-item").length,
  }));
  console.log("[5] 恢复后:", JSON.stringify(restored),
    restored.lib.length === 2 && restored.idPhoto && restored.member && restored.libCount === 2 ? "✅" : "❌");

  console.log("JS 错误:", errs.length ? errs.slice(0, 6) : "无 ✅");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
