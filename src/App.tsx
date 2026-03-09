import { useEffect, useMemo, useState } from "react";
import {
  detectOpenclaw,
  gatewayControl,
  gatewayStatus,
  getCommonSettings,
  getConfigFile,
  installOpenclaw,
  openDashboard,
  readOpenclawConfig,
  readOpenclawProviders,
  runOpenclawOnboard,
  setCommonSetting,
  writeOpenclawChannel,
  writeOpenclawProvider,
} from "./lib/tauri";
import type {
  ChannelType,
  CommandResponse,
  CommonSettings,
  GatewayAction,
  SettingPath,
} from "./types";

type NoticeKind = "success" | "error" | "info";
type Locale = "zh-CN" | "en-US";
type AppView = "language-select" | "onboarding" | "dashboard";
type OnboardingStepState = "done" | "active" | "pending";
type RequiredCheckKey =
  | "cliInstalled"
  | "configExists"
  | "providerConfigured"
  | "daemonInstalled"
  | "gatewayListening"
  | "rpcConnected";
type HomeStatus =
  | "not-installed"
  | "installed-not-started"
  | "starting"
  | "service-error"
  | "console-ready";

type HomeAction =
  | "install"
  | "save-provider"
  | "run-onboard"
  | "start"
  | "stop"
  | "restart"
  | "refresh-status"
  | "refresh-all"
  | "open-dashboard";

interface Notice {
  kind: NoticeKind;
  text: string;
}

interface OverviewState {
  installed: boolean;
  version: string;
  path: string;
  configFile: string;
}

interface DetectSummary {
  installed: boolean | null;
  version: string;
  path: string;
  configFile: string;
  installDir: string;
}

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  state: OnboardingStepState;
}

interface SetupChecks {
  cliInstalled: boolean;
  configExists: boolean;
  providerConfigured: boolean;
  daemonInstalled: boolean;
  gatewayListening: boolean;
  rpcConnected: boolean;
}

interface GatewayInsight {
  daemonInstalled: boolean | null;
  gatewayListening: boolean | null;
  rpcConnected: boolean | null;
  hasError: boolean;
  summary: string;
}

interface ChannelSnapshot {
  telegramConfigured: boolean;
  feishuConfigured: boolean;
}

interface ProviderFormState {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  defaultModel: string;
}

interface TelegramFormState {
  botToken: string;
}

interface FeishuFormState {
  appId: string;
  appSecret: string;
}

const LOCALE_STORAGE_KEY = "clawset.locale";

const DEFAULT_SETTINGS: CommonSettings = {
  "update.channel": "",
  "update.checkOnStart": "false",
  "acp.enabled": "false",
  "acp.defaultAgent": "",
  "agents.defaults.thinkingDefault": "",
  "agents.defaults.heartbeat.every": "",
};

const DEFAULT_PROVIDER_FORM: ProviderFormState = {
  providerName: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  api: "openai",
  defaultModel: "gpt-4o-mini",
};

const REQUIRED_CHECK_ORDER: RequiredCheckKey[] = [
  "cliInstalled",
  "configExists",
  "providerConfigured",
  "daemonInstalled",
  "gatewayListening",
  "rpcConnected",
];

