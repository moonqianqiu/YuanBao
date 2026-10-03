const { app, BrowserWindow, Menu, MenuItem, clipboard, shell, dialog, session, webFrameMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 站点配置：优先环境变量 CONFIG_FILE（开发模式），否则读打包注入的 resources/app-config.json
// 找不到或格式非法时直接报错退出——静默兜底到其它站点会导致标题/白名单/账号全部错乱
function loadAppConfig() {
    const candidates = [];
    if (process.env.CONFIG_FILE) {
        candidates.push(path.resolve(__dirname, process.env.CONFIG_FILE));
    }
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app-config.json'));
    }
    // 仅开发模式提供默认配置；打包环境读不到即报错，避免退回错误站点
    if (!app.isPackaged) {
        candidates.push(path.join(__dirname, 'configs', 'yuanbao.app.json'));
    }

    const errors = [];
    for (const file of candidates) {
        try {
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!config.url) throw new Error('缺少 url 字段');
            if (!config.title) throw new Error('缺少 title 字段');
            if (!config.icon) throw new Error('缺少 icon 字段');
            if (!Array.isArray(config.hostSuffixes) || config.hostSuffixes.length === 0) {
                throw new Error('缺少 hostSuffixes 字段');
            }
            return config;
        } catch (e) {
            errors.push(`${file}: ${e.message}`);
        }
    }
    dialog.showErrorBox('配置错误',
        `应用站点配置读取失败，无法启动。\n\n${errors.join('\n')}\n\n请重新安装应用。`);
    console.error('应用站点配置读取失败:', errors.join('\n'));
    app.exit(1);
    throw new Error('config load failed'); // app.exit 非同步，兜底确保 loadAppConfig 不返回 undefined
}

const APP_CONFIG = loadAppConfig();

// 用户代理配置：优先级 userData/config.json > 打包内嵌 app-config.json 的 proxy 字段
// 支持 "socks5://[user:pass@]host:port" / "http://host:port"，空则直连
function loadUserConfig() {
    try {
        const file = path.join(app.getPath('userData'), 'config.json');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

// 代理配置：支持 socks5://[user:pass@]host:port 或 http://host:port，空则系统默认。
// 格式非法时启动弹窗提示并直连，而不是静默忽略——少写协议前缀（如只写 host:port）是常见笔误
const SUPPORTED_PROXY_SCHEMES = ['socks4:', 'socks5:', 'http:', 'https:'];

function validateProxy(proxy) {
    if (!proxy) return null;
    let parsed;
    try {
        parsed = new URL(proxy);
    } catch {
        return `无法解析代理地址 "${proxy}"`;
    }
    if (!SUPPORTED_PROXY_SCHEMES.includes(parsed.protocol)) {
        return `代理地址 "${proxy}" 需以 socks5:// 或 http:// 开头（当前协议为 "${parsed.protocol}"）`;
    }
    if (!parsed.hostname) {
        return `代理地址 "${proxy}" 缺少主机名`;
    }
    return null;
}

function applyProxy() {
    const raw = loadUserConfig().proxy;
    const fallback = typeof APP_CONFIG.proxy === 'string' ? APP_CONFIG.proxy : '';
    const proxy = (typeof raw === 'string' ? raw : fallback).trim();
    const problem = validateProxy(proxy);
    if (problem) {
        console.error('代理配置无效，本次启动直连:', problem);
        dialog.showErrorBox('代理配置无效',
            `${problem}\n\n支持格式：socks5://[user:pass@]host:port 或 http://host:port。\n请修正 userData/config.json（或站点配置的 proxy 字段）后重启。`);
    }
    try {
        const rules = problem ? undefined : (proxy || undefined);
        return session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    } catch (e) {
        console.error('代理设置失败，回退系统代理:', e);
        return session.defaultSession.setProxy({ mode: 'system' });
    }
}

// 全局引用，防止被垃圾回收
let mainWindow = null;
// window.open 创建的子窗口（登录弹窗等），持有引用防止被垃圾回收
const popupWindows = new Set();

// 1. 全局 User-Agent 与指纹一致性：
// - UA 声称 macOS 上的 Chrome，版本号跟随 Electron 内核（与真实引擎版本一致，可通过站点的版本合理性校验）
// - 仅改 UA 字符串不够：Chromium 仍会发送 Sec-CH-UA-Platform: "Windows" 等请求头，且 JS 层
//   navigator.platform / userAgentData 仍是 Windows —— "Mac UA + Windows 平台"的矛盾指纹会被
//   站点风控判定异常（页面加载失败 / 交互异常）。由 applyConsistentClientHints 与
//   patchRendererFingerprint 把请求头和 JS 指纹统一对齐为 macOS。
// - app-config.json 提供 userAgent（手动实验通道）则用之；CI 不再注入 Safari UA
const MAC_OS_VERSION = '26_5_2';
const MAC_PLATFORM_VERSION = '26.5.2';
const FALLBACK_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X ${MAC_OS_VERSION}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const CUSTOM_USER_AGENT = (typeof APP_CONFIG.userAgent === 'string' && APP_CONFIG.userAgent.trim())
    ? APP_CONFIG.userAgent.trim()
    : FALLBACK_UA;
app.userAgentFallback = CUSTOM_USER_AGENT;

// 2. 单实例锁定逻辑
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        await applyProxy();
        applyConsistentClientHints();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    }).catch(err => {
        dialog.showErrorBox('启动失败', String(err));
        app.exit(1);
    });
}

