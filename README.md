# 微博超话一键签到

油猴脚本（Tampermonkey / Violentmonkey），批量签到你已关注的全部超级话题。

## ✨ 特性

| 触发方式 | 说明 |
|---|---|
| 🖱️ **手动按钮** | 页面右下角浮动面板，点「开始签到」 |
| 🌅 **打开微博自动签** | 每天第一次打开微博页面时自动跑（每日仅一次） |
| ⏰ **每日定时签** | 每天 `08:30` 自动签（需浏览器保持打开） |
| 🔀 **随机间隔** | 两个超话之间随机 3-8 秒，模拟正常用户行为 |
| 🛡️ **失败跳过** | 单个超话签到失败不影响其他，最后汇总报告 |

---

## 🚀 安装步骤

### 1. 安装油猴扩展

- **Chrome / Edge / Brave**：安装 [Tampermonkey](https://www.tampermonkey.net/)
- **Firefox**：安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)

### 2. 安装主签到脚本

把 `weibo-chaohua-autosign.user.js` 拖进浏览器，或者复制全部内容到油猴的「添加新脚本」页面保存。

### 3. ⚠️ 配置 API（关键！）

主脚本默认不带任何 API URL，需要先抓包填入。

**强烈推荐用「抓包助手」脚本**——它能绕过「点击跳新标签页」导致的抓包失败问题。

→ 直接看下面 [🔍 抓包助手流程](#-抓包助手流程推荐) 一节

如果不用助手，也可以手动 DevTools 抓包（难度更高）→ [📚 手动 DevTools 抓包](#-手动-devtools-抓包备选)

---

## 🔍 抓包助手流程（推荐）

### 原理

抓包助手脚本（`weibo-chaohua-sniffer.user.js`）直接 Hook 了浏览器的 `fetch` 和 `XMLHttpRequest`，**所有**微博 API 请求都会被记录下来，不依赖 DevTools、不受「跳新标签页」影响。

### Step 1：装上抓包助手脚本

把 `weibo-chaohua-sniffer.user.js` 也拖进浏览器安装。

> 注意：主签到脚本和抓包助手脚本**可以同时启用**。抓包完成后可以把助手禁用。

### Step 2：按顺序操作

1. 打开浏览器 → 访问 `https://weibo.com` 或 `https://m.weibo.cn`
2. 登录你的微博账号
3. 进入「超话」频道（首页有入口）
4. **点开任意一个超话**（这会触发关注列表接口 + 超话详情接口）
5. 在超话页面找到**「签到」按钮**，**点一次**
6. 等待 3-5 秒（让请求完成）

### Step 3：导出抓包结果

左下角会浮出一个抓包助手面板，显示捕获的请求数量（应该是 2-5 条）：

- 点 **「📥 导出 JSON」** → 下载 `weibo-capture-xxxxx.json`
- 或者点 **「📋 复制文本」** → 复制到剪贴板

### Step 4：把结果给 AI

两种方式都行：

- 把 JSON 文件路径告诉我（我直接读）
- 或者把复制出来的文本贴给我

我会帮你：
1. 识别出哪个是「关注列表接口」、哪个是「签到接口」
2. 提取 URL、参数、响应结构
3. 给出可直接粘贴的 `CONFIG.apis` 配置

### Step 5：填入主脚本

拿到我给的配置后：

1. 油猴扩展 → 找到「微博超话一键签到」脚本 → 编辑
2. 替换 `CONFIG.apis.listTopics` 和 `CONFIG.apis.signOne` 的内容
3. Ctrl+S 保存
4. 刷新微博页面
5. 右下角面板应该不再显示「请配置 API」
6. 点「开始签到」测试

### Step 6：禁用抓包助手

配置填好后，抓包助手就没用了。在油猴里禁用或删除它即可。

---

## 📚 手动 DevTools 抓包（备选）

### 关键开关：保留日志

DevTools → Network 面板 → 勾上 **「Preserve log」**（保留日志）。开启后页面跳转/刷新都不会清空请求记录。

### Step 1：抓「关注超话列表」接口

1. 浏览器登录微博
2. 进入「超话」页面，**等关注列表加载完**
3. F12 → Network → 筛选 Fetch/XHR
4. 找到返回超话数组的接口（URL 一般含 `chaohua` 或 `topic`）
5. 右键 → Copy → Copy link address
6. 点开请求 → Preview 标签，看响应结构

填到主脚本：

```javascript
apis: {
  listTopics: {
    url: '你抓到的URL',
    method: 'GET',
    responseMap: {
      topicsArray: 'data.cards',   // 超话数组在响应里的路径
      title: 'title',              // 超话名字段
      id: 'containerid',           // 超话 ID 字段
    },
  },
  // ...
}
```

### Step 2：抓「单个超话签到」接口

1. 在超话列表里**点开任一超话**（保留日志要打开，不然跳走就丢了）
2. 找到「签到」按钮，**先别点**
3. 清空 Network 记录
4. 点「签到」按钮
5. 立刻看到新冒出的 XHR 请求就是签到接口
6. 复制 URL + 请求体

填到主脚本：

```javascript
signOne: {
  url: '你抓到的URL',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  bodyTemplate: (topic) => `id=${encodeURIComponent(topic.id)}`,
  successFlag: (data) => data && data.code === 100000,
}
```

---

## ❓ 常见问题

### Q1：抓包助手没记录到任何请求

可能原因：
- 关键词没匹配：URL 里没有 `chaohua/huati/super/topic/checkin/follow/attention/button/cardlist`
- 抓包助手脚本没启用：油猴 → 已安装脚本里确认它处于「启用」状态

### Q2：拉取到 0 个超话

→ 检查 `responseMap.topicsArray` 路径是否正确。把 JSON 文件给我，我帮你看。

### Q3：所有超话都签到失败

→ 大概率是接口 URL 不对或 CSRF token 失效。把 JSON 文件给我，我帮你看响应结构。

### Q4：被风控了怎么办

- 把 `CONFIG.retry.maxDelayMs` 调到 `15000`（15 秒）
- 把 `CONFIG.triggers.scheduledTime` 改到早上 7 点或晚上 11 点（避开高峰）
- 临时关掉 `autoOnVisit`，只手动触发

### Q5：定时签到不生效

油猴脚本的定时器依赖浏览器保持打开。如果你关掉浏览器就签不到。

---

## 🛠️ 调试技巧

打开 DevTools Console：

```javascript
// 强制再触发一次签到（绕过每日一次限制）
GM_setValue('wc_lastAutoDate', '');
```

如果脚本行为异常，截图控制台报错 + Network 请求，发给 AI。

---

## 📁 项目结构

```
weibo-chaohua-autosign/
├── weibo-chaohua-autosign.user.js   # 主签到脚本（24KB）
├── weibo-chaohua-sniffer.user.js    # 抓包助手（临时用，配置完成后可禁用）
└── README.md                         # 本文档
```

---

## ⚠️ 免责声明

- 本脚本仅供个人学习使用，请勿用于商业或刷量目的
- 微博接口随时可能变更，脚本失效属正常现象
- 使用本脚本造成的账号风险由使用者自行承担