# AI简历工坊 · FC 绑定自有域名 api.coldtank.cn 操作清单

> **目的**：App 后端从阿里云共享域名 `resume-api-v-...fcapp.run` 切换到烯冷自己的已备案域名 `api.coldtank.cn`
> **为什么必须做**：① App 备案登记域名与实际服务域名必须一致（否则审核抽查露馅/退单）；② fcapp.run 共享域有被批量封禁的合规风险，一旦被封 App 全挂
> **好消息**：后端代码零改动（`origin` 动态取 Host，支付回调自动跟随）；**只需改前端 1 行**（见第 6 步）

---

## 📋 前置条件（全部已满足 ✅）

| 项 | 状态 |
|---|---|
| 域名 coldtank.cn 已 ICP 备案（浙ICP备2023000754号，烯冷主体） | ✅ |
| 域名在阿里云接入备案（网站备案就是阿里云做的） | ✅ |
| 域名 DNS 在阿里云云解析（NS=dns8/dns7.hichina.com） | ✅ |
| 阿里云账号实名 = 烯冷（与备案主体一致） | ✅ |
| FC 函数 resume-api-v6（杭州）运行中 | ✅ |

---

## 第 1 步：FC 控制台添加自定义域名（拿 CNAME）

1. 浏览器登录**阿里云控制台** → 搜索「函数计算 FC」→ 进入
2. 顶部**地域切换到「华东1（杭州）」**（函数所在 region，必须一致）
3. 左侧菜单：**函数管理 → 域名管理**
4. 点 **添加自定义域名**
5. **域名**填：`api.coldtank.cn`（先别提交，页面会显示 CNAME）
6. **复制页面上的「公网 CNAME」**（形如 `1xxxxxxxxxxxxxx.cn-hangzhou.fc.aliyuncs.com`）——下一步要用
7. **这个页面先别关**，第 3 步还要回来点「创建」

> ⚠️ 页面提示「InvalidICPLicense」= 域名未在阿里云接入备案；我们是阿里云备案的，不会出现。若提示 DomainNameNotResolved = 第 2 步 CNAME 没生效或填错。

---

## 第 2 步：云解析 DNS 加 CNAME 记录

1. 新标签打开**云解析 DNS 控制台** → 公网DNS解析 → 权威域名解析
2. 域名列表找 `coldtank.cn` → 点 **解析设置**
3. 点 **添加记录**，按此填：

| 配置项 | 填什么 |
|---|---|
| 记录类型 | **CNAME** |
| 主机记录 | **api**（代表 api.coldtank.cn；别填 @，根域名 CNAME 有坑） |
| 记录值 | 第 1 步复制的 **FC 公网 CNAME**（`xxx.cn-hangzhou.fc.aliyuncs.com`） |
| TTL | 默认（10 分钟） |

4. 保存。**等待 2-5 分钟**生效（可用 `nslookup api.coldtank.cn` 验证返回 FC 域名）

---

## 第 3 步：回 FC 页面完成自定义域名创建

回到第 1 步那个「添加自定义域名」页面，配置：

### 3.1 路由配置
| 配置项 | 填什么 |
|---|---|
| 路径 | `/*` |
| 函数名称 | `resume-api-v6`（或页面下拉里显示的实际函数名） |
| 版本或别名 | **LATEST** |
| 重写策略 | 留空 |

### 3.2 HTTPS 设置 ⭐
| 配置项 | 填什么 |
|---|---|
| HTTPS | **开启** |
| 证书类型 | **阿里云 SSL 证书**（若下拉为空 → 先去数字证书管理服务申请免费证书，见下方⚠️） |
| 重定向 HTTP→HTTPS | 勾选 |
| TLS 版本 | 默认（TLSv1.2 及以上） |

### 3.3 认证设置 ⭐
| 配置项 | 填什么 |
|---|---|
| 认证方式 | **无需认证**（前端 App + 微信支付回调都要匿名访问，跟现在触发器一致） |

