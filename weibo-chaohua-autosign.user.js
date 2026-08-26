// ==UserScript==
// @name         微博超话一键签到
// @namespace    https://github.com/tom/weibo-chaohua-autosign
// @version      1.0.0
// @description  微博超级话题批量签到工具，支持手动按钮 / 打开微博自动签 / 每日定时签三种触发方式
// @author       Tom
// @match        https://weibo.com/*
// @match        https://m.weibo.cn/*
// @match        https://weibo.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * 微博超话一键签到
 * 主入口：init() → createPanel() + setupTriggers()
 * 核心流程：runBatchSign() → fetchFollowedTopics() → 循环 signOne()
 *
 * ⚠️ 重要：CONFIG.apis.listTopics.url 和 CONFIG.apis.signOne.url 需要在浏览器登录微博后
 *         抓包获取真实接口填入，详细步骤见 README.md
 */

(function () {
    'use strict';

    // ========================================================================
    // ⚙️ 配置层
    // ========================================================================

    /** @type {{
     *   triggers: { autoOnVisit: boolean, scheduledTime: string, enableNotification: boolean },
     *   retry: { minDelayMs: number, maxDelayMs: number, maxRetries: number },
     *   apis: {
     *     listTopics: {
     *       url: string, method: 'GET'|'POST', headers: Object<string,string>,
     *       responseMap: { topicsArray: string, title: string, id: string }
     *     },
     *     signOne: {
     *       url: string, method: 'GET'|'POST', headers: Object<string,string>,
     *       bodyTemplate: (topic: {title: string, id: string}) => string,
     *       successFlag: (data: any) => boolean
     *     }
     *   },
     *   debug: boolean
     * }} */
    const CONFIG = {
        // ---- 触发配置 ----
        triggers: {
            autoOnVisit: true,           // 打开微博页面时，若今日未签则自动签
            scheduledTime: '08:30',      // 每日定时签到时间（需要浏览器保持打开）
            enableNotification: true,    // 完成后桌面通知
        },

        // ---- 容错配置 ----
        retry: {
            minDelayMs: 3000,            // 两个超话之间的最小间隔
            maxDelayMs: 8000,            // 两个超话之间的最大间隔
            maxRetries: 0,               // 单个超话失败后是否重试（默认不重试）
        },

        // ---- API 配置 ----
        // ✅ 两个接口都已从抓包填入
        apis: {
            // 关注超话列表接口（GET 请求）— ✅ 已抓包填入
            listTopics: {
                url: 'https://weibo.com/ajax/profile/topicContent?tabid=231093_-_chaohua',
                method: 'GET',
                headers: {
                    'X-XSRF-TOKEN': '__AUTO_FROM_COOKIE__',
                    'client-version': '3.0.0',           // 微博桌面 web 客户端标识（必须与抓包一致）
                    'Referer': 'https://weibo.com/',     // 必须，否则 403
                },
                responseMap: {
                    topicsArray: 'data.list',   // 超话数组路径
                    title: 'title',             // 超话名字段
                    id: 'link',                 // 超话 ID 字段（脚本会从 link 自动提取 page_id）
                },
            },

            // 单个超话签到接口（POST 请求）— ✅ 已抓包填入
            signOne: {
                url: 'https://weibo.com/ajax_proxy/chaohua/page/checkin',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-XSRF-TOKEN': '__AUTO_FROM_COOKIE__',
                    'client-version': '3.0.0',           // 微博桌面 web 客户端标识（必须与抓包一致）
                    'Referer': 'https://weibo.com/',     // 必须，否则 403
                },
                // 请求体模板：page_id 是动态的，其他字段固定
                bodyTemplate: (/** @type {{title:string,id:string}} */ topic) => {
                    const params = new URLSearchParams();
                    params.set('scene_id', 'pc_checkin');
                    params.set('page_id', topic.id);
                    params.set('timezone', 'Asia/Shanghai');
                    params.set('lang', 'zh-CN');
                    params.set('plat', 'Win32');
                    params.set('ua', navigator.userAgent);
                    return params.toString();
                },
                // 判定签到成功的回调
                // 已签到返回示例：{"code":100001,"msg":"已签到","result":1}
                // 签到成功返回示例：{"code":100000,"msg":"签到成功","result":1}
                successFlag: (/** @type {any} */ data) =>
                    data && (data.code === 100000 || data.code === 100001),
            },
        },

        debug: true,
    };

    // ========================================================================
    // 📦 状态层
    // ========================================================================

    /** @type {{
     *   isRunning: boolean,
     *   shouldStop: boolean,
     *   topics: Array<{title: string, id: string}>,
     *   signedCount: number,
     *   failedCount: number,
     *   startTime: number
     * }} */
    const state = {
        isRunning: false,
        shouldStop: false,
        topics: [],
        signedCount: 0,
        failedCount: 0,
        startTime: 0,
    };

    // ========================================================================
    // 🛠️ 工具函数
    // ========================================================================

    /**
     * 结构化日志
     * @param {'info'|'success'|'warn'|'error'|'debug'} level
     * @param {string} msg
     * @param {Object<string, any>=} meta
     */
    function log(level, msg, meta) {
        if (!CONFIG.debug && level !== 'error') return;
        const prefix = {
            info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', debug: '🔍',
        }[level] || 'ℹ️';
        const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        console.log(
            `%c[超话签到] ${prefix} ${msg}${metaStr}`,
            'color:#F1752D;font-weight:bold',
        );
    }

    /** @param {number} ms */
    function sleep(ms) {
        return new Promise(/** @type {() => void} */ (r) => setTimeout(r, ms));
    }

    /** @returns {number} ms */
    function randomDelay() {
        const { minDelayMs, maxDelayMs } = CONFIG.retry;
        return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    }

    /** @returns {string} 形如 'Wed Jul 01 2026' */
    function todayKey() {
        return new Date().toDateString();
    }

    /**
     * 按点号路径读取对象
     * @param {any} obj
     * @param {string} path
     * @returns {any}
     */
    function getPath(obj, path) {
        return path.split('.').reduce((/** @type {any} */ o, /** @type {string} */ k) =>
            (o == null ? undefined : o[k]), obj);
    }

    /**
     * 桌面通知
     * @param {string} title
     * @param {string} body
     */
    function notify(title, body) {
        if (!CONFIG.triggers.enableNotification) return;
        try {
            if (typeof GM_notification !== 'undefined') {
                GM_notification({ title, text: body, silent: false });
            } else if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification(title, { body });
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission().then((/** @type {string} */ p) => {
                        if (p === 'granted') new Notification(title, { body });
                    });
                }
            }
        } catch (e) {
            log('warn', '通知发送失败', { error: String(e) });
        }
    }

    // ========================================================================
    // 🌐 GM 跨域请求封装
    // ========================================================================

    /**
     * @typedef {Object} FetchOptions
     * @property {string} url
     * @property {'GET'|'POST'} [method]
     * @property {Object<string,string>} [headers]
     * @property {string|null} [data]
     */

    /**
     * 从 Cookie 读取 XSRF token
     * 微博的 XSRF-TOKEN cookie 名称可能是 'XSRF-TOKEN' 或 'SUB'
     * @returns {string}
     */
    function getXsrfTokenFromCookie() {
        // 优先 XSRF-TOKEN
        let m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
        if (m) return decodeURIComponent(m[1]);
        // 备用：SUB（新浪通用 token，前 4 位通常是时间戳）
        m = document.cookie.match(/(?:^|;\s*)SUB=([^;]*)/);
        if (m) return decodeURIComponent(m[1]);
        return '';
    }

    /**
     * @param {FetchOptions} opts
     * @returns {Promise<any>}
     */
    function gmFetch(opts) {
        const method = opts.method || 'GET';
        // 合并 header，特殊处理 X-XSRF-TOKEN 的自动注入
        const finalHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            ...(opts.headers || {}),
        };
        // 把占位符替换为真实 cookie 值
        for (const k of Object.keys(finalHeaders)) {
            if (finalHeaders[k] === '__AUTO_FROM_COOKIE__') {
                finalHeaders[k] = getXsrfTokenFromCookie();
                if (!finalHeaders[k]) {
                    log('warn', `Header ${k} 需要从 cookie 读取，但未找到 XSRF-TOKEN/SUB`);
                }
            }
        }
        return new Promise((/** @type {(v:any)=>void,'(e:any)=>void'} */ resolve, reject) => {
            log('debug', `${method} ${opts.url}`, opts.data ? { body: opts.data } : {});
            GM_xmlhttpRequest({
                method,
                url: opts.url,
                headers: finalHeaders,
                data: opts.data || undefined,
                withCredentials: true,
                timeout: 15000,
                onload: (/** @type {any} */ res) => {
                    log('debug', `← ${res.status}`, {
                        size: (res.responseText || '').length,
                        preview: (res.responseText || '').slice(0, 200),
                    });
                    if (res.status >= 200 && res.status < 300) {
                        try {
                            resolve(JSON.parse(res.responseText));
                        } catch {
                            resolve(res.responseText);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.status}`));
                    }
                },
                onerror: (/** @type {any} */ err) => reject(new Error(err.error || '网络错误')),
                ontimeout: () => reject(new Error('请求超时')),
            });
        });
    }

    // ========================================================================
    // 📋 API 层
    // ========================================================================

    /**
     * 从各种形式提取纯 page_id
     * 支持：
     *   - '//weibo.com/p/100808xxx' → '100808xxx'
     *   - 'https://weibo.com/p/100808xxx' → '100808xxx'
     *   - '1022:100808xxx' (oid 形式) → '100808xxx'
     *   - '100808xxx' (纯 ID) → '100808xxx'
     * @param {string} raw
     * @returns {string}
     */
    function extractPageId(raw) {
        if (!raw) return '';
        const s = String(raw);
        // 纯 ID（字母数字，长度 > 5）
        if (/^[a-zA-Z0-9]{6,}$/.test(s)) return s;
        // 从 URL 提取 /p/(\w+)
        const m1 = s.match(/\/p\/([a-zA-Z0-9]+)/);
        if (m1) return m1[1];
        // 从 oid 提取 :(\w+)
        const m2 = s.match(/^[\w]+:([a-zA-Z0-9]+)$/);
        if (m2) return m2[1];
        return s;
    }

    /**
     * 拉取已关注的超话列表
     * @returns {Promise<Array<{title: string, id: string}>>}
     */
    async function fetchFollowedTopics() {
        const { url, method, headers, responseMap } = CONFIG.apis.listTopics;
        if (!url) {
            throw new Error('未配置 listTopics.url，请先按 README 抓包填入接口');
        }
        const res = await gmFetch({ url, method: /** @type any */ (method), headers });
        const arr = getPath(res, responseMap.topicsArray);
        if (!Array.isArray(arr)) {
            throw new Error(`响应结构不符合预期：未找到路径 ${responseMap.topicsArray}`);
        }
        const topics = arr
            .map((/** @type {any} */ item) => {
                const rawId = getPath(item, responseMap.id);
                return {
                    title: getPath(item, responseMap.title),
                    id: extractPageId(String(rawId || '')),
                };
            })
            .filter((/** @type {{title:any,id:any}} */ t) => t.title && t.id);
        if (topics.length === 0) {
            throw new Error('解析出 0 个超话，请检查 responseMap 配置或确认已登录');
        }
        log('info', `解析到 ${topics.length} 个超话`);
        return topics;
    }

    /**
     * 签到单个超话
     * @param {{title: string, id: string}} topic
     * @returns {Promise<boolean>}
     */
    async function signOne(topic) {
        const { url, method, headers, bodyTemplate, successFlag } = CONFIG.apis.signOne;
        if (!url) {
            throw new Error('未配置 signOne.url，请先按 README 抓包填入接口');
        }
        const body = bodyTemplate(topic);
        const res = await gmFetch({
            url,
            method: /** @type any */ (method),
            headers,
            data: body,
        });
        const ok = successFlag(res);
        if (!ok) {
            log('warn', `签到响应未达成功条件`, {
                topic: topic.title,
                code: res && res.code,
                msg: res && (res.msg || res.message),
            });
        }
        return ok;
    }

    // ========================================================================
    // 🚀 调度层：批量签到主流程
    // ========================================================================

    async function runBatchSign() {
        if (state.isRunning) {
            log('warn', '已在签到中，忽略重复启动');
            return;
        }
        if (!CONFIG.apis.listTopics.url || !CONFIG.apis.signOne.url) {
            updateUI('error', '⚠️ 请先在脚本 CONFIG 中配置 API 接口');
            notify('超话签到未配置', '请打开脚本编辑 CONFIG.apis');
            return;
        }

        state.isRunning = true;
        state.shouldStop = false;
        state.signedCount = 0;
        state.failedCount = 0;
        state.startTime = Date.now();
        clearResults();

        try {
            state.topics = await fetchFollowedTopics();
            updateUI('running', `开始签到，共 ${state.topics.length} 个`);

            for (let i = 0; i < state.topics.length; i++) {
                if (state.shouldStop) {
                    log('warn', `用户中止，已完成 ${i}/${state.topics.length}`);
                    break;
                }
                const topic = state.topics[i];
                updateUI('running', `[${i + 1}/${state.topics.length}] ${topic.title}`);

                try {
                    const ok = await signOne(topic);
                    if (ok) {
                        state.signedCount++;
                        log('success', `${topic.title}`);
                        appendResult(i + 1, state.topics.length, topic.title, true, '');
                    } else {
                        state.failedCount++;
                        appendResult(i + 1, state.topics.length, topic.title, false, '接口未达成功条件');
                    }
                } catch (e) {
                    state.failedCount++;
                    log('error', `签到异常：${topic.title}`, { error: e.message });
                    appendResult(i + 1, state.topics.length, topic.title, false, e.message);
                }

                // 两个超话之间随机等待（最后一个不等待）
                if (i < state.topics.length - 1 && !state.shouldStop) {
                    const delay = randomDelay();
                    log('debug', `等待 ${(delay / 1000).toFixed(1)}s`);
                    await sleep(delay);
                }
            }

            const cost = ((Date.now() - state.startTime) / 1000).toFixed(1);
            const summary =
                `✅ ${state.signedCount}  ❌ ${state.failedCount}  ⏱️ ${cost}s`;
            log('success', `签到完成 ${summary}`);
            updateUI('idle', summary);
            notify('微博超话签到完成', summary);
        } catch (e) {
            log('error', '签到流程失败', { error: e.message });
            updateUI('error', e.message);
            notify('微博超话签到失败', e.message);
        } finally {
            state.isRunning = false;
        }
    }

    function stopBatchSign() {
        if (state.isRunning) {
            state.shouldStop = true;
            log('warn', '收到停止指令，将在当前超话完成后停止');
        }
    }

    // ========================================================================
    // 🎨 UI 层：右下角浮动面板
    // ========================================================================

    /**
     * 更新面板状态
     * @param {'idle'|'running'|'error'} status
     * @param {string} msg
     */
    function updateUI(status, msg) {
        const panel = document.getElementById('wc-panel');
        if (!panel) return;
        const statusEl = panel.querySelector('.wc-status');
        const msgEl = panel.querySelector('.wc-msg');
        if (statusEl) {
            statusEl.dataset.status = status;
            statusEl.textContent =
                ({ idle: '就绪', running: '签到中', error: '错误' })[status] || status;
        }
        if (msgEl) msgEl.textContent = msg;
    }

    /**
     * 追加一条签到结果到面板历史列表
     * @param {number} index 当前序号（从 1 开始）
     * @param {number} total 总数
     * @param {string} title 超话名
     * @param {boolean} success 是否成功
     * @param {string} reason 失败原因（成功时为空）
     */
    function appendResult(index, total, title, success, reason) {
        const panel = document.getElementById('wc-panel');
        if (!panel) return;
        const list = panel.querySelector('.wc-results');
        if (!list) return;
        // 清掉"暂无记录"
        if (list.querySelector('.wc-empty')) list.innerHTML = '';
        const row = document.createElement('div');
        row.className = `wc-result ${success ? 'wc-result-ok' : 'wc-result-fail'}`;
        const icon = success ? '✓' : '✗';
        const reasonHtml = success || !reason ? '' :
            `<span class="wc-reason" title="${reason}">(${reason.slice(0, 30)})</span>`;
        row.innerHTML = `<span class="wc-result-icon">${icon}</span>` +
            `<span class="wc-result-idx">[${index}/${total}]</span>` +
            `<span class="wc-result-title" title="${title}">${title}</span>` +
            reasonHtml;
        list.appendChild(row);
        // 自动滚动到最新一条
        list.scrollTop = list.scrollHeight;
    }

    /** 清空签到历史列表 */
    function clearResults() {
        const list = document.querySelector('#wc-panel .wc-results');
        if (list) {
            list.innerHTML = '<div class="wc-empty">暂无记录</div>';
        }
    }

    function createPanel() {
        if (document.getElementById('wc-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'wc-panel';
        panel.innerHTML = `
            <div class="wc-header">
                <span class="wc-title">🐤 超话签到</span>
                <span class="wc-status" data-status="idle">就绪</span>
                <button class="wc-toggle" title="折叠/展开">−</button>
            </div>
            <div class="wc-body">
                <div class="wc-msg">未运行</div>
                <div class="wc-actions">
                    <button class="wc-btn wc-btn-primary" id="wc-btn-start">开始签到</button>
                    <button class="wc-btn wc-btn-warn" id="wc-btn-stop">停止</button>
                    <button class="wc-btn wc-btn-link" id="wc-btn-help">抓包指南</button>
                </div>
                <div class="wc-triggers" id="wc-triggers">
                    <div class="wc-trigger-row">
                        <span class="wc-trigger-label">🌅 打开自动签</span>
                        <span class="wc-trigger-status" id="wc-trigger-auto">—</span>
                    </div>
                    <div class="wc-trigger-row">
                        <span class="wc-trigger-label">⏰ 每日定时</span>
                        <span class="wc-trigger-status" id="wc-trigger-sched">—</span>
                    </div>
                </div>
                <div class="wc-results-wrap">
                    <div class="wc-results-title">签到历史 <span class="wc-results-hint">自动滚动</span></div>
                    <div class="wc-results"><div class="wc-empty">暂无记录</div></div>
                </div>
                <div class="wc-debug-actions">
                    <button class="wc-btn wc-btn-tiny" id="wc-btn-reset-auto">重置自动签</button>
                    <button class="wc-btn wc-btn-tiny" id="wc-btn-reset-sched">重置定时签</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        injectStyle();
        bindUIEvents();
    }

    function injectStyle() {
        if (document.getElementById('wc-style')) return;
        const style = document.createElement('style');
        style.id = 'wc-style';
        style.textContent = `
            #wc-panel {
                position: fixed; right: 20px; bottom: 20px; z-index: 999999;
                width: 320px; background: #FFF3CD; color: #333;
                border: 2px solid #F1752D; border-radius: 12px;
                box-shadow: 0 6px 20px rgba(0,0,0,.15);
                font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                transition: all .2s;
            }
            #wc-panel.wc-collapsed .wc-body { display: none; }
            #wc-panel .wc-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 14px; background: #F1752D; color: #fff;
                border-radius: 10px 10px 0 0; font-weight: 600;
                cursor: move; user-select: none;
            }
            #wc-panel .wc-status {
                padding: 2px 8px; border-radius: 10px;
                background: rgba(255,255,255,.25); font-size: 11px;
            }
            #wc-panel .wc-status[data-status="running"] {
                background: #E84A5F; animation: wc-pulse 1.5s infinite;
            }
            #wc-panel .wc-status[data-status="error"] { background: #c0392b; }
            @keyframes wc-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
            #wc-panel .wc-toggle {
                background: none; border: none; color: #fff;
                font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;
            }
            #wc-panel .wc-body { padding: 12px 14px; }
            #wc-panel .wc-triggers {
                margin-top: 10px;
                padding: 8px 10px;
                background: rgba(255,255,255,.5);
                border-radius: 6px;
                font-size: 11px;
            }
            #wc-panel .wc-trigger-row {
                display: flex; justify-content: space-between;
                padding: 2px 0;
            }
            #wc-panel .wc-trigger-label {
                color: #666;
            }
            #wc-panel .wc-trigger-status {
                color: #999;
                font-weight: 500;
            }
            #wc-panel .wc-trigger-status.wc-trigger-done {
                color: #28a745;
            }
            #wc-panel .wc-trigger-status.wc-trigger-pending {
                color: #F1752D;
            }
            #wc-panel .wc-debug-actions {
                display: flex; gap: 4px; margin-top: 8px;
            }
            #wc-panel .wc-btn-tiny {
                flex: 1; padding: 4px 6px;
                border: 1px dashed #ccc; background: transparent;
                color: #999; border-radius: 4px;
                font-size: 10px; min-width: auto;
            }
            #wc-panel .wc-btn-tiny:hover {
                border-color: #F1752D; color: #F1752D;
                background: transparent;
            }
            #wc-panel .wc-results-wrap {
                margin-top: 10px;
                border-top: 1px dashed rgba(241,117,45,.4);
                padding-top: 8px;
            }
            #wc-panel .wc-results-title {
                display: flex; justify-content: space-between;
                font-size: 11px; color: #999; margin-bottom: 4px;
                text-transform: uppercase; letter-spacing: 1px;
            }
            #wc-panel .wc-results-hint {
                font-size: 10px; color: #bbb; text-transform: none; letter-spacing: 0;
            }
            #wc-panel .wc-results {
                max-height: 180px; overflow-y: auto;
                background: rgba(255,255,255,.5); border-radius: 4px;
                padding: 4px 6px; font-size: 11px;
            }
            #wc-panel .wc-empty {
                color: #999; text-align: center; padding: 8px 0;
                font-style: italic;
            }
            #wc-panel .wc-result {
                display: flex; align-items: center; gap: 4px;
                padding: 2px 0; line-height: 1.4;
            }
            #wc-panel .wc-result-icon {
                font-weight: bold; min-width: 14px; text-align: center;
            }
            #wc-panel .wc-result-ok .wc-result-icon { color: #28a745; }
            #wc-panel .wc-result-fail .wc-result-icon { color: #E84A5F; }
            #wc-panel .wc-result-idx {
                color: #999; min-width: 38px; flex-shrink: 0;
            }
            #wc-panel .wc-result-title {
                flex: 1; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap;
            }
            #wc-panel .wc-result-fail .wc-result-title { color: #666; }
            #wc-panel .wc-reason {
                color: #E84A5F; font-size: 10px; flex-shrink: 0;
            }
            #wc-panel .wc-msg {
                background: rgba(255,255,255,.6); border-radius: 6px;
                padding: 8px 10px; margin-bottom: 10px;
                min-height: 36px; word-break: break-all;
                font-size: 12px;
            }
            #wc-panel .wc-actions {
                display: flex; gap: 6px; flex-wrap: wrap;
            }
            #wc-panel .wc-btn {
                flex: 1; min-width: 70px; padding: 6px 8px;
                border: 1px solid #F1752D; background: #fff; color: #F1752D;
                border-radius: 6px; cursor: pointer; font-size: 12px;
                transition: all .15s;
            }
            #wc-panel .wc-btn:hover { background: #F1752D; color: #fff; }
            #wc-panel .wc-btn-primary { background: #F1752D; color: #fff; }
            #wc-panel .wc-btn-primary:hover { background: #d65f1f; }
            #wc-panel .wc-btn-warn { border-color: #E84A5F; color: #E84A5F; }
            #wc-panel .wc-btn-warn:hover { background: #E84A5F; color: #fff; }
            #wc-panel .wc-btn-link {
                flex: 0 0 auto; padding: 6px 10px;
                border: none; background: transparent; color: #666;
                text-decoration: underline; min-width: auto;
            }
            #wc-panel .wc-btn-link:hover { background: transparent; color: #F1752D; }
        `;
        document.head.appendChild(style);
    }

    function bindUIEvents() {
        document.getElementById('wc-btn-start').addEventListener('click', runBatchSign);
        document.getElementById('wc-btn-stop').addEventListener('click', stopBatchSign);
        document.getElementById('wc-btn-help').addEventListener('click', () => {
            alert(
                '📖 抓包配置指南\n\n' +
                '1. 浏览器打开 https://weibo.com 登录微博\n' +
                '2. 按 F12 打开 DevTools → Network 面板\n' +
                '3. 筛选 Fetch / XHR\n' +
                '4. 进入"超话"页面，复制关注列表接口 URL\n' +
                '5. 点任意超话进入页面，再点一次"签到"按钮\n' +
                '6. 在 Network 中找到签到接口，复制 URL+请求体\n' +
                '7. 编辑本脚本 CONFIG.apis 填入\n\n' +
                '详细图文步骤见项目 README.md',
            );
        });

        // 折叠/展开
        const panel = /** @type {HTMLElement} */ (document.getElementById('wc-panel'));
        const toggle = /** @type {HTMLButtonElement} */ (panel.querySelector('.wc-toggle'));
        toggle.addEventListener('click', (/** @type {Event} */ e) => {
            e.stopPropagation();
            panel.classList.toggle('wc-collapsed');
            toggle.textContent = panel.classList.contains('wc-collapsed') ? '+' : '−';
        });

        // 重置自动签标记（用于测试）
        document.getElementById('wc-btn-reset-auto').addEventListener('click', () => {
            GM_setValue('wc_lastAutoDate', '');
            updateTriggerStatus();
            updateUI('idle', '已重置自动签标记，刷新页面即可测试');
        });

        // 重置定时签标记（用于测试）
        document.getElementById('wc-btn-reset-sched').addEventListener('click', () => {
            const stamp = `${todayKey()}_${CONFIG.triggers.scheduledTime}`;
            GM_setValue(`wc_scheduled_${stamp}`, false);
            updateTriggerStatus();
            updateUI('idle', '已重置定时签标记');
        });

        // 拖拽
        const handle = /** @type {HTMLElement} */ (panel.querySelector('.wc-header'));
        makeDraggable(panel, handle);
    }

    /**
     * 更新 trigger 状态显示
     */
    function updateTriggerStatus() {
        const autoEl = document.getElementById('wc-trigger-auto');
        const schedEl = document.getElementById('wc-trigger-sched');
        if (!autoEl || !schedEl) return;

        // 自动签状态
        if (CONFIG.triggers.autoOnVisit) {
            const lastDate = GM_getValue('wc_lastAutoDate', '');
            if (lastDate === todayKey()) {
                autoEl.textContent = '✓ 今日已签';
                autoEl.className = 'wc-trigger-status wc-trigger-done';
            } else {
                autoEl.textContent = '○ 今日未签';
                autoEl.className = 'wc-trigger-status wc-trigger-pending';
            }
        } else {
            autoEl.textContent = '已关闭';
            autoEl.className = 'wc-trigger-status';
        }

        // 定时签状态
        const stamp = `${todayKey()}_${CONFIG.triggers.scheduledTime}`;
        if (GM_getValue(`wc_scheduled_${stamp}`, false)) {
            schedEl.textContent = `✓ ${CONFIG.triggers.scheduledTime} 已签`;
            schedEl.className = 'wc-trigger-status wc-trigger-done';
        } else {
            const now = new Date();
            const [hh, mm] = CONFIG.triggers.scheduledTime.split(':').map(Number);
            const target = new Date();
            target.setHours(hh, mm, 0, 0);
            if (now > target) {
                schedEl.textContent = `○ 今日 ${CONFIG.triggers.scheduledTime} 已过`;
                schedEl.className = 'wc-trigger-status';
            } else {
                schedEl.textContent = `○ 等待 ${CONFIG.triggers.scheduledTime}`;
                schedEl.className = 'wc-trigger-status wc-trigger-pending';
            }
        }
    }

    /**
     * 让面板可拖拽
     * @param {HTMLElement} el
     * @param {HTMLElement} handle
     */
    function makeDraggable(el, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        handle.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
            if (/** @type {HTMLElement} */ (e.target).classList.contains('wc-toggle')) return;
            dragging = true;
            const rect = el.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            el.style.transition = 'none';
        });
        document.addEventListener('mousemove', (/** @type {MouseEvent} */ e) => {
            if (!dragging) return;
            el.style.left = (e.clientX - offsetX) + 'px';
            el.style.top = (e.clientY - offsetY) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                el.style.transition = '';
            }
        });
    }

    // ========================================================================
    // ⏰ 触发层：三种触发方式
    // ========================================================================

    function setupTriggers() {
        // 1) 手动按钮（UI 层已绑定 runBatchSign）

        // 2) 打开微博自动签到（每日仅一次）
        if (CONFIG.triggers.autoOnVisit) {
            setTimeout(() => {
                const lastDate = GM_getValue('wc_lastAutoDate', '');
                if (lastDate !== todayKey()) {
                    log('info', '今日尚未自动签到，启动自动流程');
                    GM_setValue('wc_lastAutoDate', todayKey());
                    runBatchSign();
                }
            }, 8000);
        }

        // 3) 每日定时签到（浏览器需保持打开）
        setInterval(() => {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const stamp = `${todayKey()}_${CONFIG.triggers.scheduledTime}`;
            if (`${hh}:${mm}` === CONFIG.triggers.scheduledTime &&
                !GM_getValue(`wc_scheduled_${stamp}`, false)) {
                GM_setValue(`wc_scheduled_${stamp}`, true);
                log('info', `到达定时 ${CONFIG.triggers.scheduledTime}，启动签到`);
                runBatchSign();
            }
        }, 60000);
    }

    // ========================================================================
    // 🚪 初始化
    // ========================================================================

    function init() {
        createPanel();
        setupTriggers();
        updateTriggerStatus();
        // 每分钟刷新 trigger 状态显示
        setInterval(updateTriggerStatus, 60000);
        log('success', '微博超话签到脚本已加载', {
            autoOnVisit: CONFIG.triggers.autoOnVisit,
            scheduledTime: CONFIG.triggers.scheduledTime,
        });
        if (!CONFIG.apis.listTopics.url || !CONFIG.apis.signOne.url) {
            updateUI('error', '⚠️ 请先配置 API 接口（点"抓包指南"）');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();