/* 把 flowchart.html 里三个 .page 区块渲染成 PNG（deviceScaleFactor 2 高清） */
const { chromium } = require("playwright-core");
const path = require("path");

const CHROME = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const HTML_PATH = "file:///C:/Users/21474/WorkBuddy/appwork/resume-cap/flowchart/flowchart.html";
const OUT = "C:/Users/21474/WorkBuddy/appwork/resume-cap/flowchart/";

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(HTML_PATH, { waitUntil: "networkidle" });
  await new Promise(r => setTimeout(r, 800));

  const names = ["01_核心业务流程图", "02_微信支付集成流程", "03_功能架构与商业模式"];
  const pages = await page.$$(".page");
  for (let i = 0; i < names.length && i < pages.length; i++) {
    const file = OUT + names[i] + ".png";
    await pages[i].screenshot({ path: file });
    const b = require("fs").readFileSync(file);
    console.log("saved:", file, b.readUInt32BE(16) + "x" + b.readUInt32BE(20));
  }
  await browser.close();
})().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
