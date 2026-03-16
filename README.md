# Clawset Desktop

`Clawset Desktop` 是一个面向本地 OpenClaw 环境的桌面应用，用来完成安装、首次配置和日常管理。当前项目已经不再只是早期的 P0 控制面板，而是一个以 Tauri 桌面运行时为核心、覆盖 onboarding 和后续维护流程的实际管理工具。

技术栈：`Tauri 2` + `React 18` + `TypeScript` + `Vite` + `pnpm`

## 当前项目状态

- 当前版本：`0.2.4`
- 当前形态：`首次安装向导 + Dashboard 日常管理`
- 已有能力：安装检测与安装、AI 服务连接、默认模型设置、启动初始化、状态查看、启动/停止/重启、打开 OpenClaw Dashboard、Provider 配置编辑、配置备份与恢复
- 近期能力演进重点：从 onboarding-first 的安装流程，扩展到可直接进入的管理 Dashboard，同时补齐了配置迁移、默认模型恢复、瞬时 gateway 重连恢复、备份/恢复等稳定性能力

## 项目是做什么的

这个应用围绕“本地单机 OpenClaw 的真实使用过程”设计：

- 首次使用时，按向导完成语言选择、安装检测/安装、AI 服务连接和启动初始化
- 已配置完成后，直接进入 Dashboard 做日常管理
- 真正的安装、控制、配置写入、备份与恢复，都通过 Tauri 后端命令直接作用于本机 OpenClaw 环境

如果你只是用浏览器打开前端页面，它只能预览 UI，不能真正执行这些本地操作。

## 当前核心功能

### 1. 首次安装向导

向导当前是 5 步流程：

1. 选择语言
2. 检测 OpenClaw 是否已安装；未安装时执行安装
3. 连接 AI 服务并写入 Provider 配置
4. 启动 OpenClaw 并完成首次初始化
5. 完成后进入 Dashboard

当前向导能力包括：

- 检测本机 `openclaw` 是否可用，并读取版本、安装位置等信息
- 在未安装时执行安装流程
- 连接 AI 服务并保存配置，内置 `OpenAI`、`Kimi`、`GLM`、`OpenRouter` 预设，也支持自定义兼容服务
- 设置默认模型，并在保存 Provider 时同步补齐 OpenClaw 所需的默认模型选择
- 启动阶段检查 3 个关键状态：
  - `OpenClaw service`
  - `local gateway`
  - `app connection`

### 2. Dashboard 日常管理界面

完成首次配置后，应用会进入 Dashboard，用于后续日常操作：

- 查看服务状态：`OpenClaw service / local gateway / app connection`
- 执行控制操作：
  - 启动
  - 停止
  - 重启
  - 打开 Dashboard
  - 刷新状态
- 查看当前 Provider 列表并编辑已有配置
- 修改 Provider 的访问密钥、服务地址、兼容模式和默认模型
- 通过系统默认浏览器打开 OpenClaw Dashboard

### 3. Provider 配置与默认模型

当前应用会直接读写 OpenClaw 的 Provider 配置，并围绕默认模型做配套处理：

- 读取 `models.providers` 中的当前 Provider 配置
- 保存 Provider 时使用 OpenClaw CLI 写入配置，而不是只做前端层面的临时状态
- 保存时会同步设置默认模型选择，补齐 `agents.defaults.model.primary` 所需信息
- 保存时也会确保 gateway 处于本地模式，以匹配当前桌面端管理方式

### 4. 兼容模式

当前界面支持以下兼容模式：

| 兼容值 | 说明 |
| --- | --- |
| `openai-completions` | OpenAI / Chat Completions 兼容接口 |
| `openai-responses` | OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses |
| `anthropic-messages` | Anthropic Messages |
| `google-generative-ai` | Google Generative AI |
| `github-copilot` | GitHub Copilot |
| `bedrock-converse-stream` | AWS Bedrock ConverseStream |
| `ollama` | Ollama |
| `custom` | 手动填写自定义兼容值 |

