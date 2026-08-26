// ==UserScript==
// @name         微博超话抓包助手（临时辅助）
// @namespace    https://github.com/tom/weibo-chaohua-autosign
// @version      1.0.0
// @description  临时辅助：捕获微博所有 API 请求，导出 JSON 用于配置签到脚本。完成任务后可禁用/卸载
// @author       Tom
// @match        https://weibo.com/*
// @match        https://m.weibo.cn/*
// @match        https://weibo.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @run-at       document-start
// @noframes
// ==/UserScript==

/**
 * 抓包助手：捕获所有微博 API 请求
 *
 * 使用流程：
 *   1. 安装此脚本 + 主签到脚本（保持启用）
 *   2. 打开微博，登录
 *   3. 进入"超话"页面（会触发关注列表接口）
 *   4. 点开任意一个超话（会触发超话详情接口）
 *   5. 点"签到"按钮（会触发签到接口）
 *   6. 点右下角面板"导出 JSON"，下载文件
 *   7. 把 JSON 文件路径告诉 AI（或贴出内容）
 */

(function () {
    'use strict';

    // ========================================================================
    // ⚙️ 配置
    // ========================================================================

    /** @type {{
     *   keywords: string[],
     *   maxCapture: number,
     *   ignoreStatic: boolean
     * }} */
    const CONFIG = {
        // 关键词过滤：URL 包含任一关键词才会被捕获
        keywords: [
            'chaohua', 'huati', 'super', 'topic', 'checkin',
            'follow', 'attention', 'button', 'cardlist',
        ],
        maxCapture: 500,        // 最多捕获条数，防止内存爆掉
        ignoreStatic: true,     // 过滤静态资源（.js .css .png .jpg .woff 等）
    };

    // ========================================================================
    // 📦 请求记录
    // ========================================================================

    /** @type {Array<{
     *   id: number,
     *   timestamp: string,
     *   url: string,
     *   method: string,
     *   requestBody: string|null,
     *   requestHeaders: Object<string,string>,
     *   status: number,
     *   responsePreview: string,
     *   responseHeaders: Object<string,string>,
     *   durationMs: number,
     *   matchedKeywords: string[]
     * }>} */
    const records = [];

    let nextId = 1;
    let pageLoadCount = 0;

    // ========================================================================
    // 🛠️ 工具
    // ========================================================================

    /** @param {string} url */
    function extractPath(url) {
        try {
            const u = new URL(url);
            return u.pathname;
        } catch {
            return url;
        }
    }

    /**
     * 判断是否要捕获
     * @param {string} url
     * @returns {{ matched: boolean, keywords: string[] }}
     */
    function shouldCapture(url) {
        if (CONFIG.ignoreStatic && /\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) {
            return { matched: false, keywords: [] };
        }
        const lower = url.toLowerCase();
        const matched = [];
        for (const kw of CONFIG.keywords) {
            if (lower.includes(kw)) matched.push(kw);
        }
        return { matched: matched.length > 0, keywords: matched };
    }

    /** @param {Object<string,string>} headers */
    function headersToObj(/** @type {any} */ headers) {
        const obj = {};
        if (!headers) return obj;
        try {
            if (typeof headers.forEach === 'function') {
                headers.forEach((/** @type {string} */ v, /** @type {string} */ k) => {
                    obj[k] = v;
                });
            } else if (typeof headers === 'object') {
                Object.assign(obj, headers);
            }
        } catch { /* 忽略 */ }
        return obj;
    }

    // ========================================================================
    // 🌐 Hook fetch
    // ========================================================================

    const originalFetch = window.fetch;
    /** @type {any} */ (window).fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const decision = shouldCapture(url);
        if (!decision.matched) {
            return originalFetch.apply(this, /** @type {any} */ ([input, init]));
        }
        const id = nextId++;
        const startTime = Date.now();
        const reqBody = init && init.body ? String(init.body) : null;
        const reqHeaders = headersToObj(init && init.headers);

        return originalFetch.apply(this, /** @type {any} */ ([input, init]))
            .then(/** @type {(res:any)=>any} */ (res) => {
                const clone = res.clone();
                clone.text().then(/** @type {(text:string)=>void} */ (text) => {
                    pushRecord({
                        id,
                        url,
                        method,
                        requestBody: reqBody,
                        requestHeaders: reqHeaders,
                        status: res.status,
                        responsePreview: text.slice(0, 800),
                        responseHeaders: headersToObj(res.headers),
                        durationMs: Date.now() - startTime,
                        matchedKeywords: decision.keywords,
                    });
                }).catch(() => {
                    pushRecord({
                        id,
                        url,
                        method,
                        requestBody: reqBody,
                        requestHeaders: reqHeaders,
                        status: res.status,
                        responsePreview: '(读取响应失败)',
                        responseHeaders: {},
                        durationMs: Date.now() - startTime,
                        matchedKeywords: decision.keywords,
                    });
                });
                return res;
            })
            .catch(/** @type {(err:any)=>any} */ (err) => {
                pushRecord({
                    id,
                    url,
                    method,
                    requestBody: reqBody,
                    requestHeaders: reqHeaders,
                    status: 0,
                    responsePreview: `ERROR: ${err.message || err}`,
                    responseHeaders: {},
                    durationMs: Date.now() - startTime,
                    matchedKeywords: decision.keywords,
                });
                throw err;
            });
    };

    // ========================================================================
    // 🌐 Hook XMLHttpRequest
    // ========================================================================

    const OriginalXHR = window.XMLHttpRequest;
    /** @type {any} */
    const originalOpen = OriginalXHR.prototype.open;
    /** @type {any} */
    const originalSend = OriginalXHR.prototype.send;
    /** @type {any} */
    const originalSetHeader = OriginalXHR.prototype.setRequestHeader;

    /** @type {any} */ (OriginalXHR.prototype).open = function (
        /** @type {any} */ method, /** @type {string} */ url
    ) {
        /** @type {any} */ (this)._wc_method = method;
        /** @type {any} */ (this)._wc_url = url;
        /** @type {any} */ (this)._wc_headers = {};
        return originalOpen.apply(this, arguments);
    };

    /** @type {any} */ (OriginalXHR.prototype).setRequestHeader = function (
        /** @type {string} */ k, /** @type {string} */ v
    ) {
        /** @type {any} */ (this)._wc_headers[k] = v;
        return originalSetHeader.apply(this, arguments);
    };

    /** @type {any} */ (OriginalXHR.prototype).send = function (/** @type {any} */ body) {
        const url = /** @type {any} */ (this)._wc_url || '';
        const method = /** @type {any} */ (this)._wc_method || 'GET';
        const decision = shouldCapture(url);
        if (decision.matched) {
            const id = nextId++;
            const startTime = Date.now();
            const reqBody = body ? String(body) : null;
            const reqHeaders = { ...(/** @type {any} */ (this)._wc_headers || {}) };
            /** @type {any} */ (this).addEventListener('loadend', () => {
                pushRecord({
                    id,
                    url,
                    method,
                    requestBody: reqBody,
                    requestHeaders: reqHeaders,
                    status: /** @type {any} */ (this).status,
                    responsePreview: (/** @type {any} */ (this).responseText || '').slice(0, 800),
                    responseHeaders: parseXHRResponseHeaders(
                        /** @type {any} */ (this).getAllResponseHeaders()
                    ),
                    durationMs: Date.now() - startTime,
                    matchedKeywords: decision.keywords,
                });
            });
        }
        return originalSend.apply(this, arguments);
    };

    /** @param {string} raw */
    function parseXHRResponseHeaders(raw) {
        const obj = {};
        if (!raw) return obj;
        raw.split(/\r?\n/).forEach((/** @type {string} */ line) => {
            const idx = line.indexOf(':');
            if (idx > 0) {
                obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
        });
        return obj;
    }

    // ========================================================================
    // 📝 记录管理
    // ========================================================================

    /**
     * @param {{
     *   id: number, url: string, method: string,
     *   requestBody: string|null, requestHeaders: Object<string,string>,
     *   status: number, responsePreview: string,
     *   responseHeaders: Object<string,string>,
     *   durationMs: number, matchedKeywords: string[]
     * }} rec
     */
    function pushRecord(rec) {
        const record = { ...rec, timestamp: new Date().toISOString() };
        records.push(record);
        if (records.length > CONFIG.maxCapture) {
            records.shift();
        }
        logToConsole(record);
        updateUI();
    }

    /**
     * @param {{id:number, url:string, method:string, status:number, matchedKeywords:string[]}} rec
     */
    function logToConsole(rec) {
        const path = extractPath(rec.url);
        const statusColor = rec.status >= 200 && rec.status < 300
            ? '#28a745' : (rec.status > 0 ? '#dc3545' : '#999');
        console.log(
            `%c[抓包#${rec.id}]%c ${rec.method} ${rec.status} %c${path}`,
            'background:#F1752D;color:#fff;padding:1px 6px;border-radius:3px;font-weight:bold',
            `color:${statusColor};font-weight:bold`,
            'color:#333',
        );
        console.log('  └ 关键词:', rec.matchedKeywords.join(', '));
        console.log('  └ URL:', rec.url);
    }

    function clearRecords() {
        records.length = 0;
        console.clear();
        console.log('%c[抓包助手] 已清空记录', 'color:#F1752D;font-weight:bold');
        updateUI();
    }

    // ========================================================================
    // 📤 导出
    // ========================================================================

    function exportJSON() {
        const payload = {
            capturedAt: new Date().toISOString(),
            pageUrl: location.href,
            userAgent: navigator.userAgent,
            totalRecords: records.length,
            records,
        };
        const json = JSON.stringify(payload, null, 2);
        const filename = `weibo-capture-${Date.now()}.json`;
        if (typeof GM_download !== 'undefined') {
            GM_download({
                url: 'data:application/json;charset=utf-8,' + encodeURIComponent(json),
                name: filename,
                saveAs: true,
            });
        } else {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }
        updateUI('已导出 ' + records.length + ' 条');
    }

    function copyToClipboard() {
        const text = records.map((/** @type {any} */ r) =>
            `[#${r.id}] ${r.method} ${r.status} ${r.url}\n` +
            `  body: ${r.requestBody || '(无)'}\n` +
            `  resp: ${r.responsePreview.slice(0, 300)}`
        ).join('\n\n');
        navigator.clipboard.writeText(text).then(() => {
            updateUI('已复制 ' + records.length + ' 条到剪贴板');
        }).catch(() => {
            updateUI('复制失败，请改用导出 JSON');
        });
    }

    // ========================================================================
    // 🎨 UI 面板
    // ========================================================================

    function updateUI(/** @type {string=} */ toast) {
        const panel = document.getElementById('wc-sniffer-panel');
        if (!panel) return;
        const countEl = panel.querySelector('.wc-count');
        if (countEl) countEl.textContent = String(records.length);
        const listEl = panel.querySelector('.wc-list');
        if (listEl) {
            listEl.innerHTML = records.slice(-10).reverse().map((/** @type {any} */ r) => {
                const path = extractPath(r.url);
                const ok = r.status >= 200 && r.status < 300;
                return `<div class="wc-row ${ok ? 'wc-ok' : 'wc-fail'}">
                    <span class="wc-id">#${r.id}</span>
                    <span class="wc-method">${r.method}</span>
                    <span class="wc-status">${r.status}</span>
                    <span class="wc-path" title="${r.url}">${path}</span>
                </div>`;
            }).join('');
        }
        if (toast) {
            const toastEl = panel.querySelector('.wc-toast');
            if (toastEl) {
                toastEl.textContent = toast;
                setTimeout(() => { toastEl.textContent = ''; }, 3000);
            }
        }
    }

    function createPanel() {
        if (document.getElementById('wc-sniffer-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'wc-sniffer-panel';
        panel.innerHTML = `
            <div class="wc-header">
                <span class="wc-title">🔍 抓包助手</span>
                <span class="wc-count">0</span>
                <button class="wc-toggle" title="折叠">−</button>
            </div>
            <div class="wc-body">
                <div class="wc-toast"></div>
                <div class="wc-list-wrap">
                    <div class="wc-list-title">最近 10 条</div>
                    <div class="wc-list"></div>
                </div>
                <div class="wc-actions">
                    <button class="wc-btn wc-btn-primary" id="wc-btn-export">📥 导出 JSON</button>
                    <button class="wc-btn" id="wc-btn-copy">📋 复制文本</button>
                    <button class="wc-btn wc-btn-warn" id="wc-btn-clear">🗑️ 清空</button>
                </div>
            </div>
        `;
        // 等 documentElement 可用时插入
        const append = () => {
            if (document.body) {
                document.body.appendChild(panel);
                injectStyle();
                bindUIEvents();
            } else {
                setTimeout(append, 50);
            }
        };
        append();
    }

    function injectStyle() {
        if (document.getElementById('wc-sniffer-style')) return;
        const style = document.createElement('style');
        style.id = 'wc-sniffer-style';
        style.textContent = `
            #wc-sniffer-panel {
                position: fixed; left: 20px; bottom: 20px; z-index: 999999;
                width: 380px; background: #FFF3CD; color: #333;
                border: 2px solid #F1752D; border-radius: 12px;
                box-shadow: 0 6px 20px rgba(0,0,0,.15);
                font: 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            #wc-sniffer-panel.wc-collapsed .wc-body { display: none; }
            #wc-sniffer-panel .wc-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px; background: #F1752D; color: #fff;
                border-radius: 10px 10px 0 0; font-weight: 600; user-select: none;
            }
            #wc-sniffer-panel .wc-count {
                background: #E84A5F; color: #fff; border-radius: 10px;
                padding: 2px 8px; font-size: 11px; margin-left: auto; margin-right: 8px;
            }
            #wc-sniffer-panel .wc-toggle {
                background: none; border: none; color: #fff;
                font-size: 16px; cursor: pointer; line-height: 1;
            }
            #wc-sniffer-panel .wc-body { padding: 10px 12px; }
            #wc-sniffer-panel .wc-toast {
                min-height: 18px; color: #E84A5F; font-weight: 600;
                margin-bottom: 6px; font-size: 11px;
            }
            #wc-sniffer-panel .wc-list-wrap {
                background: rgba(255,255,255,.7); border-radius: 6px;
                padding: 6px 8px; margin-bottom: 8px;
                max-height: 180px; overflow-y: auto;
            }
            #wc-sniffer-panel .wc-list-title {
                font-size: 10px; color: #999; margin-bottom: 4px;
                text-transform: uppercase; letter-spacing: 1px;
            }
            #wc-sniffer-panel .wc-list { font-size: 11px; }
            #wc-sniffer-panel .wc-row {
                display: flex; gap: 6px; padding: 2px 0;
                align-items: center;
            }
            #wc-sniffer-panel .wc-row.wc-fail .wc-status { color: #E84A5F; }
            #wc-sniffer-panel .wc-row.wc-ok .wc-status { color: #28a745; }
            #wc-sniffer-panel .wc-id {
                color: #999; min-width: 28px;
            }
            #wc-sniffer-panel .wc-method {
                font-weight: bold; min-width: 38px;
            }
            #wc-sniffer-panel .wc-status {
                min-width: 28px; font-weight: bold;
            }
            #wc-sniffer-panel .wc-path {
                flex: 1; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; color: #555;
            }
            #wc-sniffer-panel .wc-actions {
                display: flex; gap: 4px;
            }
            #wc-sniffer-panel .wc-btn {
                flex: 1; padding: 5px 6px;
                border: 1px solid #F1752D; background: #fff; color: #F1752D;
                border-radius: 5px; cursor: pointer; font-size: 11px;
                transition: all .15s;
            }
            #wc-sniffer-panel .wc-btn:hover { background: #F1752D; color: #fff; }
            #wc-sniffer-panel .wc-btn-primary { background: #F1752D; color: #fff; }
            #wc-sniffer-panel .wc-btn-primary:hover { background: #d65f1f; }
            #wc-sniffer-panel .wc-btn-warn { border-color: #E84A5F; color: #E84A5F; }
            #wc-sniffer-panel .wc-btn-warn:hover { background: #E84A5F; color: #fff; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function bindUIEvents() {
        document.getElementById('wc-btn-export').addEventListener('click', exportJSON);
        document.getElementById('wc-btn-copy').addEventListener('click', copyToClipboard);
        document.getElementById('wc-btn-clear').addEventListener('click', clearRecords);
        const panel = /** @type {HTMLElement} */ (document.getElementById('wc-sniffer-panel'));
        const toggle = /** @type {HTMLButtonElement} */ (panel.querySelector('.wc-toggle'));
        toggle.addEventListener('click', () => {
            panel.classList.toggle('wc-collapsed');
            toggle.textContent = panel.classList.contains('wc-collapsed') ? '+' : '−';
        });
    }

    // ========================================================================
    // 🚪 初始化
    // ========================================================================

    function init() {
        createPanel();
        console.log(
            '%c[抓包助手] 已加载\n' +
            '关键词过滤: ' + CONFIG.keywords.join(', ') + '\n' +
            '所有匹配的 fetch/XHR 请求会被记录到控制台\n' +
            '完成后点左下角面板"导出 JSON"或"复制文本"',
            'color:#F1752D;font-weight:bold;font-size:13px',
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();