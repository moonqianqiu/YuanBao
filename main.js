const { app, BrowserWindow, Menu, MenuItem, clipboard, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

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

// 代理配置：支持 socks5://[user:pass@]host:port 或 http://host:port，空则系统默认
function applyProxy() {
    const raw = loadUserConfig().proxy;
    const fallback = typeof APP_CONFIG.proxy === 'string' ? APP_CONFIG.proxy : '';
    const proxy = (typeof raw === 'string' ? raw : fallback).trim();
    try {
        const rules = proxy ? proxy : undefined;
        return session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    } catch (e) {
        console.error('代理设置失败，回退系统代理:', e);
        return session.defaultSession.setProxy({ mode: 'system' });
    }
}

// 全局引用，防止被垃圾回收
let mainWindow = null;

// 1. 设置全局 User-Agent：仿照目标格式，Chrome 版本号跟随 Electron 内核自动更新
// 示例：Mozilla/5.0 (Macintosh; Intel Mac OS X 26_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36
const CUSTOM_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 26_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
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

    // 页面加载失败（如断网）时提示
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // 忽略子资源与主动中断
        dialog.showErrorBox('加载失败', `页面加载失败（${errorDescription}），请检查网络或代理配置后通过 Ctrl+R 重新加载。`);
    });

    // 处理新窗口打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        let host = '';
        try {
            host = new URL(url).hostname;
        } catch {
            host = '';
        }
        if (isTrustedHost(host)) {
            mainWindow.loadURL(url);
            return { action: 'deny' };
        }
        // 使用系统浏览器打开外部 https 链接
        if (url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // 注册右键菜单
    setupContextMenu(mainWindow);
}

// 右键菜单配置函数
function setupContextMenu(window) {
    window.webContents.on('context-menu', (event, params) => {
        const menu = new Menu();

        // 场景 A：选中了文本 -> 添加“复制”
        if (params.selectionText && params.selectionText.trim() !== '') {
            menu.append(new MenuItem({
                label: '复制',
                role: 'copy' // 使用 Electron 内置角色
            }));
        }

        // 场景 B：点击了链接 -> 添加“复制链接”
        if (params.linkURL && params.linkURL.trim() !== '') {
            menu.append(new MenuItem({
                label: '复制链接',
                click: () => {
                    // 使用剪贴板模块写入链接
                    clipboard.writeText(params.linkURL);
                }
            }));
        }

        // 场景 C：输入框或可编辑区域（可选）
        if (menu.items.length === 0 && params.isEditable) {
            menu.append(new MenuItem({ label: '撤销', role: 'undo' }));
            menu.append(new MenuItem({ label: '重做', role: 'redo' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ label: '剪切', role: 'cut' }));
            menu.append(new MenuItem({ label: '复制', role: 'copy' }));
            menu.append(new MenuItem({ label: '粘贴', role: 'paste' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ label: '全选', role: 'selectall' }));
        }

        // 如果菜单有内容，则弹出
        if (menu.items.length > 0) {
            menu.popup(window, params.x, params.y);
        }
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
