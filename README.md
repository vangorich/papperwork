# Paperwork PDF Studio

一个兴趣使然、在 AI 辅助下编写的 Windows PDF 小工具。

初衷是把平时会用到的阅读、页面整理、简单编辑、OCR 和压缩功能放在一起，并尽量在本机完成。项目还在慢慢完善，难免有考虑不周的地方；处理重要文档时请保留原件，也欢迎通过 [Issues](https://github.com/vangorich/papperwork/issues) 提出建议。

## 下载

当前版本：**0.2.7** · [查看 Release](https://github.com/vangorich/papperwork/releases/tag/v0.2.7)

| Windows 架构 | 安装版 | 免安装版 |
| --- | --- | --- |
| x64（多数 Intel / AMD 电脑） | [下载](https://github.com/vangorich/papperwork/releases/download/v0.2.7/Paperwork-0.2.7-windows-x64-setup.exe) | [下载](https://github.com/vangorich/papperwork/releases/download/v0.2.7/Paperwork-0.2.7-windows-x64.exe) |
| ARM64（Windows on Arm） | [下载](https://github.com/vangorich/papperwork/releases/download/v0.2.7/Paperwork-0.2.7-windows-arm64-setup.exe) | [下载](https://github.com/vangorich/papperwork/releases/download/v0.2.7/Paperwork-0.2.7-windows-arm64.exe) |

每台电脑任选一种即可。可以在 Windows「设置 → 系统 → 系统信息」中查看系统类型；虚拟机按其中 Windows 的架构选择。程序使用系统 WebView2，安装版仅安装到当前用户。

[使用说明](https://github.com/vangorich/papperwork/releases/download/v0.2.7/使用说明.md) · [SHA-256 校验清单](https://github.com/vangorich/papperwork/releases/download/v0.2.7/SHA256SUMS.txt)

## 基本功能

- **阅读文档**：打开 PDF、部分 OFD 和常见图片，支持缩放、单页/连续/双页阅读、全文搜索与书签跳转。
- **整理页面**：旋转、排序、插入、删除、提取和拆分页面，也可以把多份文档放进不同工作区。
- **简单编辑**：添加文字、高亮、图片、签名、电子章、备注及文字/图片水印；已添加的对象可以继续调整。
- **OCR 文字识别**：为扫描页补充可选择、可复制的文字层。Tauri 版使用 Windows OCR，识别语言取决于系统已安装的语言包。
- **压缩 PDF**：提供无损、均衡、强力和极致四档，压缩后另存副本。原生文字、链接和批注不会因压缩而被统一替换成整页图片。
- **导出 Markdown**：可导出全文、当前选区或已有高亮；图片和页面顺序会按本地规则处理。
- **打印与邮件**：支持 Windows 打印、从已有打印收件箱导入，以及把普通 Outlook `.msg` 邮件作为 A4 备忘录查看。
- **本地 MCP（可选）**：允许支持的客户端在逐份授权后读取或修改文档；授权可撤回，写盘副本仍需另行确认。
- **一些界面细节**：纸页式首页、鼠标跟随和界面动画。动画可在「常用设置 → 界面动画」中独立关闭。

## 使用时的几点提醒

- 默认尽量保留原文件；保存、压缩和 MCP 写盘都应明确选择副本。重要文档仍建议另外备份。
- **极致压缩是有损的**。75% 只是特定高分辨率扫描样本上达到过的结果，不是对所有 PDF 的承诺。请检查小字、数字、灰底内容和印章；用于逐字校对或归档时，优先保留原件或选择无损档。
- OCR 可能认错文字或位置，模糊、倾斜和复杂表格尤其如此，不能把识别结果当作无误转写。
- 普通打开、OCR、压缩和 Markdown 本地导出不依赖外部 API。可选的在线文字辅助只应在用户确认后发送预览文字，不会因此自动获得整份 PDF、图片或附件的访问权。
- 当前程序**没有嵌入式 Authenticode 发布者签名**，Windows 可能显示未知发布者提示。SHA-256 只能核对文件是否一致，不能代替发布者签名。
- ARM64 版本已分别构建并检查程序架构，但尚未完成华为 EasyOS 虚拟机或其他 ARM64 真机验收。

## 从源码运行

主要使用 **Tauri 2 + Rust + React + SQLite**，PDF 显示与编辑使用 PDF.js、pdf-lib 和 QPDF/WASM。仓库也保留旧 Electron 宿主作为兼容回退，但它不是当前默认发行路径。

需要 Windows、Node.js 22+、Rust stable（至少 1.88）、MSVC C++ Build Tools、Windows SDK 和 WebView2。

```powershell
npm ci --ignore-scripts
npm run dev                 # Tauri 开发窗口
npm test                    # 前端单元测试
npm run build:web           # TypeScript 检查与前端构建
npm run build:x64           # x64 NSIS 安装包
npm run build:arm64         # ARM64 NSIS 安装包
```

ARM64 可在原生 ARM64 Windows 环境构建，也可在 x64 主机安装对应的 ARM64 MSVC 编译工具和 SDK 库后交叉构建。安装向导本身的架构不能代表其中主程序的架构。

仓库另附一个手动触发的 GitHub Actions 工作流，分别在 Windows x64 和 ARM64 runner 上构建；它不会自动创建 Release。

## 目录简介

```text
src/                 React 阅读器、编辑器与压缩界面
src-tauri/           Tauri / Rust 宿主、SQLite 与 Windows 原生能力
electron/            旧 Electron 兼容宿主
public/              字体、字符映射及应用图标
resources/ocr/       Electron 回退使用的本地 OCR 模型
scripts/             构建辅助和合成文档回归脚本
tests/               合成测试夹具与测试辅助代码
```

本机测试记录见 [0.2.7 发布说明](docs/RELEASE-0.2.7.md)。测试通过不代表所有文件、系统环境或真实设备都已覆盖。

## 许可与第三方资源

本项目目前没有另外指定开源许可证。在没有额外授权说明前，公开源码不等同于授予任意再分发或许可权。

PDF.js 字符映射和字体、OCR 模型及其他依赖仍遵循各自许可证；相关说明保留在对应目录中。仓库不包含测试用的私人合同、真实邮件正文、API 密钥或本机客户端配置。