### 3.4 WAF
**不开**（省费用，App 无此必要）

→ 点 **创建**。

> ⚠️ **免费证书申请**（若第 3.2 步证书下拉为空）：
> 1. 控制台搜「数字证书管理服务」→ 证书申请 → **免费证书** → 创建证书
> 2. 申请域名填 `api.coldtank.cn`
> 3. 验证方式选 **DNS 验证** → 因为域名在阿里云云解析，直接点「自动DNS验证」→ 秒级通过
> 4. 签发后回到 FC 自定义域名页，证书下拉就能选到（同名证书）
> 5. 免费证书有效期约 3 个月 → 到期前续签 + FC 页面重新选择（建议日历提醒）

---

## 第 4 步：验证域名连通性

命令行验证（本机即可，无需服务器）：
```bash
curl -s https://api.coldtank.cn/health
# 期望返回 {"ok":true,...} —— 与 fcapp.run 结果一致
```

再验证微信回调路径能通：
```bash
curl -s -X POST https://api.coldtank.cn/pay/callback -H "Content-Type: application/json" -d '{}'
# 返回非 5xx 即可（空回调返回 4xx 属正常，重点是 TLS/路由通了）
```

---

## 第 5 步：改前端 API 地址（唯一代码改动）

文件：`www/index.html` 第 **1827** 行

```diff
- const AI_WORKER_URL="https://resume-api-v-vzmoobafoo.cn-hangzhou.fcapp.run/";
+ const AI_WORKER_URL="https://api.coldtank.cn/";
```

改完 commit + push → CI 自动出**同款 release 签名包**（含微信 SDK，签名不变，用户可平滑升级）：
```bash
cd resume-cap
git add www/index.html
git commit -m "feat: 后端域名切换到 api.coldtank.cn（备案一致性 + 摆脱 fcapp.run 共享域风险）"
git push origin master
```
（本机 push 需要 SSH key，或坡哥在本地仓库手动 push）

---

## 第 6 步：回归验证（域名切换后必跑）

1. 下载新 release APK → 安装 → 手机号登录 ✅
2. 生成一份简历 → AI 润色一次（走 DeepSeek 代理）✅
3. 微信一键登录（开放平台回调域名不受影响，用的是 www.coldtank.cn 备案的 app 场景）✅
4. H5 支付下单 → 出收银台二维码（若 H5 支付审核已通过）✅
5. 后端日志确认新域名请求正常（FC 控制台 → 函数 → 日志查询，过滤 api.coldtank.cn）

---

## ↩️ 回滚方案（万一出问题）

- 前端改回 fcapp.run + push → 新包恢复旧域名（旧域名在 FC 域名没删前一直可用）
- FC 自定义域名删除：域名管理 → 删除 api.coldtank.cn（DNS CNAME 记录也可保留不动，无副作用）

---

## 🎯 切换后的收益

| 项 | 切换前（fcapp.run） | 切换后（api.coldtank.cn） |
|---|---|---|
| App 备案一致性 | ❌ 登记域名 ≠ 实际服务域名 | ✅ 名正言顺 |
| 封禁风险 | ⚠️ 共享域被滥用可能连坐 | ✅ 自有域名 |
| 微信支付回调 | ✅ 正常 | ✅ 自动跟随（origin 动态） |
| 以后迁云 | 要改 App | ✅ 只改 DNS/FC |
| 备案审核抽查 | ❌ 有露馅风险 | ✅ 可提供 api.coldtank.cn 佐证 |

---

## ⏱️ 时间预估

FC 页面 5 分钟 + DNS 2 分钟 + 免费证书 5 分钟（自动验证秒级）+ 验证 5 分钟 ≈ **20 分钟一次搞定**。做完后 App 备案表里「后台服务域名」照填 `coldtank.cn` 或 `api.coldtank.cn` 都理直气壮。