const I18N = {
  "zh-CN": {
    appTitle: "Clawset Desktop",
    appSubtitle: "OpenClaw Setup Wizard v2",
    language: "语言",
    running: "执行中",
    lastUpdated: "最后刷新",
    noticeReady: "就绪",
    noticeRefreshing: "正在刷新 setup 状态...",
    noticeRefreshed: "setup 状态已刷新",
    noticeNeedInstall: "未检测到 OpenClaw，请先安装。",
    noticeNeedProvider: "请先至少配置一个 Provider。",
    noticeNeedRuntime: "请完成 daemon / gateway / RPC 初始化。",
    languageTitle: "选择语言",
    languageDescription: "首次使用请选择界面语言。默认简体中文，后续可随时切换。",
    languageConfirm: "继续",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "Setup Wizard v2",
    onboardingDescription:
      "只有在 CLI 已安装、配置文件存在、至少一个 provider 已配置、daemon 已安装、gateway 正在监听、RPC 可连接时，环境才算 Ready。",
    onboardingProgress: "必需项进度",
    onboardingMissing: "当前缺失项",
    onboardingAllDone: "所有必需项已满足，可以进入首页。",
    setupChecksTitle: "就绪检查",
    setupCheckCli: "CLI 已安装",
    setupCheckConfig: "配置文件存在",
    setupCheckProvider: "至少一个 Provider",
    setupCheckDaemon: "Daemon 已安装",
    setupCheckGateway: "Gateway 正在监听",
    setupCheckRpc: "RPC 可连接",
    setupCheckDone: "已满足",
    setupCheckPending: "待完成",
    setupCheckOptional: "可选",
    stepEnvTitle: "环境探测",
    stepEnvDescription: "检测 CLI 与配置文件路径。",
    stepProviderTitle: "Provider 配置",
    stepProviderDescription: "配置 provider name / base URL / API key / API protocol / default model。",
    stepChannelTitle: "Channel 配置",
    stepChannelDescription: "配置 Telegram 或飞书；QQ 先占位。",
    stepRuntimeTitle: "Runtime 初始化",
    stepRuntimeDescription: "执行 onboard 并验证 daemon、gateway、RPC。",
    stepDone: "已完成",
    stepActive: "进行中",
    stepPending: "待处理",
    recommendTitle: "推荐下一步",
    recommendInstall: "先安装 OpenClaw",
    recommendRefreshConfig: "重新检测配置文件",
    recommendProvider: "保存 Provider 配置",
    recommendRuntime: "执行 OpenClaw Onboard",
    recommendReady: "进入首页",
    actionsTitle: "操作",
    actionPrimary: "主要操作",
    actionSecondary: "次要操作",
    actionRefreshAll: "刷新全部",
    actionRefreshingAll: "刷新中...",
    actionInstall: "安装 OpenClaw",
    actionInstalling: "安装中...",
    actionRunOnboard: "运行 Onboard",
    actionRunningOnboard: "Onboard 中...",
    actionStartGateway: "启动 Gateway",
    actionStartingGateway: "启动中...",
    actionRefreshStatus: "刷新 Gateway 状态",
    actionRefreshingStatus: "刷新中...",
    actionOpenDashboard: "打开 Dashboard",
    actionOpeningDashboard: "打开中...",
    actionStart: "启动",
    actionStop: "停止",
    actionRestart: "重启",
    actionStopping: "停止中...",
    actionRestarting: "重启中...",
    setupProviderTitle: "Provider 配置",
    setupProviderHint: "至少保存一个 provider，Ready 校验才会通过。",
    providerName: "Provider Name",
    providerBaseUrl: "Base URL",
    providerApiKey: "API Key",
    providerApiProtocol: "API Protocol",
    providerDefaultModel: "Default Model",
    actionSaveProvider: "保存 Provider",
    actionSavingProvider: "保存中...",
    providerConfiguredCount: "已配置 Provider 数量",
    setupChannelTitle: "Channel 配置",
    setupChannelHint: "支持 Telegram 与飞书。QQ 当前仅展示官方接入入口。",
    channelTelegram: "Telegram",
    channelFeishu: "飞书",
    channelQq: "QQ（占位）",
    channelBotToken: "Bot Token",
    channelAppId: "App ID",
    channelAppSecret: "App Secret",
    actionSaveTelegram: "保存 Telegram",
    actionSaveFeishu: "保存飞书",
    actionSavingChannel: "保存中...",
    channelConfigured: "已配置",
    channelNotConfigured: "未配置",
    qqPlaceholderText: "QQ 渠道正在接入中，请先参考官方接入文档。",
    qqPlaceholderLink: "打开 QQ 官方接入说明",
    overviewTitle: "环境概览",
    overviewInstallStatus: "OpenClaw 安装状态",
    overviewGatewayStatus: "Gateway 监听状态",
    overviewRpcStatus: "RPC 连通状态",
    overviewInstalled: "已安装",
    overviewNotInstalled: "未安装",
    overviewReady: "可用",
    overviewNotReady: "不可用",
    overviewVersion: "版本",
    overviewPath: "路径",
    overviewConfigFile: "配置文件",
    outputTitle: "最新命令输出",
    outputHistoryTitle: "执行记录",
    outputEmpty: "(空)",
    homeTitle: "首页",
    homeSubtitle: "OpenClaw 控制中心",
    homeStatusTitle: "当前环境状态",
    homeServiceTitle: "服务状态",
    homeNextStepTitle: "下一步建议",
    homeQuickActionsTitle: "其他操作",
    statusHumanNotInstalled: "未安装",
    statusHumanInstalledNotStarted: "已安装未就绪",
    statusHumanStarting: "初始化中",
    statusHumanServiceError: "服务异常",
    statusHumanReady: "Ready",
    statusExplainNotInstalled: "当前设备未检测到 OpenClaw。",
    statusExplainInstalledNotStarted: "OpenClaw 已安装，但 daemon/gateway/RPC 尚未全部就绪。",
    statusExplainStarting: "正在等待安装或运行时初始化完成。",
    statusExplainServiceError: "运行状态异常，建议重试 onboard 并刷新状态。",
    statusExplainReady: "全部检查通过，可继续使用 Dashboard。",
    nextInstall: "先安装 OpenClaw。",
    nextProvider: "先完成 Provider 配置。",
    nextRuntime: "执行 Onboard，等待 daemon/gateway/RPC 就绪。",
    nextOpenDashboard: "打开 Dashboard 开始使用。",
    homeAdvancedDiagnostics: "高级诊断",
    homeAdvancedDiagnosticsHint: "包含原始 JSON 与底层输出，默认折叠。",
    diagnosticsStructuredStatus: "Gateway 结构化状态",
    diagnosticsRawGateway: "Gateway 原始输出",
    diagnosticsLastCommand: "最近命令输出",
    diagnosticsHistory: "执行历史",
    diagnosticsNone: "暂无结构化状态，已保留原始输出。",
    homeAdvancedSettings: "高级设置",
    homeAdvancedSettingsHint: "仅在需要时修改常用配置。",
    settingsTitle: "Settings",
    settingsReload: "刷新配置",
    settingsReloading: "刷新中...",
    settingsSaveAll: "保存全部",
    settingsSavingAll: "保存中...",
    settingsSaveOne: "保存",
    settingsSavingOne: "保存中...",
    fieldBooleanTrue: "true",
    fieldBooleanFalse: "false",
    saveAllSuccess: "全部设置已保存",
    savePartialFail: "部分设置保存失败",
    commandFailed: "命令执行失败",
    noticeCurrentStatus: "当前状态",
    logDetect: "检测 OpenClaw",
    logConfigFile: "读取配置文件路径",
    logConfigJson: "读取 OpenClaw 配置",
    logProviders: "读取 Provider 列表",
    logGatewayStatus: "读取 Gateway 状态",
    logSettings: "读取常用配置",
  },
  "en-US": {
    appTitle: "Clawset Desktop",
    appSubtitle: "OpenClaw Setup Wizard v2",
    language: "Language",
    running: "Running",
    lastUpdated: "Last Updated",
    noticeReady: "Ready",
    noticeRefreshing: "Refreshing setup status...",
    noticeRefreshed: "Setup status refreshed",
    noticeNeedInstall: "OpenClaw is not detected. Install it first.",
    noticeNeedProvider: "Please configure at least one provider.",
    noticeNeedRuntime: "Please finish daemon / gateway / RPC initialization.",
    languageTitle: "Choose Language",
    languageDescription: "Choose your UI language on first launch.",
    languageConfirm: "Continue",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "Setup Wizard v2",
    onboardingDescription:
      "Ready only when CLI is installed + config exists + at least one provider + daemon installed + gateway listening + RPC reachable.",
    onboardingProgress: "Required Progress",
    onboardingMissing: "Missing checks",
    onboardingAllDone: "All required checks passed. You can enter Home.",
    setupChecksTitle: "Readiness Checks",
    setupCheckCli: "CLI Installed",
    setupCheckConfig: "Config Exists",
    setupCheckProvider: "At Least 1 Provider",
    setupCheckDaemon: "Daemon Installed",
    setupCheckGateway: "Gateway Listening",
    setupCheckRpc: "RPC Reachable",
    setupCheckDone: "Done",
    setupCheckPending: "Pending",
    setupCheckOptional: "Optional",
    stepEnvTitle: "Environment Detection",
    stepEnvDescription: "Detect CLI and config file path.",
    stepProviderTitle: "Provider Configuration",
    stepProviderDescription: "Configure provider name / base URL / API key / API protocol / default model.",
    stepChannelTitle: "Channel Configuration",
    stepChannelDescription: "Configure Telegram or Feishu; QQ is placeholder for now.",
    stepRuntimeTitle: "Runtime Initialization",
    stepRuntimeDescription: "Run onboard and verify daemon, gateway, and RPC.",
    stepDone: "Done",
    stepActive: "Active",
    stepPending: "Pending",
    recommendTitle: "Recommended Next Step",
    recommendInstall: "Install OpenClaw first",
    recommendRefreshConfig: "Re-check config file",
    recommendProvider: "Save provider configuration",
    recommendRuntime: "Run OpenClaw onboard",
    recommendReady: "Enter home",
    actionsTitle: "Actions",
    actionPrimary: "Primary",
    actionSecondary: "Secondary",
    actionRefreshAll: "Refresh All",
    actionRefreshingAll: "Refreshing...",
    actionInstall: "Install OpenClaw",
    actionInstalling: "Installing...",
    actionRunOnboard: "Run Onboard",
    actionRunningOnboard: "Running Onboard...",
    actionStartGateway: "Start Gateway",
    actionStartingGateway: "Starting...",
    actionRefreshStatus: "Refresh Gateway Status",
    actionRefreshingStatus: "Refreshing...",
    actionOpenDashboard: "Open Dashboard",
    actionOpeningDashboard: "Opening...",
    actionStart: "Start",
    actionStop: "Stop",
    actionRestart: "Restart",
    actionStopping: "Stopping...",
    actionRestarting: "Restarting...",
    setupProviderTitle: "Provider Configuration",
    setupProviderHint: "At least one saved provider is required for Ready.",
    providerName: "Provider Name",
    providerBaseUrl: "Base URL",
    providerApiKey: "API Key",
    providerApiProtocol: "API Protocol",
    providerDefaultModel: "Default Model",
    actionSaveProvider: "Save Provider",
    actionSavingProvider: "Saving...",
    providerConfiguredCount: "Configured Providers",
    setupChannelTitle: "Channel Configuration",
    setupChannelHint: "Telegram and Feishu are supported. QQ is currently a placeholder.",
    channelTelegram: "Telegram",
    channelFeishu: "Feishu",
    channelQq: "QQ (Placeholder)",
    channelBotToken: "Bot Token",
    channelAppId: "App ID",
    channelAppSecret: "App Secret",
    actionSaveTelegram: "Save Telegram",
    actionSaveFeishu: "Save Feishu",
    actionSavingChannel: "Saving...",
    channelConfigured: "Configured",
    channelNotConfigured: "Not configured",
    qqPlaceholderText: "QQ channel integration is in progress. Please use the official guide.",
    qqPlaceholderLink: "Open QQ official integration page",
    overviewTitle: "Environment Overview",
    overviewInstallStatus: "OpenClaw Install",
    overviewGatewayStatus: "Gateway Listening",
    overviewRpcStatus: "RPC Connectivity",
    overviewInstalled: "Installed",
    overviewNotInstalled: "Not Installed",
    overviewReady: "Ready",
    overviewNotReady: "Not Ready",
    overviewVersion: "Version",
    overviewPath: "Path",
    overviewConfigFile: "Config File",
    outputTitle: "Latest Command Output",
    outputHistoryTitle: "Execution History",
    outputEmpty: "(empty)",
    homeTitle: "Home",
    homeSubtitle: "OpenClaw control center",
    homeStatusTitle: "Environment",
    homeServiceTitle: "Service",
    homeNextStepTitle: "Next Suggestion",
    homeQuickActionsTitle: "Other Actions",
    statusHumanNotInstalled: "Not installed",
    statusHumanInstalledNotStarted: "Installed, not ready",
    statusHumanStarting: "Initializing",
    statusHumanServiceError: "Service error",
    statusHumanReady: "Ready",
    statusExplainNotInstalled: "OpenClaw is not detected on this machine.",
    statusExplainInstalledNotStarted:
      "OpenClaw is installed, but daemon/gateway/RPC are not fully ready.",
    statusExplainStarting: "Waiting for installation or runtime initialization.",
    statusExplainServiceError: "Runtime status is abnormal. Retry onboard and refresh status.",
    statusExplainReady: "All checks passed. Dashboard is available.",
    nextInstall: "Install OpenClaw first.",
    nextProvider: "Configure a provider first.",
    nextRuntime: "Run onboard and wait for daemon/gateway/RPC.",
    nextOpenDashboard: "Open Dashboard to continue.",
    homeAdvancedDiagnostics: "Advanced Diagnostics",
    homeAdvancedDiagnosticsHint: "Contains raw JSON and low-level output. Collapsed by default.",
    diagnosticsStructuredStatus: "Structured gateway status",
    diagnosticsRawGateway: "Gateway raw output",
    diagnosticsLastCommand: "Latest command output",
    diagnosticsHistory: "Execution history",
    diagnosticsNone: "No structured status yet. Raw output is preserved.",
    homeAdvancedSettings: "Advanced Settings",
    homeAdvancedSettingsHint: "Edit common settings only when needed.",
    settingsTitle: "Settings",
    settingsReload: "Reload Settings",
    settingsReloading: "Reloading...",
    settingsSaveAll: "Save All",
    settingsSavingAll: "Saving...",
    settingsSaveOne: "Save",
    settingsSavingOne: "Saving...",
    fieldBooleanTrue: "true",
    fieldBooleanFalse: "false",
    saveAllSuccess: "All settings saved",
    savePartialFail: "Some settings failed to save",
    commandFailed: "Command execution failed",
    noticeCurrentStatus: "Current status",
    logDetect: "Detect OpenClaw",
    logConfigFile: "Read config file path",
    logConfigJson: "Read OpenClaw config",
    logProviders: "Read providers",
    logGatewayStatus: "Read gateway status",
    logSettings: "Read common settings",
  },
} as const;