function isTrustedHost(hostname) {
    return (APP_CONFIG.hostSuffixes || []).some(suffix =>
        hostname === suffix || hostname.endsWith('.' + suffix)
    );
}

// DevTools 的 webContents 有自己的窗口打开与右键菜单逻辑，按 URL 识别后跳过，
// 避免下面的全局处理器干扰 DevTools 内部行为
function isDevToolsContents(contents) {
    return contents.getURL().startsWith('devtools://');
}

// 核心站点主机名：window.open 打开同域链接时复用主窗口（保持既有行为），其他可信域开子窗口
const CORE_HOST = (() => {
    try { return new URL(APP_CONFIG.url).hostname; } catch { return ''; }
})();

// 把 Chromium 自动附加的 Sec-CH-UA 系列头改写成与 UA 声明一致的 macOS Chrome 值。
// 只改写实际存在的头：低熵三元组（UA/Mobile/Platform）只随导航请求发送、高熵头只随站点
// Accept-CH 发送，全量补齐到所有请求反而制造新的异常指纹。
function applyConsistentClientHints() {
    const ver = process.versions.chrome;
    const major = ver.split('.')[0];
    const hints = {
        'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-ch-ua-full-version-list': `"Chromium";v="${ver}", "Google Chrome";v="${ver}", "Not?A_Brand";v="24.0.0.0"`,
        'sec-ch-ua-platform-version': MAC_PLATFORM_VERSION,
        'sec-ch-ua-model': '""'
    };
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = {};
        for (const [name, value] of Object.entries(details.requestHeaders)) {
            requestHeaders[name] = hints[name.toLowerCase()] ?? value;
        }
        callback({ requestHeaders });
    });
}

// 注入主世界的 JS 指纹补丁：navigator.platform / userAgentData 与 macOS 声明对齐。
// 局限：dom-ready 时机覆盖不到站点最早的同步内联脚本；完全 document-start 覆盖需关闭
// contextIsolation，安全代价不值得。
const FINGERPRINT_PATCH = `
(() => {
    try {
        if (navigator.platform !== 'MacIntel') {
            Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
        }
        // userAgentData 每次访问可能返回新实例，补丁必须打在原型上才能对所有实例生效
        const proto = navigator.userAgentData && Object.getPrototypeOf(navigator.userAgentData);
        if (proto && proto.constructor && proto.constructor.name === 'NavigatorUAData') {
            const platDesc = Object.getOwnPropertyDescriptor(proto, 'platform');
            if (platDesc && platDesc.configurable && platDesc.get) {
                Object.defineProperty(proto, 'platform', { get: function () { return 'macOS'; }, configurable: true });
            }
            if (typeof proto.getHighEntropyValues === 'function') {
                const orig = proto.getHighEntropyValues;
                const mac = {
                    platform: 'macOS',
                    platformVersion: '${MAC_PLATFORM_VERSION}',
                    architecture: 'x86',
                    bitness: '64',
                    model: '',
                    wow64: false,
                    formFactors: ['Desktop']
                };
                Object.defineProperty(proto, 'getHighEntropyValues', {
                    value: function (hints) {
                        return orig.call(this, hints).then((data) => {
                            const out = { ...data };
                            for (const key of hints) {
                                if (key in mac) out[key] = mac[key];
                            }
                            return out;
                        });
                    },
                    writable: true,
                    configurable: true
                });
            }
        }
    } catch (e) {}
})();`;

function patchRendererFingerprint(contents) {
    contents.executeJavaScript(FINGERPRINT_PATCH).catch(() => {});
}

