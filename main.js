const { app, BrowserWindow, Menu, MenuItem, clipboard, shell, dialog } = require('electron');
const path = require('path');
const { URL } = require('url');

// 全局引用，防止被垃圾回收
let mainWindow = null;

// 1. 设置全局 User-Agent：伪装成 macOS 上的 Chrome，版本号跟随 Electron 内核自动更新
const CUSTOM_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
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

    app.whenReady().then(() => {
        createWindow();
        
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 640,
        minWidth: 640,
        minHeight: 400,
        title: "腾讯元宝",
        icon: path.join(__dirname, 'assets/YB.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true
        },
        autoHideMenuBar: true
    });

    mainWindow.loadURL('https://yuanbao.tencent.com');

    mainWindow.on('close', () => {
        mainWindow = null;
    });

    // 页面加载失败（如断网）时提示
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // 忽略子资源与主动中断
        dialog.showErrorBox('加载失败', `页面加载失败（${errorDescription}），请检查网络后通过 Ctrl+R 重新加载。`);
    });

    // 处理新窗口打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        let host = '';
        try {
            host = new URL(url).hostname;
        } catch {
            host = '';
        }
        if (host === 'yuanbao.tencent.com' || host.endsWith('.tencent.com')) {
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