const SETTING_FIELDS: Array<{
  path: SettingPath;
  label: string;
  description: Record<Locale, string>;
  control: "text" | "boolean";
  placeholder: string;
}> = [
  {
    path: "update.channel",
    label: "update.channel",
    description: {
      "zh-CN": "更新通道（例如 stable / beta）",
      "en-US": "Update channel (for example stable / beta)",
    },
    control: "text",
    placeholder: "stable",
  },
  {
    path: "update.checkOnStart",
    label: "update.checkOnStart",
    description: {
      "zh-CN": "启动时检查更新",
      "en-US": "Check updates on start",
    },
    control: "boolean",
    placeholder: "true/false",
  },
  {
    path: "acp.enabled",
    label: "acp.enabled",
    description: {
      "zh-CN": "是否启用 ACP",
      "en-US": "Enable ACP or not",
    },
    control: "boolean",
    placeholder: "true/false",
  },
  {
    path: "acp.defaultAgent",
    label: "acp.defaultAgent",
    description: {
      "zh-CN": "ACP 默认代理名称",
      "en-US": "ACP default agent name",
    },
    control: "text",
    placeholder: "agent-name",
  },
  {
    path: "agents.defaults.thinkingDefault",
    label: "agents.defaults.thinkingDefault",
    description: {
      "zh-CN": "默认思考强度",
      "en-US": "Default thinking level",
    },
    control: "text",
    placeholder: "medium",
  },
  {
    path: "agents.defaults.heartbeat.every",
    label: "agents.defaults.heartbeat.every",
    description: {
      "zh-CN": "心跳间隔（例如 30s）",
      "en-US": "Heartbeat interval (for example 30s)",
    },
    control: "text",
    placeholder: "30s",
  },
];

function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (value === "zh-CN" || value === "en-US") {
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0];
  return line || "-";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDetectValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "-";
  }

  const lower = normalized.toLowerCase();
  if (
    lower === "(empty)" ||
    lower === "(none)" ||
    lower === "none" ||
    lower === "null" ||
    lower === "undefined"
  ) {
    return "-";
  }

  return normalized;
}

function hasDetectSignal(value: string): boolean {
  const normalized = normalizeDetectValue(value).toLowerCase();
  return normalized !== "-" && normalized !== "not found" && normalized !== "(not found)";
}

function parseDetect(stdout: string): DetectSummary {
  let installed: boolean | null = null;
  let version = "-";
  let path = "-";
  let configFile = "-";
  let installDir = "-";

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("installed:")) {
      const value = line.replace("installed:", "").trim().toLowerCase();
      if (value === "true") {
        installed = true;
      } else if (value === "false") {
        installed = false;
      }
    } else if (line.startsWith("version:")) {
      version = normalizeDetectValue(line.replace("version:", "").trim());
    } else if (line.startsWith("path:")) {
      path = normalizeDetectValue(line.replace("path:", "").trim());
    } else if (line.startsWith("config_file:")) {
      configFile = normalizeDetectValue(line.replace("config_file:", "").trim());
    } else if (line.startsWith("install_dir:")) {
      installDir = normalizeDetectValue(line.replace("install_dir:", "").trim());
    }
  }

  return {
    installed,
    version,
    path,
    configFile,
    installDir,
  };
}

function inferInstalledFromDetect(response: CommandResponse, detect: DetectSummary): boolean {
  if (detect.installed !== null) {
    return detect.installed;
  }

  return response.success || hasDetectSignal(detect.path) || hasDetectSignal(detect.version);
}

function normalizeBoolean(value: string): "true" | "false" {
  return value.trim().toLowerCase() === "true" ? "true" : "false";
}

function containsToken(text: string, tokens: string[]): boolean {
  const normalized = text.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function toBooleanSignal(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    if (value > 0) {
      return true;
    }
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "running" ||
    normalized === "active" ||
    normalized === "started" ||
    normalized === "ready" ||
    normalized === "healthy" ||
    normalized === "ok" ||
    normalized === "up" ||
    normalized === "connected" ||
    normalized === "listening"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "stopped" ||
    normalized === "inactive" ||
    normalized === "down" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "not running" ||
    normalized === "disconnected"
  ) {
    return false;
  }

  return null;
}

function collectObjectSignals(
  value: Record<string, unknown>,
  prefix = "",
  output: Array<{ key: string; value: unknown }> = [],
): Array<{ key: string; value: unknown }> {
  for (const [key, item] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    output.push({ key: nextKey, value: item });
    if (isRecord(item)) {
      collectObjectSignals(item, nextKey, output);
    }
  }
  return output;
}

function signalFromParsed(
  signals: Array<{ key: string; value: unknown }>,
  keyTokens: string[],
  positiveTokens: string[],
  negativeTokens: string[],
): boolean | null {
  for (const signal of signals) {
    const key = signal.key.toLowerCase();
    if (!keyTokens.some((token) => key.includes(token))) {
      continue;
    }

    const boolSignal = toBooleanSignal(signal.value);
    if (boolSignal !== null) {
      return boolSignal;
    }

    const text = toText(signal.value).toLowerCase();
    if (containsToken(text, negativeTokens)) {
      return false;
    }
    if (containsToken(text, positiveTokens)) {
      return true;
    }
  }

  return null;
}