// 所有窗口（主窗口 + 弹窗）统一处理：窗口打开策略、右键菜单、JS 指纹补丁
app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        // DevTools 打开自己的子窗口（如从控制台查看）走默认行为
        if (isDevToolsContents(contents)) return { action: 'allow' };
        let host = '';
        try {
            host = new URL(url).hostname;
        } catch {
            host = '';
        }
        if (isTrustedHost(host)) {
            if (host === CORE_HOST && mainWindow && !mainWindow.isDestroyed()) {
                // 核心站点的 _blank 链接维持原行为：复用主窗口
                mainWindow.loadURL(url);
                return { action: 'deny' };
            }
            // 其他可信域（qq.com 登录/授权弹窗等）开真正的子窗口，保住 window.opener 通信链路
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        webviewTag: false,
                        webSecurity: true
                    }
                }
            };
        }
        // 使用系统浏览器打开外部 https 链接
        if (url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // 仅处理承载网页的顶层窗口，避免波及 DevTools 等内部 webContents
    if (contents.getType() === 'window') {
        // 渲染进程崩溃（crashed/oom 等）时自动重载一次；连续崩溃不再重试，改弹窗提示
        let crashReloaded = false;
        contents.on('did-finish-load', () => { crashReloaded = false; });
        contents.on('render-process-gone', (event, details) => {
            if (contents.isDestroyed() || details.reason === 'clean-exit') return;
            if (!crashReloaded) {
                crashReloaded = true;
                contents.reload();
            } else {
                dialog.showErrorBox('页面崩溃', `渲染进程异常退出（${details.reason}），请通过 Ctrl+R 重新加载。`);
            }
        });

        contents.on('did-create-window', (win) => {
            popupWindows.add(win);
            win.on('closed', () => popupWindows.delete(win));
        });

        contents.on('dom-ready', () => patchRendererFingerprint(contents));

        // 子 iframe（如登录二维码页）有独立的 navigator，也要打补丁；主框架已由 dom-ready 覆盖
        contents.on('did-frame-finish-load', (event, isMainFrame, processId, routingId) => {
            if (isMainFrame) return;
            const frame = webFrameMain.fromId(processId, routingId);
            if (frame) frame.executeJavaScript(FINGERPRINT_PATCH).catch(() => {});
        });
    }

    setupContextMenu(contents);
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 640,
        minWidth: 640,
        minHeight: 400,
        title: APP_CONFIG.title,
        icon: path.join(__dirname, APP_CONFIG.icon),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true
        },
        autoHideMenuBar: true
    });

    // 快捷键：Ctrl+R / F5 重新加载，Ctrl+Shift+I 开发者工具
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.control && !input.shift && (input.key === 'r' || input.key === 'R')) {
            mainWindow.webContents.reload();
            event.preventDefault();
        } else if (input.key === 'F5') {
            mainWindow.webContents.reload();
            event.preventDefault();
        } else if (input.control && input.shift && (input.key === 'I' || input.key === 'i')) {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    mainWindow.loadURL(APP_CONFIG.url);

    mainWindow.on('close', () => {
        mainWindow = null;
    });

    // 页面加载失败（如断网）时先自动重试一次，仍失败才提示，减少网络抖动时的模态打断
    let autoRetryCount = 0;
    mainWindow.webContents.on('did-finish-load', () => {
        autoRetryCount = 0;
    });
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // 忽略子资源与主动中断
        if (autoRetryCount < 1) {
            autoRetryCount++;
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
            }, 1500);
            return;
        }
        dialog.showErrorBox('加载失败', `页面加载失败（${errorDescription}），请检查网络或代理配置后通过 Ctrl+R 重新加载。`);
    });
}

// 右键菜单配置函数
function setupContextMenu(contents) {
    contents.on('context-menu', (event, params) => {
        if (isDevToolsContents(contents)) return; // DevTools 自带右键菜单
        const menu = new Menu();

        // 场景 A：输入框或可编辑区域 -> 完整编辑菜单。
        // 不再要求"菜单为空"才追加：此前输入框内选中文字时只剩"复制"，丢失剪切/粘贴/全选。
        // cut/copy 在无选区时由系统角色自行无效，无需判断。
        if (params.isEditable) {
            menu.append(new MenuItem({ label: '撤销', role: 'undo' }));
            menu.append(new MenuItem({ label: '重做', role: 'redo' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ label: '剪切', role: 'cut' }));
            menu.append(new MenuItem({ label: '复制', role: 'copy' }));
            menu.append(new MenuItem({ label: '粘贴', role: 'paste' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ label: '全选', role: 'selectAll' }));
        } else if (params.selectionText && params.selectionText.trim() !== '') {
            // 场景 B：非编辑区选中文本 -> "复制"
            menu.append(new MenuItem({
                label: '复制',
                role: 'copy'
            }));
        }

        // 场景 C：点击了链接 -> "复制链接"
        if (params.linkURL && params.linkURL.trim() !== '') {
            menu.append(new MenuItem({
                label: '复制链接',
                click: () => {
                    clipboard.writeText(params.linkURL);
                }
            }));
        }

        // 如果菜单有内容，则弹出
        if (menu.items.length > 0) {
            const win = BrowserWindow.fromWebContents(contents);
            menu.popup({ window: win, x: params.x, y: params.y });
        }
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
