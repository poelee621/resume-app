const { chromium } = require('playwright-core');
const path = require('path');

(async () => {
  const exe = process.env.PW_CHROMIUM;
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto('file:///' + path.resolve(__dirname, '../www/index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1500);

  // 1. 直接调 showFullPreview 注入一张 1x1 png，检查文案
  const res = await page.evaluate(() => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    showFullPreview([png, png], 'png');
    const box = document.getElementById('fullPreview');
    const top = box.querySelector('span').textContent;
    const save = document.getElementById('fpSave').textContent;
    const close = document.getElementById('fpClose').textContent;
    return { top, save, close, html: box.innerHTML.slice(0, 400) };
  });
  console.log('TOP  :', res.top);
  console.log('SAVE :', res.save);
  console.log('CLOSE:', res.close);
  const bad = /长按图片存相册|保存相册|长按图片保存/.test(res.top + res.save + res.close);
  console.log('旧文案残留:', bad ? 'YES ❌' : 'NO ✅');

  // 2. Web 无原生插件 → 点保存应弹提示且按钮变「重试」
  await page.click('#fpSave');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('fpSave').textContent);
  console.log('无插件点保存后按钮:', after, after === '重试' ? '✅' : '❌');
  await page.waitForTimeout(2800);
  const restored = await page.evaluate(() => document.getElementById('fpSave').textContent);
  console.log('2.6s 后按钮恢复:', restored, restored === '保存' ? '✅' : '❌');

  // 3. 检查 index.html 全文中按钮相关旧文案
  const src = require('fs').readFileSync(path.resolve(__dirname, '../www/index.html'), 'utf8');
  const hits = src.match(/长按图片保存|保存相册/g);
  console.log('源文件旧文案命中:', hits ? hits.length + ' 处 → ' + [...new Set(hits)].join(',') : '0 ✅');

  console.log('JS 错误:', errs.length ? errs.slice(0, 5) : '无 ✅');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
