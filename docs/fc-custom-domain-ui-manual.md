# api.coldtank.cn 绑定 FC — 自动化受阻状态 + 人工操作版步骤

> 更新 2026-09-05：本机已自动完成 **DNS CNAME 解析**（不可逆关键步骤 ✅），FC 域名创建在自动化环境中受阻（详见"受阻原因"）。
> 此文档 = 在任何正常浏览器里 3 分钟手工完成的剩余步骤。DNS 已生效，你只差 FC 控制台两步 + 验证。

---

## ✅ 已完成（自动，无需重做）

**DNS 解析**：`api.coldtank.cn` → CNAME → `1876025528038306.cn-hangzhou.fc.aliyuncs.com` 已添加并生效（RecordId 2096063582290426880，DoH 已确认 CNAME 返回）

验证命令：
```bash
nslookup api.coldtank.cn   # 应解析出 47.98.x / 114.55.x / 8.154.x 等阿里云杭州 IP
```

---

## ❌ 自动化受阻原因（技术备忘，非你操作问题）

1. **本机网络阻断 `cn-hangzhou.ide.fc.aliyun.com`**：FC 3.0 新版域名管理 UI 内容区加载自该域，本机 curl（直连+代理）/chromium/Edge 全部 SSL_PROTOCOL_ERROR 或超时 → 新版 UI 无法操作
2. **旧版表单 `/cn-hangzhou/domains/create` 是 FC 2.0 语义**：要求选"服务"，但账号函数是 **FC 3.0 原生函数（无服务实体）**，服务下拉为空，表单无法提交
3. **控制台 OpenAPI 直调（data/api.json）仅支持 2.0 RPC 封装**：CreateCustomDomain 报 `InvalidArgument: EOF`（3.0 REST camelCase body 不被 2.0 RPC 网关解析）
4. 根因链条 = 新版 UI 需要 ide 域（本机被断）→ 旧版表单不适用 3.0 → 直调网关不支持 3.0

**结论**：FC 3.0 域名绑定需要在**能正常访问 ide.fc.aliyun.com 的网络**（坡哥日常浏览器/手机热点）手工完成，步骤见下。

---

## 📋 剩余手工步骤（任意正常浏览器，3 分钟）

### 第 1 步：进入新版域名管理
```
浏览器打开 https://fcnext.console.aliyun.com/cn-hangzhou/domains
（登录坡哥阿里云账号 3466***@qq.com；若弹出新界面，左侧菜单：服务及函数 → 域名管理）
```
> 若此 URL 打开后内容空白/加载失败 = 当前网络同样断 ide 域 → 换网络（手机热点/其他电脑）再试
> 若弹出"旧版/新版"切换，务必用**新版**（旧版表单不支持 3.0 函数）

### 第 2 步：添加自定义域名
1. 点 **添加自定义域名**
2. 域名：`api.coldtank.cn`（DNS 我已配好，应显示 CNAME 已生效）
3. 协议：先 **HTTP**（证书后补，见第 5 步）
4. 路由配置：路径 `/*` → 函数选 **resume-api-v6** → 版本/别名 **LATEST**
5. 认证：**无需认证**（anonymous）
6. WAF/CDN：关闭
7. 点 **创建**

### 第 3 步：验证
```bash
curl http://api.coldtank.cn/health
# 期望返回 {"ok":true,...}（与 fcapp.run 相同）
```

### 第 4 步：改前端域名（唯一代码改动）
`www/index.html` 第 1827 行：
```diff
- const AI_WORKER_URL="https://resume-api-v-vzmoobafoo.cn-hangzhou.fcapp.run/";
+ const AI_WORKER_URL="https://api.coldtank.cn/";
```
commit + push → CI 出新 release 包

### 第 5 步：补 HTTPS（微信支付回调需要，可选但建议）
1. 证书方案：阿里云 DV 订阅 ¥194/首年（自动续期，推荐）或 Let's Encrypt（免费但 90 天手动续）
2. FC 域名管理 → 编辑 api.coldtank.cn → HTTPS 启用 → 选证书（阿里云证书 / 手动上传 PEM）
3. 微信回调自动跟随（后端 origin 动态取 Host，零改动）

---

## ⏭️ 当前优先级建议

**FC 域名绑定不阻塞 App 备案提交** —— 备案表域名填 `coldtank.cn`（裸域）即可，两者并行：
1. 🥇 今天：手机阿里云 App 提交 App 备案（手册 docs/app-beian-submit-guide.md）
2. 🥈 有空：按本文档第 1-4 步在正常网络下完成 FC 域名绑定（5 分钟）
3. 🥉 之后：证书 + HTTPS（可选付费）

**收益提醒**：绑定后 App 摆脱 fcapp.run 共享域风险 + 备案登记名正言顺。但即便暂不绑定，App 也照常工作（fcapp.run 一直在线）。