function analyzeGatewayInsight(
  response: CommandResponse | null,
  parsed: Record<string, unknown> | null,
  raw: string,
): GatewayInsight {
  const signals = parsed ? collectObjectSignals(parsed) : [];

  const daemonPositive = ["installed", "running", "active", "ready", "ok"];
  const daemonNegative = ["not installed", "missing", "stopped", "failed", "error"];
  const gatewayPositive = ["listening", "running", "active", "online", "ready", "up"];
  const gatewayNegative = ["not listening", "not running", "stopped", "down", "failed", "offline"];
  const rpcPositive = ["connected", "ready", "available", "online", "ok"];
  const rpcNegative = ["not connected", "disconnected", "unavailable", "failed", "timeout", "error"];

  let daemonInstalled = signalFromParsed(
    signals,
    ["daemon"],
    daemonPositive,
    daemonNegative,
  );
  let gatewayListening = signalFromParsed(
    signals,
    ["gateway", "listen", "server", "http", "port"],
    gatewayPositive,
    gatewayNegative,
  );
  let rpcConnected = signalFromParsed(signals, ["rpc"], rpcPositive, rpcNegative);

  const mergedText = [response?.message ?? "", response?.stdout ?? "", response?.stderr ?? "", raw]
    .join("\n")
    .toLowerCase();

  if (daemonInstalled === null) {
    if (containsToken(mergedText, daemonNegative)) {
      daemonInstalled = false;
    } else if (
      containsToken(mergedText, ["daemon installed", "daemon running", "daemon ready"]) ||
      (response?.success ?? false)
    ) {
      daemonInstalled = true;
    }
  }

  if (gatewayListening === null) {
    if (containsToken(mergedText, gatewayNegative)) {
      gatewayListening = false;
    } else if (
      containsToken(mergedText, ["listening", "gateway running", "gateway started", "server started"])
    ) {
      gatewayListening = true;
    } else if (response?.success ?? false) {
      gatewayListening = true;
    }
  }

  if (rpcConnected === null) {
    if (containsToken(mergedText, rpcNegative)) {
      rpcConnected = false;
    } else if (containsToken(mergedText, ["rpc connected", "rpc ready", "rpc available"])) {
      rpcConnected = true;
    } else if ((response?.success ?? false) && gatewayListening === true) {
      rpcConnected = true;
    }
  }

  if (daemonInstalled === null && gatewayListening === true) {
    daemonInstalled = true;
  }

  const hasError =
    !(response?.success ?? true) ||
    containsToken(mergedText, ["error", "failed", "exception", "panic"]);

  return {
    daemonInstalled,
    gatewayListening,
    rpcConnected,
    hasError,
    summary: firstLine(response?.message ?? ""),
  };
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function channelSnapshotFromConfig(config: Record<string, unknown> | null): ChannelSnapshot {
  if (!config) {
    return { telegramConfigured: false, feishuConfigured: false };
  }

  const channels = config.channels;
  if (!isRecord(channels)) {
    return { telegramConfigured: false, feishuConfigured: false };
  }

  const telegram = isRecord(channels.telegram) ? channels.telegram : null;
  const feishu = isRecord(channels.feishu) ? channels.feishu : null;

  return {
    telegramConfigured: Boolean(telegram && isNonEmptyString(telegram.botToken)),
    feishuConfigured: Boolean(
      feishu && isNonEmptyString(feishu.appId) && isNonEmptyString(feishu.appSecret),
    ),
  };
}

function providerCountFromUnknown(value: unknown): number {
  if (!isRecord(value)) {
    return 0;
  }
  return Object.keys(value).length;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => readStoredLocale() ?? "zh-CN");
  const [languageConfirmed, setLanguageConfirmed] = useState<boolean>(() => readStoredLocale() !== null);
  const [overview, setOverview] = useState<OverviewState>({
    installed: false,
    version: "-",
    path: "-",
    configFile: "-",
  });
  const [configExists, setConfigExists] = useState<boolean>(false);
  const [providerCount, setProviderCount] = useState<number>(0);
  const [channels, setChannels] = useState<ChannelSnapshot>({
    telegramConfigured: false,
    feishuConfigured: false,
  });

  const [providerForm, setProviderForm] = useState<ProviderFormState>(DEFAULT_PROVIDER_FORM);
  const [telegramForm, setTelegramForm] = useState<TelegramFormState>({ botToken: "" });
  const [feishuForm, setFeishuForm] = useState<FeishuFormState>({ appId: "", appSecret: "" });
  const [channelTab, setChannelTab] = useState<ChannelType>("telegram");

  const [gatewayRaw, setGatewayRaw] = useState<string>("");
  const [gatewayParsed, setGatewayParsed] = useState<Record<string, unknown> | null>(null);
  const [gatewayResponse, setGatewayResponse] = useState<CommandResponse | null>(null);

  const [settings, setSettings] = useState<CommonSettings>(DEFAULT_SETTINGS);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastCommandOutput, setLastCommandOutput] = useState<string>("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("-");

  const t = I18N[locale];

  const gatewayEntries = useMemo(() => Object.entries(gatewayParsed ?? {}), [gatewayParsed]);
  const gatewayInsight = useMemo(
    () => analyzeGatewayInsight(gatewayResponse, gatewayParsed, gatewayRaw),
    [gatewayResponse, gatewayParsed, gatewayRaw],
  );

  const setupChecks: SetupChecks = useMemo(
    () => ({
      cliInstalled: overview.installed,
      configExists,
      providerConfigured: providerCount > 0,
      daemonInstalled: gatewayInsight.daemonInstalled === true,
      gatewayListening: gatewayInsight.gatewayListening === true,
      rpcConnected: gatewayInsight.rpcConnected === true,
    }),
    [overview.installed, configExists, providerCount, gatewayInsight],
  );

  const isReady = REQUIRED_CHECK_ORDER.every((key) => setupChecks[key]);
  const channelConfigured = channels.telegramConfigured || channels.feishuConfigured;

  const appView: AppView = !languageConfirmed
    ? "language-select"
    : isReady
      ? "dashboard"
      : "onboarding";

  const missingRequired = REQUIRED_CHECK_ORDER.filter((key) => !setupChecks[key]);
  const firstMissing = missingRequired[0] ?? null;

  const completedRequiredCount = REQUIRED_CHECK_ORDER.filter((key) => setupChecks[key]).length;
  const progressPercent = Math.round((completedRequiredCount / REQUIRED_CHECK_ORDER.length) * 100);

  const homeStatus: HomeStatus = useMemo(() => {
    if (!overview.installed) {
      return "not-installed";
    }

    if (
      busyAction === "install" ||
      busyAction === "run-onboard" ||
      busyAction === "gateway-start" ||
      busyAction === "gateway-restart" ||
      busyAction === "refresh-status" ||
      busyAction === "boot"
    ) {
      return "starting";
    }

    if (isReady) {
      return "console-ready";
    }

    if (gatewayInsight.hasError) {
      return "service-error";
    }

    return "installed-not-started";
  }, [overview.installed, busyAction, isReady, gatewayInsight.hasError]);

  const homeStatusLabel =
    homeStatus === "not-installed"
      ? t.statusHumanNotInstalled
      : homeStatus === "installed-not-started"
        ? t.statusHumanInstalledNotStarted
        : homeStatus === "starting"
          ? t.statusHumanStarting
          : homeStatus === "service-error"
            ? t.statusHumanServiceError
            : t.statusHumanReady;

  const homeStatusDescription =
    homeStatus === "not-installed"
      ? t.statusExplainNotInstalled
      : homeStatus === "installed-not-started"
        ? t.statusExplainInstalledNotStarted
        : homeStatus === "starting"
          ? t.statusExplainStarting
          : homeStatus === "service-error"
            ? t.statusExplainServiceError
            : t.statusExplainReady;

  const nextSuggestion =
    !setupChecks.cliInstalled
      ? t.nextInstall
      : !setupChecks.providerConfigured
        ? t.nextProvider
        : !isReady
          ? t.nextRuntime
          : t.nextOpenDashboard;

  const onboardingSteps: OnboardingStep[] = useMemo(
    () => [
      {
        id: "env",
        title: t.stepEnvTitle,
        description: t.stepEnvDescription,
        state:
          setupChecks.cliInstalled && setupChecks.configExists
            ? "done"
            : busyAction === "boot" || busyAction === "install"
              ? "active"
              : "pending",
      },
      {
        id: "provider",
        title: t.stepProviderTitle,
        description: t.stepProviderDescription,
        state:
          setupChecks.providerConfigured
            ? "done"
            : busyAction === "save-provider"
              ? "active"
              : "pending",
      },
      {
        id: "channel",
        title: t.stepChannelTitle,
        description: t.stepChannelDescription,
        state: channelConfigured
          ? "done"
          : busyAction === "save-channel-telegram" || busyAction === "save-channel-feishu"
            ? "active"
            : "pending",
      },
      {
        id: "runtime",
        title: t.stepRuntimeTitle,
        description: t.stepRuntimeDescription,
        state:
          setupChecks.daemonInstalled &&
          setupChecks.gatewayListening &&
          setupChecks.rpcConnected
            ? "done"
            : busyAction === "run-onboard" ||
                busyAction === "refresh-status" ||
                busyAction === "gateway-start"
              ? "active"
              : "pending",
      },
    ],
    [
      busyAction,
      channelConfigured,
      setupChecks.cliInstalled,
      setupChecks.configExists,
      setupChecks.providerConfigured,
      setupChecks.daemonInstalled,
      setupChecks.gatewayListening,
      setupChecks.rpcConnected,
      t.stepEnvTitle,
      t.stepEnvDescription,
      t.stepProviderTitle,
      t.stepProviderDescription,
      t.stepChannelTitle,
      t.stepChannelDescription,
      t.stepRuntimeTitle,
      t.stepRuntimeDescription,
    ],
  );

  const recommendedPrimaryAction: HomeAction =
    firstMissing === "cliInstalled"
      ? "install"
      : firstMissing === "configExists"
        ? "refresh-all"
        : firstMissing === "providerConfigured"
          ? "save-provider"
          : firstMissing
            ? "run-onboard"
            : "open-dashboard";

  const recommendedPrimaryText =
    firstMissing === "cliInstalled"
      ? t.recommendInstall
      : firstMissing === "configExists"
        ? t.recommendRefreshConfig
        : firstMissing === "providerConfigured"
          ? t.recommendProvider
          : firstMissing
            ? t.recommendRuntime
            : t.recommendReady;

  const checkLabels: Record<RequiredCheckKey, string> = {
    cliInstalled: t.setupCheckCli,
    configExists: t.setupCheckConfig,
    providerConfigured: t.setupCheckProvider,
    daemonInstalled: t.setupCheckDaemon,
    gatewayListening: t.setupCheckGateway,
    rpcConnected: t.setupCheckRpc,
  };

  const isBusy = (action: string): boolean => busyAction === action || busyAction === "boot";

  function homeActionText(action: HomeAction): string {
    if (action === "install") {
      return isBusy("install") ? t.actionInstalling : t.actionInstall;
    }
    if (action === "run-onboard") {
      return isBusy("run-onboard") ? t.actionRunningOnboard : t.actionRunOnboard;
    }
    if (action === "save-provider") {
      return isBusy("save-provider") ? t.actionSavingProvider : t.actionSaveProvider;
    }
    if (action === "start") {
      return isBusy("gateway-start") ? t.actionStartingGateway : t.actionStartGateway;
    }
    if (action === "stop") {
      return isBusy("gateway-stop") ? t.actionStopping : t.actionStop;
    }
    if (action === "restart") {
      return isBusy("gateway-restart") ? t.actionRestarting : t.actionRestart;
    }
    if (action === "refresh-status") {
      return isBusy("refresh-status") ? t.actionRefreshingStatus : t.actionRefreshStatus;
    }
    if (action === "refresh-all") {
      return isBusy("boot") ? t.actionRefreshingAll : t.actionRefreshAll;
    }
    return isBusy("dashboard") ? t.actionOpeningDashboard : t.actionOpenDashboard;
  }

  function isHomeActionDisabled(action: HomeAction): boolean {
    if (Boolean(busyAction)) {
      return true;
    }

    if (action === "install") {
      return overview.installed;
    }

    if (action === "open-dashboard") {
      return !isReady;
    }

    if (action === "refresh-all") {
      return false;
    }

    if (action === "save-provider") {
      return !overview.installed;
    }

    if (action === "run-onboard") {
      return !overview.installed;
    }

    return !overview.installed;
  }

  function resetConfigAndProviders() {
    setConfigExists(false);
    setProviderCount(0);
    setChannels({ telegramConfigured: false, feishuConfigured: false });
  }

  function persistLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // ignore storage failure
    }
  }

  function markUpdated() {
    const localeCode = locale === "zh-CN" ? "zh-CN" : "en-US";
    setLastUpdated(new Date().toLocaleString(localeCode));
  }

  function recordResponse(actionName: string, response: CommandResponse) {
    const lines = [
      `action: ${actionName}`,
      `success: ${response.success}`,
      `exit_code: ${response.exit_code}`,
      `message: ${response.message}`,
      `stdout:\n${response.stdout || t.outputEmpty}`,
      `stderr:\n${response.stderr || t.outputEmpty}`,
    ];
    const text = lines.join("\n");
    setLastCommandOutput(text);
    const stamp = new Date().toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US");
    setCommandHistory((current) => [`[${stamp}] ${actionName}`, ...current].slice(0, 30));
  }

  async function refreshOverview(): Promise<{ installed: boolean }> {
    const detectResponse = await detectOpenclaw();
    recordResponse(t.logDetect, detectResponse);
    const detectParsed = parseDetect(detectResponse.stdout);
    const installed = inferInstalledFromDetect(detectResponse, detectParsed);

    let configFile = "-";
    if (installed) {
      configFile = detectParsed.configFile;
      const configResponse = await getConfigFile();
      recordResponse(t.logConfigFile, configResponse);
      if (configResponse.success && configResponse.stdout.trim() !== "") {
        configFile = firstLine(configResponse.stdout);
      }
    }

    setOverview({
      installed,
      version: detectParsed.version,
      path: detectParsed.path,
      configFile,
    });

    return { installed };
  }

  async function refreshConfigAndProviders(installed: boolean) {
    if (!installed) {
      resetConfigAndProviders();
      return;
    }

    const configResponse = await readOpenclawConfig();
    recordResponse(t.logConfigJson, configResponse);

    let parsedConfig: Record<string, unknown> | null = null;
    if (configResponse.success && isRecord(configResponse.parsed_json)) {
      parsedConfig = configResponse.parsed_json;
      setConfigExists(true);
    } else {
      setConfigExists(false);
    }

    const channelState = channelSnapshotFromConfig(parsedConfig);
    setChannels(channelState);

    if (parsedConfig && isRecord(parsedConfig.channels)) {
      const telegram = isRecord(parsedConfig.channels.telegram) ? parsedConfig.channels.telegram : null;
      const feishu = isRecord(parsedConfig.channels.feishu) ? parsedConfig.channels.feishu : null;

      if (telegram && isNonEmptyString(telegram.botToken)) {
        setTelegramForm({ botToken: String(telegram.botToken) });
      }
      if (feishu) {
        setFeishuForm({
          appId: isNonEmptyString(feishu.appId) ? String(feishu.appId) : "",
          appSecret: isNonEmptyString(feishu.appSecret) ? String(feishu.appSecret) : "",
        });
      }
    }

    const providersResponse = await readOpenclawProviders();
    recordResponse(t.logProviders, providersResponse);

    const count = providerCountFromUnknown(providersResponse.parsed_json);
    setProviderCount(count);

    if (providersResponse.success && isRecord(providersResponse.parsed_json) && count > 0) {
      const [providerName, providerData] = Object.entries(providersResponse.parsed_json)[0] ?? [];
      if (providerName && isRecord(providerData)) {
        const models = isRecord(providerData.models) ? providerData.models : null;
        setProviderForm((current) => ({
          ...current,
          providerName,
          baseUrl: isNonEmptyString(providerData.baseUrl) ? String(providerData.baseUrl) : current.baseUrl,
          apiKey: isNonEmptyString(providerData.apiKey) ? String(providerData.apiKey) : current.apiKey,
          api: isNonEmptyString(providerData.api) ? String(providerData.api) : current.api,
          defaultModel:
            models && isNonEmptyString(models.default_model)
              ? String(models.default_model)
              : current.defaultModel,
        }));
      }
    }
  }

  async function refreshGateway(installed: boolean) {
    if (!installed) {
      setGatewayResponse(null);
      setGatewayParsed(null);
      setGatewayRaw("");
      return null;
    }

    const response = await gatewayStatus();
    recordResponse(t.logGatewayStatus, response);
    setGatewayResponse(response);
    setGatewayRaw(response.stdout);
    if (isRecord(response.parsed_json)) {
      setGatewayParsed(response.parsed_json);
    } else {
      setGatewayParsed(null);
    }
    return response;
  }

  async function refreshSettings(installed: boolean) {
    if (!installed) {
      setSettings({ ...DEFAULT_SETTINGS });
      return null;
    }

    const response = await getCommonSettings();
    recordResponse(t.logSettings, response);

    const nextSettings: CommonSettings = { ...DEFAULT_SETTINGS };
    if (isRecord(response.parsed_json)) {
      for (const field of SETTING_FIELDS) {
        const value = response.parsed_json[field.path];
        if (value !== undefined && value !== null) {
          nextSettings[field.path] = toText(value);
        }
      }
    } else {
      for (const line of response.stdout.split(/\r?\n/)) {
        const index = line.indexOf("=");
        if (index <= 0) {
          continue;
        }
        const key = line.slice(0, index).trim() as SettingPath;
        if (Object.prototype.hasOwnProperty.call(nextSettings, key)) {
          nextSettings[key] = line.slice(index + 1).trim();
        }
      }
    }

    setSettings(nextSettings);
    return response;
  }

  async function refreshAll() {
    setBusyAction("boot");
    setNotice({ kind: "info", text: t.noticeRefreshing });

    try {
      const detect = await refreshOverview();
      await refreshConfigAndProviders(detect.installed);
      await refreshGateway(detect.installed);
      await refreshSettings(detect.installed);
      markUpdated();

      if (!detect.installed) {
        setNotice({ kind: "info", text: t.noticeNeedInstall });
      } else {
        setNotice({ kind: "success", text: t.noticeRefreshed });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    if (!languageConfirmed) {
      return;
    }
    void refreshAll();
  }, [languageConfirmed]);

  async function runAction(
    actionKey: string,
    runningText: string,
    task: () => Promise<CommandResponse>,
    afterSuccess?: () => Promise<void>,
  ) {
    setBusyAction(actionKey);
    setNotice({ kind: "info", text: runningText });
    try {
      const response = await task();
      recordResponse(runningText, response);

      if (!response.success) {
        setNotice({ kind: "error", text: response.message || t.commandFailed });
        return;
      }

      if (afterSuccess) {
        await afterSuccess();
      }

      markUpdated();
      setNotice({ kind: "success", text: response.message || t.noticeRefreshed });
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  function handleInstall() {
    void runAction("install", t.actionInstall, installOpenclaw, async () => {
      await refreshAll();
    });
  }

  function handleGatewayAction(action: GatewayAction) {
    const runningText =
      action === "start" ? t.actionStartGateway : action === "stop" ? t.actionStop : t.actionRestart;

    void runAction(`gateway-${action}`, runningText, () => gatewayControl(action), async () => {
      await refreshGateway(true);
      await refreshConfigAndProviders(true);
    });
  }

  function handleRunOnboard() {
    void runAction("run-onboard", t.actionRunOnboard, runOpenclawOnboard, async () => {
      await refreshAll();
    });
  }

  function handleRefreshStatus() {
    void runAction("refresh-status", t.actionRefreshStatus, gatewayStatus, async () => {
      await refreshGateway(true);
    });
  }

  function handleOpenDashboard() {
    void runAction("dashboard", t.actionOpenDashboard, openDashboard);
  }

  function validateProviderForm(): string | null {
    if (!providerForm.providerName.trim()) {
      return `${t.providerName} ${t.stepPending}`;
    }
    if (!providerForm.baseUrl.trim()) {
      return `${t.providerBaseUrl} ${t.stepPending}`;
    }
    if (!providerForm.apiKey.trim()) {
      return `${t.providerApiKey} ${t.stepPending}`;
    }
    if (!providerForm.api.trim()) {
      return `${t.providerApiProtocol} ${t.stepPending}`;
    }
    if (!providerForm.defaultModel.trim()) {
      return `${t.providerDefaultModel} ${t.stepPending}`;
    }
    return null;
  }

  function handleSaveProvider() {
    if (!overview.installed) {
      setNotice({ kind: "error", text: t.noticeNeedInstall });
      return;
    }

    const validationMessage = validateProviderForm();
    if (validationMessage) {
      setNotice({ kind: "error", text: validationMessage });
      return;
    }

    void runAction(
      "save-provider",
      t.actionSaveProvider,
      () =>
        writeOpenclawProvider({
          providerName: providerForm.providerName.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          apiKey: providerForm.apiKey.trim(),
          api: providerForm.api.trim(),
          defaultModel: providerForm.defaultModel.trim(),
        }),
      async () => {
        await refreshConfigAndProviders(true);
      },
    );
  }

  function handleSaveTelegram() {
    if (!overview.installed) {
      setNotice({ kind: "error", text: t.noticeNeedInstall });
      return;
    }

    if (!telegramForm.botToken.trim()) {
      setNotice({ kind: "error", text: `${t.channelBotToken} ${t.stepPending}` });
      return;
    }

    void runAction(
      "save-channel-telegram",
      t.actionSaveTelegram,
      () =>
        writeOpenclawChannel({
          channel: "telegram",
          botToken: telegramForm.botToken.trim(),
        }),
      async () => {
        await refreshConfigAndProviders(true);
      },
    );
  }

  function handleSaveFeishu() {
    if (!overview.installed) {
      setNotice({ kind: "error", text: t.noticeNeedInstall });
      return;
    }

    if (!feishuForm.appId.trim() || !feishuForm.appSecret.trim()) {
      setNotice({ kind: "error", text: `${t.channelAppId}/${t.channelAppSecret} ${t.stepPending}` });
      return;
    }

    void runAction(
      "save-channel-feishu",
      t.actionSaveFeishu,
      () =>
        writeOpenclawChannel({
          channel: "feishu",
          appId: feishuForm.appId.trim(),
          appSecret: feishuForm.appSecret.trim(),
        }),
      async () => {
        await refreshConfigAndProviders(true);
      },
    );
  }

  function handleSettingChange(path: SettingPath, value: string) {
    setSettings((current) => ({ ...current, [path]: value } as CommonSettings));
  }

  function handleSaveOne(path: SettingPath) {
    void runAction(
      `save-${path}`,
      `${t.settingsSaveOne} ${path}`,
      () => setCommonSetting(path, settings[path]),
      async () => {
        await refreshSettings(true);
      },
    );
  }

  async function handleSaveAll() {
    setBusyAction("save-all");
    setNotice({ kind: "info", text: t.settingsSavingAll });

    try {
      const failures: string[] = [];
      for (const field of SETTING_FIELDS) {
        const response = await setCommonSetting(field.path, settings[field.path]);
        recordResponse(`${t.settingsSaveAll} ${field.path}`, response);
        if (!response.success) {
          failures.push(field.path);
        }
      }

      await refreshSettings(true);
      markUpdated();
      if (failures.length > 0) {
        setNotice({ kind: "error", text: `${t.savePartialFail}: ${failures.join(", ")}` });
      } else {
        setNotice({ kind: "success", text: t.saveAllSuccess });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  function runHomeAction(action: HomeAction) {
    if (action === "install") {
      handleInstall();
      return;
    }
    if (action === "run-onboard") {
      handleRunOnboard();
      return;
    }
    if (action === "save-provider") {
      handleSaveProvider();
      return;
    }
    if (action === "start") {
      handleGatewayAction("start");
      return;
    }
    if (action === "stop") {
      handleGatewayAction("stop");
      return;
    }
    if (action === "restart") {
      handleGatewayAction("restart");
      return;
    }
    if (action === "refresh-status") {
      handleRefreshStatus();
      return;
    }
    if (action === "open-dashboard") {
      handleOpenDashboard();
      return;
    }
    void refreshAll();
  }

  function renderLanguageSelection() {
    return (
      <div className="app-shell">
        <main className="language-screen">
          <section className="panel language-card">
            <h1>{t.languageTitle}</h1>
            <p>{t.languageDescription}</p>
            <div className="language-options">
              <label className="language-option">
                <input
                  type="radio"
                  value="zh-CN"
                  checked={locale === "zh-CN"}
                  onChange={() => {
                    setLocale("zh-CN");
                  }}
                />
                <span>{I18N["zh-CN"].languageChinese}</span>
              </label>
              <label className="language-option">
                <input
                  type="radio"
                  value="en-US"
                  checked={locale === "en-US"}
                  onChange={() => {
                    setLocale("en-US");
                  }}
                />
                <span>{I18N["en-US"].languageEnglish}</span>
              </label>
            </div>
            <button
              className="btn btn-primary language-confirm"
              onClick={() => {
                persistLocale(locale);
                setLanguageConfirmed(true);
              }}
            >
              {t.languageConfirm}
            </button>
          </section>
        </main>
      </div>
    );
  }

  function renderOnboarding() {
    const setupConfigDisabled = Boolean(busyAction) || !overview.installed;

    return (
      <main className="grid-layout onboarding-layout">
        <section className="panel panel-overview">
          <h2>{t.onboardingTitle}</h2>
          <p className="lead">{t.onboardingDescription}</p>
          <div className="progress-head">
            <span>
              {t.onboardingProgress}: {completedRequiredCount}/{REQUIRED_CHECK_ORDER.length}
            </span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>

          <label className="field-label">{t.noticeCurrentStatus}</label>
          <p className="status-summary">
            {homeStatusLabel}: {homeStatusDescription}
          </p>

          <label className="field-label">{t.setupChecksTitle}</label>
          <div className="status-grid setup-check-grid">
            {REQUIRED_CHECK_ORDER.map((key) => (
              <div key={key} className={`status-item status-${setupChecks[key] ? "done" : "todo"}`}>
                <span>{checkLabels[key]}</span>
                <strong>{setupChecks[key] ? t.setupCheckDone : t.setupCheckPending}</strong>
              </div>
            ))}
          </div>

          <label className="field-label">{t.onboardingMissing}</label>
          {missingRequired.length === 0 ? (
            <p className="status-summary">{t.onboardingAllDone}</p>
          ) : (
            <div className="missing-list">
              {missingRequired.map((key) => (
                <span key={key} className="state-pill state-installed-not-started">
                  {checkLabels[key]}
                </span>
              ))}
            </div>
          )}

          <div className="step-list">
            {onboardingSteps.map((step) => (
              <div key={step.id} className={`step-item step-${step.state}`}>
                <div className="step-head">
                  <strong>{step.title}</strong>
                  <span>
                    {step.state === "done"
                      ? t.stepDone
                      : step.state === "active"
                        ? t.stepActive
                        : t.stepPending}
                  </span>
                </div>
                <p>{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel panel-actions">
          <h2>{t.actionsTitle}</h2>
          <div className="home-actions onboarding-actions">
            <div className="home-action-main">
              <label className="field-label">{t.actionPrimary}</label>
              <button
                className="btn btn-primary btn-main"
                onClick={() => {
                  runHomeAction(recommendedPrimaryAction);
                }}
                disabled={isHomeActionDisabled(recommendedPrimaryAction)}
              >
                {homeActionText(recommendedPrimaryAction)}
              </button>
              <small className="field-help">{recommendedPrimaryText}</small>
            </div>
            <div className="home-action-secondary">
              <label className="field-label">{t.actionSecondary}</label>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  runHomeAction("refresh-all");
                }}
                disabled={isHomeActionDisabled("refresh-all")}
              >
                {homeActionText("refresh-all")}
              </button>
            </div>
          </div>

          <div className="minor-actions">
            <span>{t.homeQuickActionsTitle}</span>
            <div className="minor-actions-grid">
              <button
                className="btn btn-ghost btn-minor"
                onClick={() => {
                  runHomeAction("install");
                }}
                disabled={isHomeActionDisabled("install")}
              >
                {homeActionText("install")}
              </button>
              <button
                className="btn btn-ghost btn-minor"
                onClick={() => {
                  runHomeAction("run-onboard");
                }}
                disabled={isHomeActionDisabled("run-onboard")}
              >
                {homeActionText("run-onboard")}
              </button>
              <button
                className="btn btn-ghost btn-minor"
                onClick={() => {
                  runHomeAction("start");
                }}
                disabled={isHomeActionDisabled("start")}
              >
                {homeActionText("start")}
              </button>
              <button
                className="btn btn-ghost btn-minor"
                onClick={() => {
                  runHomeAction("refresh-status");
                }}
                disabled={isHomeActionDisabled("refresh-status")}
              >
                {homeActionText("refresh-status")}
              </button>
            </div>
          </div>

          <div className="kv-grid setup-overview-grid">
            <div className="kv-row">
              <span>{t.overviewInstallStatus}</span>
              <strong>{setupChecks.cliInstalled ? t.overviewInstalled : t.overviewNotInstalled}</strong>
            </div>
            <div className="kv-row">
              <span>{t.setupCheckConfig}</span>
              <strong>{setupChecks.configExists ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.providerConfiguredCount}</span>
              <strong>{providerCount}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewGatewayStatus}</span>
              <strong>{setupChecks.gatewayListening ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewRpcStatus}</span>
              <strong>{setupChecks.rpcConnected ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
          </div>
        </section>

        <section className="panel panel-status setup-provider-card">
          <h2>{t.setupProviderTitle}</h2>
          <p className="home-subtitle">{t.setupProviderHint}</p>
          <div className="form-grid">
            <label className="input-block" htmlFor="provider-name">
              <span className="field-label">{t.providerName}</span>
              <input
                id="provider-name"
                type="text"
                value={providerForm.providerName}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, providerName: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
            <label className="input-block" htmlFor="provider-base-url">
              <span className="field-label">{t.providerBaseUrl}</span>
              <input
                id="provider-base-url"
                type="text"
                value={providerForm.baseUrl}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, baseUrl: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
            <label className="input-block" htmlFor="provider-api-key">
              <span className="field-label">{t.providerApiKey}</span>
              <input
                id="provider-api-key"
                type="password"
                value={providerForm.apiKey}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, apiKey: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
            <label className="input-block" htmlFor="provider-api">
              <span className="field-label">{t.providerApiProtocol}</span>
              <input
                id="provider-api"
                type="text"
                value={providerForm.api}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, api: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
            <label className="input-block" htmlFor="provider-default-model">
              <span className="field-label">{t.providerDefaultModel}</span>
              <input
                id="provider-default-model"
                type="text"
                value={providerForm.defaultModel}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, defaultModel: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleSaveProvider}
            disabled={setupConfigDisabled}
          >
            {isBusy("save-provider") ? t.actionSavingProvider : t.actionSaveProvider}
          </button>
        </section>

        <section className="panel panel-status setup-channel-card">
          <h2>{t.setupChannelTitle}</h2>
          <p className="home-subtitle">{t.setupChannelHint}</p>

          <div className="channel-tabs" role="tablist" aria-label="channel-tabs">
            <button
              className={`btn btn-ghost ${channelTab === "telegram" ? "tab-active" : ""}`}
              onClick={() => {
                setChannelTab("telegram");
              }}
              disabled={setupConfigDisabled}
            >
              {t.channelTelegram}
            </button>
            <button
              className={`btn btn-ghost ${channelTab === "feishu" ? "tab-active" : ""}`}
              onClick={() => {
                setChannelTab("feishu");
              }}
              disabled={setupConfigDisabled}
            >
              {t.channelFeishu}
            </button>
          </div>

          {channelTab === "telegram" ? (
            <div className="channel-pane">
              <div className="channel-badge-row">
                <span className="field-help">{t.channelTelegram}</span>
                <span className={`state-pill ${channels.telegramConfigured ? "state-console-ready" : "state-installed-not-started"}`}>
                  {channels.telegramConfigured ? t.channelConfigured : t.channelNotConfigured}
                </span>
              </div>
              <label className="input-block" htmlFor="telegram-token">
                <span className="field-label">{t.channelBotToken}</span>
                <input
                  id="telegram-token"
                  type="password"
                  value={telegramForm.botToken}
                  onChange={(event) => {
                    setTelegramForm({ botToken: event.target.value });
                  }}
                  disabled={setupConfigDisabled}
                />
              </label>
              <button
                className="btn btn-primary"
                onClick={handleSaveTelegram}
                disabled={setupConfigDisabled}
              >
                {isBusy("save-channel-telegram") ? t.actionSavingChannel : t.actionSaveTelegram}
              </button>
            </div>
          ) : (
            <div className="channel-pane">
              <div className="channel-badge-row">
                <span className="field-help">{t.channelFeishu}</span>
                <span className={`state-pill ${channels.feishuConfigured ? "state-console-ready" : "state-installed-not-started"}`}>
                  {channels.feishuConfigured ? t.channelConfigured : t.channelNotConfigured}
                </span>
              </div>
              <label className="input-block" htmlFor="feishu-app-id">
                <span className="field-label">{t.channelAppId}</span>
                <input
                  id="feishu-app-id"
                  type="text"
                  value={feishuForm.appId}
                  onChange={(event) => {
                    setFeishuForm((current) => ({ ...current, appId: event.target.value }));
                  }}
                  disabled={setupConfigDisabled}
                />
              </label>
              <label className="input-block" htmlFor="feishu-app-secret">
                <span className="field-label">{t.channelAppSecret}</span>
                <input
                  id="feishu-app-secret"
                  type="password"
                  value={feishuForm.appSecret}
                  onChange={(event) => {
                    setFeishuForm((current) => ({ ...current, appSecret: event.target.value }));
                  }}
                  disabled={setupConfigDisabled}
                />
              </label>
              <button
                className="btn btn-primary"
                onClick={handleSaveFeishu}
                disabled={setupConfigDisabled}
              >
                {isBusy("save-channel-feishu") ? t.actionSavingChannel : t.actionSaveFeishu}
              </button>
            </div>
          )}

          <div className="qq-placeholder">
            <div className="channel-badge-row">
              <strong>{t.channelQq}</strong>
              <span className="state-pill state-starting">{t.setupCheckOptional}</span>
            </div>
            <p>{t.qqPlaceholderText}</p>
            <a
              href="https://q.qq.com/qqbot/openclaw/login.html"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary qq-link"
            >
              {t.qqPlaceholderLink}
            </a>
          </div>
        </section>

        <section className="panel panel-output">
          <h2>{t.outputTitle}</h2>
          <pre className="raw">{lastCommandOutput || t.outputEmpty}</pre>
          <label className="field-label">{t.outputHistoryTitle}</label>
          <pre className="raw history">{commandHistory.join("\n") || t.outputEmpty}</pre>
        </section>
      </main>
    );
  }

  function renderDashboard() {
    const homeActionPlan = {
      primary: "open-dashboard" as HomeAction,
      secondary: "refresh-status" as HomeAction,
      minor: ["start", "restart", "stop", "refresh-all", "run-onboard"] as HomeAction[],
    };

    return (
      <main className="home-layout">
        <section className={`panel home-panel status-${homeStatus}`}>
          <div className="home-head">
            <h2>{t.homeTitle}</h2>
            <span className={`state-pill state-${homeStatus}`}>{homeStatusLabel}</span>
          </div>
          <p className="home-subtitle">{t.homeSubtitle}</p>

          <div className="home-core">
            <div className="home-row">
              <span>{t.homeStatusTitle}</span>
              <strong>{isReady ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="home-row">
              <span>{t.homeServiceTitle}</span>
              <strong>{gatewayInsight.summary || homeStatusLabel}</strong>
            </div>
            <div className="home-row home-row-wrap">
              <span>{t.homeNextStepTitle}</span>
              <strong>{nextSuggestion}</strong>
            </div>
          </div>

          <p className="status-summary">{homeStatusDescription}</p>

          <div className="home-actions">
            <div className="home-action-main">
              <label className="field-label">{t.actionPrimary}</label>
              <button
                className="btn btn-primary btn-main"
                onClick={() => {
                  runHomeAction(homeActionPlan.primary);
                }}
                disabled={isHomeActionDisabled(homeActionPlan.primary)}
              >
                {homeActionText(homeActionPlan.primary)}
              </button>
            </div>

            <div className="home-action-secondary">
              <label className="field-label">{t.actionSecondary}</label>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  runHomeAction(homeActionPlan.secondary);
                }}
                disabled={isHomeActionDisabled(homeActionPlan.secondary)}
              >
                {homeActionText(homeActionPlan.secondary)}
              </button>
            </div>
          </div>

          <div className="minor-actions">
            <span>{t.homeQuickActionsTitle}</span>
            <div className="minor-actions-grid">
              {homeActionPlan.minor.map((action) => (
                <button
                  key={action}
                  className="btn btn-ghost btn-minor"
                  onClick={() => {
                    runHomeAction(action);
                  }}
                  disabled={isHomeActionDisabled(action)}
                >
                  {homeActionText(action)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel panel-overview">
          <h2>{t.overviewTitle}</h2>
          <div className="kv-grid">
            <div className="kv-row">
              <span>{t.overviewInstallStatus}</span>
              <strong>{setupChecks.cliInstalled ? t.overviewInstalled : t.overviewNotInstalled}</strong>
            </div>
            <div className="kv-row">
              <span>{t.setupCheckConfig}</span>
              <strong>{setupChecks.configExists ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.setupCheckProvider}</span>
              <strong>{setupChecks.providerConfigured ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.setupCheckDaemon}</span>
              <strong>{setupChecks.daemonInstalled ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewGatewayStatus}</span>
              <strong>{setupChecks.gatewayListening ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewRpcStatus}</span>
              <strong>{setupChecks.rpcConnected ? t.overviewReady : t.overviewNotReady}</strong>
            </div>
            <div className="kv-row">
              <span>{t.providerConfiguredCount}</span>
              <strong>{providerCount}</strong>
            </div>
            <div className="kv-row">
              <span>{t.channelTelegram}</span>
              <strong>{channels.telegramConfigured ? t.channelConfigured : t.channelNotConfigured}</strong>
            </div>
            <div className="kv-row">
              <span>{t.channelFeishu}</span>
              <strong>{channels.feishuConfigured ? t.channelConfigured : t.channelNotConfigured}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewVersion}</span>
              <strong>{overview.version}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewPath}</span>
              <strong>{overview.path}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewConfigFile}</span>
              <strong>{overview.configFile}</strong>
            </div>
          </div>
        </section>

        <details className="panel fold-panel">
          <summary>{t.homeAdvancedDiagnostics}</summary>
          <p className="fold-hint">{t.homeAdvancedDiagnosticsHint}</p>

          <label className="field-label">{t.diagnosticsStructuredStatus}</label>
          <pre className="raw">
            {gatewayEntries.length > 0 ? JSON.stringify(gatewayParsed, null, 2) : t.diagnosticsNone}
          </pre>

          <label className="field-label">{t.diagnosticsRawGateway}</label>
          <pre className="raw">{gatewayRaw || t.outputEmpty}</pre>

          <label className="field-label">{t.diagnosticsLastCommand}</label>
          <pre className="raw">{lastCommandOutput || t.outputEmpty}</pre>

          <label className="field-label">{t.diagnosticsHistory}</label>
          <pre className="raw history">{commandHistory.join("\n") || t.outputEmpty}</pre>
        </details>

        <details className="panel fold-panel">
          <summary>{t.homeAdvancedSettings}</summary>
          <p className="fold-hint">{t.homeAdvancedSettingsHint}</p>
          <div className="settings-title">
            <h2>{t.settingsTitle}</h2>
            <div className="settings-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  void runAction("reload-settings", t.settingsReload, getCommonSettings, async () => {
                    await refreshSettings(true);
                  });
                }}
                disabled={Boolean(busyAction)}
              >
                {isBusy("reload-settings") ? t.settingsReloading : t.settingsReload}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void handleSaveAll();
                }}
                disabled={Boolean(busyAction)}
              >
                {isBusy("save-all") ? t.settingsSavingAll : t.settingsSaveAll}
              </button>
            </div>
          </div>

          <div className="settings-grid">
            {SETTING_FIELDS.map((field) => (
              <div key={field.path} className="setting-card">
                <label className="field-label" htmlFor={field.path}>
                  {field.label}
                </label>
                <small className="field-help">{field.description[locale]}</small>
                {field.control === "boolean" ? (
                  <select
                    id={field.path}
                    value={normalizeBoolean(settings[field.path])}
                    onChange={(event) => {
                      handleSettingChange(field.path, event.target.value);
                    }}
                    disabled={Boolean(busyAction)}
                  >
                    <option value="true">{t.fieldBooleanTrue}</option>
                    <option value="false">{t.fieldBooleanFalse}</option>
                  </select>
                ) : (
                  <input
                    id={field.path}
                    type="text"
                    value={settings[field.path]}
                    placeholder={field.placeholder}
                    onChange={(event) => {
                      handleSettingChange(field.path, event.target.value);
                    }}
                    disabled={Boolean(busyAction)}
                  />
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    handleSaveOne(field.path);
                  }}
                  disabled={Boolean(busyAction)}
                >
                  {isBusy(`save-${field.path}`) ? t.settingsSavingOne : t.settingsSaveOne}
                </button>
              </div>
            ))}
          </div>
        </details>
      </main>
    );
  }

  const badgeClass = notice ? `notice notice-${notice.kind}` : "notice notice-info";

  if (appView === "language-select") {
    return renderLanguageSelection();
  }

  return (
    <div className="app-shell">
      <header className="header">
        <div>
          <h1>{t.appTitle}</h1>
          <p>{appView === "dashboard" ? t.homeSubtitle : t.appSubtitle}</p>
        </div>
        <div className="header-meta">
          <label className="lang-switch" htmlFor="locale-switch">
            <span>{t.language}</span>
            <select
              id="locale-switch"
              value={locale}
              onChange={(event) => {
                persistLocale(event.target.value as Locale);
              }}
              disabled={Boolean(busyAction)}
            >
              <option value="zh-CN">{I18N["zh-CN"].languageChinese}</option>
              <option value="en-US">{I18N["en-US"].languageEnglish}</option>
            </select>
          </label>
          <span className="stamp">
            {t.lastUpdated}: {lastUpdated}
          </span>
          {busyAction ? (
            <span className="stamp">
              {t.running}: {busyAction}
            </span>
          ) : null}
        </div>
      </header>

      <div className={badgeClass}>{notice ? notice.text : t.noticeReady}</div>

      {appView === "onboarding" ? renderOnboarding() : renderDashboard()}
    </div>
  );
}
