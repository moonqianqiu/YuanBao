# 元宝 / 混元桌面版

腾讯元宝与混元（Hy AI Studio）的桌面壳应用：用 Electron 把网页版包装成独立的桌面 App，保留官方站点体验，补上独立窗口、系统右键菜单、代理等桌面便利。

同一份代码通过配置生成两个独立应用：

| 应用 | 站点 | 配置 |
|---|---|---|
| 腾讯元宝 | https://yuanbao.tencent.com | `configs/yuanbao.*.json` |
| Hy AI Studio（混元） | https://aistudio.tencent.ai | `configs/hunyuan.*.json` |

## 功能

- 站点白名单内的链接在应用内打开；`qq.com` 等登录/授权弹窗开真正的子窗口（保留 `window.opener` 通信链路）；白名单外的 https 链接交给系统浏览器
- 浏览器指纹一致性：User-Agent、`Sec-CH-UA` 请求头、`navigator.platform` / `userAgentData` 统一对齐为 macOS Chrome，版本号跟随 Electron 内核
- 单实例运行，重复启动自动唤起已有窗口
- 右键菜单：编辑区完整编辑操作、选中文本复制、复制链接
- 页面加载失败先自动重试一次，仍失败才弹窗提示；渲染进程崩溃时自动重载一次
- SOCKS5 / HTTP 代理支持，格式非法时启动弹窗提示

## 快捷键

| 快捷键 | 功能 |
|---|---|
| Ctrl+R / F5 | 重新加载 |
| Ctrl+Shift+I | 开发者工具 |

## 开发

建议 Node.js 20+（CI 使用 24），Electron 44。

```bash
npm install
npm start              # 默认加载元宝配置（configs/yuanbao.app.json）
npm run start:hunyuan  # 开发混元站点
```

也可以通过 `CONFIG_FILE` 环境变量加载任意站点配置：

```bash
# bash
CONFIG_FILE=configs/hunyuan.app.json npm start
```

```powershell
# PowerShell
$env:CONFIG_FILE="configs/hunyuan.app.json"; npm start
```

## 构建

```bash
npm run build          # 元宝
npm run build:hunyuan  # 混元
npm run build:all      # 两个都打
```

产物在 `dist/`，每个应用包含 NSIS 安装包与 portable 免安装版。

### CI 构建

仓库不发布 Release，请从 GitHub Actions 下载：进入 `Build Electron App` workflow 的运行页（手动触发），在 Artifacts 区下载 `YuanBao-Desktop-Win64` 或 `HunYuan-Desktop-Win64`（保留 3 天）。

CI 支持通过 Secrets `YUANBAO_PROXY` / `HUNYUAN_PROXY` 在构建时为对应应用注入默认代理（可选，不设置则使用配置文件中的值）。

## 站点配置（configs/*.app.json）

| 字段 | 说明 |
|---|---|
| `title` | 窗口标题 |
| `url` | 站点入口 |
| `icon` | 应用图标路径（相对仓库根目录） |
| `hostSuffixes` | 信任域后缀白名单，命中才允许在应用内打开 |
| `proxy` | 内置代理（可空），如 `socks5://host:port` 或 `http://host:port` |
| `userAgent` | 可选，覆盖默认 User-Agent（手动实验通道） |

构建时该文件被嵌入应用内 `resources/app-config.json`，运行时读取。

## 用户代理配置

安装后想更换代理无需重装：在应用的 userData 目录放一个 `config.json`：

```json
{
  "proxy": "socks5://127.0.0.1:1080"
}
```

Windows 下位于 `%APPDATA%\<应用名>\config.json`（开发模式应用名为 `yuanbao-app`，安装版以 productName 命名）。该配置优先级高于打包内嵌的 `proxy`；显式设为 `""` 表示强制直连；格式非法时启动会弹窗提示并直连。修改后重启应用生效。

## 目录结构

```
main.js                # 主进程：配置加载、指纹对齐、窗口管理、右键菜单
configs/
  yuanbao.json         # 元宝 electron-builder 打包配置
  yuanbao.app.json     # 元宝站点配置
  hunyuan.json         # 混元打包配置
  hunyuan.app.json     # 混元站点配置
assets/                # 两套应用图标
.github/workflows/     # 构建、依赖更新
```

## License

GPL-3.0