应用还会把一些旧兼容值别名规范化为当前值，例如旧的 `openai`、`anthropic`、`google` 等配置会在读取或启动前迁移到当前格式。

### 5. 配置备份与恢复

当前已提供配置备份与恢复能力：

- 支持手动创建备份
- 支持列出本地备份并从指定归档恢复
- 进入 Dashboard 后会静默创建一次备份
- 在 Dashboard 中保存 Provider 前，也会先创建一份备份
- 备份目录位于 `~/.openclaw/backups`
- 当前会自动清理旧备份，仅保留最近 `10` 份 `.tar.gz` 备份

恢复备份当前会回写 `openclaw.json`，恢复后需要重启 OpenClaw 才会生效。

### 6. 启动阶段的稳定性处理

当前启动链路不只是简单执行 `start`，还包含一些为真实本地环境准备的恢复逻辑：

- 启动前会先做配置迁移，处理旧 Provider 配置中的兼容值和 `models` 结构
- 如果默认模型缺失，但当前配置里只存在一个明确可用的模型引用，会自动恢复默认模型选择
- 启动时会先校验配置，再根据状态决定是否需要安装本地 gateway 运行时
- 如果 gateway 在启动过程中发生瞬时重连或 websocket 异常关闭，会自动轮询重试状态，避免把已经恢复的场景误判成失败

## 使用方式

### 浏览器预览 vs Tauri 桌面运行时

- `pnpm dev` 或 `pnpm preview` 只能查看前端 UI
- 真正的安装、控制、配置写入、备份恢复，必须在 Tauri 桌面运行时中执行
- 浏览器模式下，这些操作会直接返回“桌面运行时不可用”的错误，而不会真的改动本地 OpenClaw

### 开发与构建命令

先安装依赖：

```bash
pnpm install
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动浏览器预览，只用于看 UI |
| `pnpm preview` | 预览已构建的前端产物，只用于看 UI |
| `pnpm tauri dev` | 启动 Tauri 桌面开发环境，真实执行安装/控制/配置写入 |
| `pnpm build` | 构建前端产物 |
| `pnpm tauri build` | 构建 Tauri 桌面应用 |
| `pnpm package:mac` | 执行 macOS 打包脚本，生成可分发产物 |

### macOS 打包

仓库当前提供了 `scripts/package-macos.sh`，用于 macOS 桌面包构建与打包。

```bash
pnpm package:mac
```

脚本当前会：

- 先执行 `pnpm tauri build --bundles app`
- 对 `.app` 做签名校验
- 生成 `.app.zip`
- 生成可拖拽安装的 `.dmg`

构建产物输出到：

```text
artifacts/macos/
```

当前脚本产物文件名包含版本号和架构标识，例如：

- `clawset-desktop_<version>_aarch64.app.zip`
- `clawset-desktop_<version>_aarch64.dmg`

如需指定签名，可使用：

- `MACOS_SIGN_IDENTITY`
- `MACOS_ENTITLEMENTS_PATH`

未显式指定时，脚本默认使用 `-` 做 ad-hoc 签名。

## 适用范围与限制

- 当前项目主要围绕“本地单机 OpenClaw 管理”设计，不是多实例、多主机或集中控制平台
- 当前 README 不把它描述成通用跨平台分发方案；仓库里已经有 macOS 打包脚本，打包说明以 macOS 为准
- 浏览器模式只适合预览界面，不适合验证真实功能
- 实际控制能力依赖本机的 OpenClaw 环境、CLI 可执行性、Node 运行时解析、本地权限和所连接 AI 服务的可用性
- 备份恢复当前聚焦配置文件恢复，不会替代完整的外部运维或多环境配置管理

## 目录产物与仓库事实速览

- 包版本：`package.json` 当前为 `0.2.4`
- Tauri 应用版本：`src-tauri/tauri.conf.json` 当前为 `0.2.4`
- 主界面模式：安装向导或管理 Dashboard
- 桌面窗口标题：`Clawset Desktop`

如果你想验证真实功能，请优先使用 `pnpm tauri dev`，不要只在浏览器里看预览页面。
