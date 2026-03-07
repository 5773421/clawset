# clawset-desktop

## 1. 项目简介

`clawset-desktop` 是 OpenClaw 的桌面控制面板（P0 MVP），技术栈为 Tauri 2 + React + TypeScript + Vite + pnpm。  
当前目标是提供本地环境的基础可视化运维能力（检测、控制、状态查看、常用配置修改）。

## 2. 当前 P0 功能

- Overview 概览卡片
  - OpenClaw 安装状态
  - 版本
  - 安装路径
  - 配置文件路径
- Actions 操作区
  - Install
  - Start
  - Stop
  - Restart
  - Refresh Status
  - Open Dashboard
- Gateway Status
  - JSON 关键字段解析展示
  - 原始输出展示
- Settings（6 个常用配置项）
  - `update.channel`
  - `update.checkOnStart`
  - `acp.enabled`
  - `acp.defaultAgent`
  - `agents.defaults.thinkingDefault`
  - `agents.defaults.heartbeat.every`
- 操作过程中的加载、成功、失败反馈

## 3. 环境要求

- Node.js 与 pnpm（用于前端依赖与脚本）
- Rust toolchain（用于 Tauri/Rust 命令执行）
- Tauri 2 构建所需系统依赖
- 本机可用的 OpenClaw 环境（用于真实检测与控制）

## 4. 本地运行

安装依赖：

```bash
pnpm install
```

启动桌面开发模式：

```bash
pnpm tauri dev
```

构建前端资源：

```bash
pnpm build
```

构建 Debug 桌面包：

```bash
pnpm tauri build --debug
```

## 5. 界面怎么用（Overview / Actions / Gateway Status / Settings）

- Overview：先看是否已安装、当前版本、安装路径、配置文件位置。
- Actions：按需执行 Install / Start / Stop / Restart / Refresh Status / Open Dashboard。
- Gateway Status：查看网关状态的结构化字段与原始输出，便于快速排错。
- Settings：修改 6 个常用字段并提交，随后可用 Refresh Status 或重新查看配置验证结果。

## 6. 风险提示

**Start/Stop/Restart and config editing directly affect the current local OpenClaw environment.**  
即：`Start` / `Stop` / `Restart` 以及配置编辑会直接作用于你当前本机的 OpenClaw 运行环境，不是模拟操作。

部分按钮会通过 Rust 命令直接调用本地 OpenClaw CLI（`std::process::Command`），你可能看到类似插件注册输出：

```text
[plugins] feishu_doc: Registered feishu_doc, feishu_app_scopes
[plugins] feishu_chat: Registered feishu_chat tool
[plugins] feishu_wiki: Registered feishu_wiki tool
[plugins] feishu_drive: Registered feishu_drive tool
[plugins] feishu_bitable: Registered bitable tools
```

## 7. 当前限制

- 目前是 P0 MVP，只覆盖最核心的控制与配置场景。
- Settings 仅暴露 6 个高频字段，未覆盖全部 OpenClaw 配置项。
- 操作成功与否依赖本机 OpenClaw、系统环境与命令执行权限。
- 主要用于本地单机运维，不包含多实例集中管理能力。
