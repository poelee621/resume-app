/**
 * 冒烟：证件照引用 + 手机号登录（真实线上后端）
 */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

(async () => {
  const exe = process.env.PW_CHROMIUM;
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });

  await page.goto("file:///" + path.resolve(__dirname, "../www/index.html").replace(/\\/g, "/"));
  await page.waitForTimeout(1800);

  // ========== 1. 证件照引用 ==========
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const noBtn = await page.evaluate(() => {
    const w = document.getElementById("idPhotoRefWrap");
    return w ? w.style.display : "n/a";
  });
  console.log("[1] 无证件照时引用按钮 display:", noBtn, noBtn === "none" ? "✅" : "❌");

  await page.evaluate(d => localStorage.setItem("idPhoto_v1", d), PNG);
  await page.evaluate(() => window.__idPhotoChanged && window.__idPhotoChanged());
  await page.waitForTimeout(200);
  const btnShown = await page.evaluate(() => {
    const b = document.getElementById("btnUseIdPhoto");
    return { display: document.getElementById("idPhotoRefWrap").style.display, text: b.textContent };
  });
  console.log("[2] 有证件照后按钮:", JSON.stringify(btnShown), btnShown.display !== "none" && /引用我的证件照/.test(btnShown.text) ? "✅" : "❌");

  await page.click("#btnUseIdPhoto");
  await page.waitForTimeout(300);
  const used = await page.evaluate(() => {
    const b = document.getElementById("btnUseIdPhoto");
    const ava = document.getElementById("avaPick");
    return { text: b.textContent, avaHasImg: !!ava.querySelector("img"), photoData: typeof photoData !== "undefined" ? "set" : "null" };
  });
  console.log("[3] 点击引用后:", JSON.stringify(used), used.avaHasImg && used.photoData === "set" && /已引用/.test(used.text) ? "✅" : "❌");

  // ========== 2. 登录 ==========
  await page.click('.tab[data-p="pageMine"]');
  await page.waitForTimeout(400);
  const auth0 = await page.evaluate(() => ({
    notLogin: document.getElementById("authNotLogin").style.display,
    loggedIn: document.getElementById("authLoggedIn").style.display,
  }));
  console.log("[4] 未登录态:", JSON.stringify(auth0), auth0.notLogin !== "none" && auth0.loggedIn === "none" ? "✅" : "❌");

  await page.click("#btnOpenLogin");
  await page.waitForTimeout(400);
  const maskShown = await page.evaluate(() => document.getElementById("maskLogin").classList.contains("show"));
  console.log("[5] 登录弹窗显示:", maskShown ? "✅" : "❌");

  // 发送验证码（拦截响应拿 devCode）
  let devCode = null;
  page.on("response", async r => {
    if (r.url().includes("auth/send-code")) {
      try { const d = await r.json(); if (d.devCode) devCode = d.devCode; } catch (e) {}
    }
  });
  await page.type("#loginPhone", "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"));
  await page.click("#btnSendCode");
  await page.waitForTimeout(9000);
  const btnSendText = await page.evaluate(() => document.getElementById("btnSendCode").textContent);
  const toastText = await page.evaluate(() => document.getElementById("toast").textContent);
  console.log("[6] 发码按钮状态:", btnSendText, "| toast:", toastText, devCode ? "devCode=" + devCode + " ✅" : "❌ 未拿到验证码");

  if (devCode) {
    await page.type("#loginCode", devCode);
    await page.click("#btnLoginOk");
    await page.waitForTimeout(1800);
    const after = await page.evaluate(() => ({
      maskOpen: document.getElementById("maskLogin").classList.contains("show"),
      auth: JSON.parse(localStorage.getItem("auth_v1") || "null"),
      loggedIn: document.getElementById("authLoggedIn").style.display,
      phone: document.getElementById("authPhone").textContent,
    }));
    console.log("[7] 登录后:", JSON.stringify(after), after.auth && after.auth.token && !after.maskOpen ? "✅" : "❌");
  }

  console.log("JS 错误:", errs.length ? errs.slice(0, 6) : "无 ✅");
  await browser.close();
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
