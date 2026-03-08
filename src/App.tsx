import { useEffect, useMemo, useState } from "react";
import {
  detectOpenclaw,
  gatewayControl,
  gatewayStatus,
  getCommonSettings,
  getConfigFile,
  installOpenclaw,
  openDashboard,
  setCommonSetting,
} from "./lib/tauri";
import type {
  CommandResponse,
  CommonSettings,
  GatewayAction,
  SettingPath,
} from "./types";

type NoticeKind = "success" | "error" | "info";
type Locale = "zh-CN" | "en-US";
type AppView = "language-select" | "onboarding" | "dashboard";
type OnboardingStepState = "done" | "active" | "pending";
type HomeStatus =
  | "not-installed"
  | "installed-not-started"
  | "starting"
  | "service-error"
  | "console-ready";
type HomeAction =
  | "install"
  | "start"
  | "stop"
  | "restart"
  | "refresh-status"
  | "refresh-all"
  | "open-dashboard";
type DashboardIssueKind =
  | "gateway-not-ready"
  | "dashboard-command-failed"
  | "url-missing"
  | "open-url-failed"
  | "unknown";

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

interface DashboardAttempt {
  response: CommandResponse;
  at: string;
}

interface GatewayInsight {
  running: boolean | null;
  healthy: boolean | null;
  stoppedHint: boolean;
  hasError: boolean;
  summary: string;
}

interface DashboardIssue {
  kind: DashboardIssueKind;
  detail: string;
}

const LOCALE_STORAGE_KEY = "clawset.locale";
const INSTALL_STABILIZE_POLL_ATTEMPTS = 8;
const INSTALL_STABILIZE_POLL_INTERVAL_MS = 1200;
const INSTALL_STABLE_SUCCESS_TARGET = 2;

const DEFAULT_SETTINGS: CommonSettings = {
  "update.channel": "",
  "update.checkOnStart": "false",
  "acp.enabled": "false",
  "acp.defaultAgent": "",
  "agents.defaults.thinkingDefault": "",
  "agents.defaults.heartbeat.every": "",
};

const I18N = {
  "zh-CN": {
    appTitle: "Clawset Desktop",
    appSubtitle: "OpenClaw 引导与控制台",
    noticeReady: "就绪",
    noticeRefreshing: "正在刷新状态...",
    noticeRefreshed: "状态已刷新",
    noticeNeedInstall: "未检测到 OpenClaw，请先完成安装",
    noticeNeedGateway: "OpenClaw 已安装，但基础状态暂不可用",
    noticeInstallPendingRefresh: "安装命令已完成，正在等待状态稳定...",
    noticeInstallDetectTimeout: "安装命令已完成，但状态尚未稳定。请稍后点击“重新检测”。",
    noticeCurrentStatus: "当前状态",
    lastUpdated: "最后刷新",
    running: "执行中",
    language: "语言",
    languageTitle: "选择语言",
    languageDescription: "首次使用请选择界面语言。默认简体中文，后续可随时切换。",
    languageConfirm: "继续",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "首次使用引导",
    onboardingDescription:
      "检测到环境尚未就绪。请按步骤完成检测、安装、启动与验证。",
    onboardingProgress: "引导进度",
    stepDetectTitle: "检测 OpenClaw",
    stepDetectDescription: "检查命令、版本、路径与配置文件位置。",
    stepInstallTitle: "安装 OpenClaw",
    stepInstallDescription: "未安装时执行安装脚本并记录输出日志。",
    stepStartTitle: "启动 Gateway",
    stepStartDescription: "调用 Gateway 启动命令并等待服务进入可用状态。",
    stepVerifyTitle: "验证基础状态",
    stepVerifyDescription: "检查 Gateway 状态输出，确认可进入控制面板。",
    stepDone: "已完成",
    stepActive: "进行中",
    stepPending: "待处理",
    statusNeedInstall: "未检测到 OpenClaw，请点击“安装 OpenClaw”。",
    statusNeedGateway: "OpenClaw 已安装，正在等待 Gateway 基础状态可用。",
    statusReady: "OpenClaw 与基础状态均可用，可以进入控制面板。",
    actionRedetect: "重新检测",
    actionInstall: "安装 OpenClaw",
    actionInstalling: "安装中...",
    actionStartGateway: "启动 Gateway",
    actionStartingGateway: "启动中...",
    actionRefreshStatus: "刷新基础状态",
    actionRefreshingStatus: "刷新中...",
    overviewTitle: "环境概览",
    overviewInstallStatus: "OpenClaw 安装状态",
    overviewGatewayBaseStatus: "Gateway 基础状态",
    overviewGatewayReady: "可用",
    overviewGatewayNotReady: "不可用",
    overviewInstalled: "已安装",
    overviewNotInstalled: "未安装",
    overviewVersion: "版本",
    overviewPath: "路径",
    overviewConfigFile: "配置文件",
    outputTitle: "最新命令输出",
    outputHistoryTitle: "执行记录",
    outputEmpty: "(空)",
    dashboardTitle: "控制面板",
    homeTitle: "首页",
    homeSubtitle: "面向普通用户的 OpenClaw 控制中心",
    homeStatusTitle: "当前环境状态",
    homeServiceTitle: "服务状态",
    homeNextStepTitle: "下一步建议",
    homeQuickActionsTitle: "其他操作",
    homeAdvancedDiagnostics: "高级诊断",
    homeAdvancedDiagnosticsHint: "包含原始 JSON 与底层输出，默认折叠。",
    homeAdvancedSettings: "高级设置",
    homeAdvancedSettingsHint: "仅在需要时修改常用配置。",
    statusHumanNotInstalled: "未安装",
    statusHumanInstalledNotStarted: "已安装未启动",
    statusHumanStarting: "启动中",
    statusHumanServiceError: "服务异常",
    statusHumanReady: "可以进入控制台",
    statusExplainNotInstalled: "当前设备未检测到 OpenClaw，安装后才能启动服务。",
    statusExplainInstalledNotStarted: "OpenClaw 已安装，但服务尚未在运行。",
    statusExplainStarting: "正在等待服务完成启动和状态同步。",
    statusExplainServiceError: "服务状态异常，建议先重启服务并刷新状态。",
    statusExplainReady: "服务已可用，可以打开控制台继续操作。",
    nextInstall: "先安装 OpenClaw。安装完成后会自动再次检测。",
    nextStart: "先启动服务，然后再进入控制台。",
    nextStarting: "等待几秒后刷新状态，确认服务是否已就绪。",
    nextRecover: "先重启服务；如果仍异常，请查看高级诊断。",
    nextOpenDashboard: "打开 Dashboard 开始使用。",
    dashboardIssueTitle: "Dashboard 打不开怎么办？",
    dashboardIssueGatewayNotReady: "服务还没准备好，暂时无法打开 Dashboard。",
    dashboardIssueCommandFailed: "获取 Dashboard 地址失败。",
    dashboardIssueUrlMissing: "命令执行成功，但没有返回可打开的地址。",
    dashboardIssueOpenFailed: "已拿到地址，但系统没有成功打开浏览器。",
    dashboardIssueUnknown: "打开 Dashboard 时发生未知问题。",
    dashboardIssueSuggestionA: "建议：先点击“刷新基础状态”，确认服务可用。",
    dashboardIssueSuggestionB: "建议：再试一次“打开 Dashboard”；若仍失败，请查看高级诊断。",
    dashboardIssueSuggestionC: "建议：复制下方地址到浏览器手动打开。",
    dashboardIssueSuggestionD: "建议：重启服务后再重试。",
    dashboardIssueLastAttempt: "最近尝试",
    dashboardUrlLabel: "Dashboard 地址",
    diagnosticsStructuredStatus: "结构化状态",
    diagnosticsRawGateway: "Gateway 原始输出",
    diagnosticsLastCommand: "最近命令输出",
    diagnosticsHistory: "执行历史",
    diagnosticsNone: "暂无结构化状态，已保留原始输出。",
    actionPrimary: "主要操作",
    actionSecondary: "次要操作",
    actionsTitle: "操作",
    gatewayStatusTitle: "Gateway 状态",
    rawOutput: "原始输出",
    rawParseFallback: "无法解析 JSON，已展示原始输出。",
    settingsTitle: "Settings",
    settingsReload: "刷新配置",
    settingsReloading: "刷新中...",
    settingsSaveAll: "保存全部",
    settingsSavingAll: "保存中...",
    settingsSaveOne: "保存",
    settingsSavingOne: "保存中...",
    fieldBooleanTrue: "true",
    fieldBooleanFalse: "false",
    actionOpenDashboard: "打开 Dashboard",
    actionOpeningDashboard: "打开中...",
    actionStart: "启动",
    actionStarting: "启动中...",
    actionStop: "停止",
    actionStopping: "停止中...",
    actionRestart: "重启",
    actionRestarting: "重启中...",
    actionRefreshAll: "刷新全部",
    actionRefreshingAll: "刷新中...",
    savePartialFail: "部分设置保存失败",
    saveAllSuccess: "全部设置已保存",
    commandFailed: "命令执行失败",
    logDetect: "检测 OpenClaw",
    logConfig: "读取配置文件路径",
    logGatewayStatus: "读取 Gateway 状态",
    logSettings: "读取常用配置",
  },
  "en-US": {
    appTitle: "Clawset Desktop",
    appSubtitle: "OpenClaw onboarding and control panel",
    noticeReady: "Ready",
    noticeRefreshing: "Refreshing status...",
    noticeRefreshed: "Status refreshed",
    noticeNeedInstall: "OpenClaw was not detected. Install it first.",
    noticeNeedGateway: "OpenClaw is installed, but base status is not ready yet.",
    noticeInstallPendingRefresh: "Install command finished. Waiting for status to stabilize...",
    noticeInstallDetectTimeout:
      "Install command finished, but status is not stable yet. Try Re-detect shortly.",
    noticeCurrentStatus: "Current status",
    lastUpdated: "Last Updated",
    running: "Running",
    language: "Language",
    languageTitle: "Choose Language",
    languageDescription:
      "Choose your UI language on first launch. You can change it later.",
    languageConfirm: "Continue",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "First-Use Onboarding",
    onboardingDescription:
      "The environment is not ready. Complete detection, install, start, and verification steps.",
    onboardingProgress: "Progress",
    stepDetectTitle: "Detect OpenClaw",
    stepDetectDescription: "Check command availability, version, path, and config file.",
    stepInstallTitle: "Install OpenClaw",
    stepInstallDescription: "Run install script when OpenClaw is missing and keep output logs.",
    stepStartTitle: "Start Gateway",
    stepStartDescription: "Start gateway and wait for base status to become ready.",
    stepVerifyTitle: "Verify Base Status",
    stepVerifyDescription: "Check gateway status output before entering dashboard.",
    stepDone: "Done",
    stepActive: "Active",
    stepPending: "Pending",
    statusNeedInstall: "OpenClaw is not installed. Click Install OpenClaw.",
    statusNeedGateway: "OpenClaw is installed, waiting for gateway base status.",
    statusReady: "OpenClaw and base status are ready. Dashboard is available.",
    actionRedetect: "Re-detect",
    actionInstall: "Install OpenClaw",
    actionInstalling: "Installing...",
    actionStartGateway: "Start Gateway",
    actionStartingGateway: "Starting...",
    actionRefreshStatus: "Refresh Base Status",
    actionRefreshingStatus: "Refreshing...",
    overviewTitle: "Environment Overview",
    overviewInstallStatus: "OpenClaw Install",
    overviewGatewayBaseStatus: "Gateway Base Status",
    overviewGatewayReady: "Ready",
    overviewGatewayNotReady: "Not Ready",
    overviewInstalled: "Installed",
    overviewNotInstalled: "Not Installed",
    overviewVersion: "Version",
    overviewPath: "Path",
    overviewConfigFile: "Config File",
    outputTitle: "Latest Command Output",
    outputHistoryTitle: "Execution History",
    outputEmpty: "(empty)",
    dashboardTitle: "Dashboard",
    homeTitle: "Home",
    homeSubtitle: "OpenClaw control center for regular users",
    homeStatusTitle: "Environment Status",
    homeServiceTitle: "Service Status",
    homeNextStepTitle: "Recommended Next Step",
    homeQuickActionsTitle: "Other Actions",
    homeAdvancedDiagnostics: "Advanced Diagnostics",
    homeAdvancedDiagnosticsHint: "Contains raw JSON and low-level outputs. Collapsed by default.",
    homeAdvancedSettings: "Advanced Settings",
    homeAdvancedSettingsHint: "Edit common settings only when needed.",
    statusHumanNotInstalled: "Not installed",
    statusHumanInstalledNotStarted: "Installed, not started",
    statusHumanStarting: "Starting",
    statusHumanServiceError: "Service error",
    statusHumanReady: "Console ready",
    statusExplainNotInstalled: "OpenClaw is not detected on this device yet.",
    statusExplainInstalledNotStarted: "OpenClaw is installed, but the service is not running.",
    statusExplainStarting: "Waiting for service startup and status synchronization.",
    statusExplainServiceError: "Service status is abnormal. Restart and refresh status first.",
    statusExplainReady: "Service is available. You can open the dashboard now.",
    nextInstall: "Install OpenClaw first. Status will be checked again automatically.",
    nextStart: "Start the service first, then enter the dashboard.",
    nextStarting: "Wait a few seconds and refresh status to confirm readiness.",
    nextRecover: "Restart service first. If it still fails, check Advanced Diagnostics.",
    nextOpenDashboard: "Open Dashboard to continue.",
    dashboardIssueTitle: "Dashboard cannot open?",
    dashboardIssueGatewayNotReady: "Service is not ready yet, so Dashboard is unavailable.",
    dashboardIssueCommandFailed: "Failed to fetch Dashboard URL.",
    dashboardIssueUrlMissing: "Command succeeded but no openable URL was returned.",
    dashboardIssueOpenFailed: "URL was found, but the system could not open the browser.",
    dashboardIssueUnknown: "An unknown issue occurred while opening Dashboard.",
    dashboardIssueSuggestionA: "Try Refresh Base Status first to confirm service availability.",
    dashboardIssueSuggestionB:
      "Try Open Dashboard again. If it still fails, check Advanced Diagnostics.",
    dashboardIssueSuggestionC: "Copy the URL below and open it manually in your browser.",
    dashboardIssueSuggestionD: "Restart service and try again.",
    dashboardIssueLastAttempt: "Last attempt",
    dashboardUrlLabel: "Dashboard URL",
    diagnosticsStructuredStatus: "Structured status",
    diagnosticsRawGateway: "Gateway raw output",
    diagnosticsLastCommand: "Latest command output",
    diagnosticsHistory: "Execution history",
    diagnosticsNone: "No structured status available yet. Raw output is kept below.",
    actionPrimary: "Primary action",
    actionSecondary: "Secondary action",
    actionsTitle: "Actions",
    gatewayStatusTitle: "Gateway Status",
    rawOutput: "Raw output",
    rawParseFallback: "JSON parsing failed. Showing raw output.",
    settingsTitle: "Settings",
    settingsReload: "Reload Settings",
    settingsReloading: "Reloading...",
    settingsSaveAll: "Save All",
    settingsSavingAll: "Saving...",
    settingsSaveOne: "Save",
    settingsSavingOne: "Saving...",
    fieldBooleanTrue: "true",
    fieldBooleanFalse: "false",
    actionOpenDashboard: "Open Dashboard",
    actionOpeningDashboard: "Opening...",
    actionStart: "Start",
    actionStarting: "Starting...",
    actionStop: "Stop",
    actionStopping: "Stopping...",
    actionRestart: "Restart",
    actionRestarting: "Restarting...",
    actionRefreshAll: "Refresh All",
    actionRefreshingAll: "Refreshing...",
    savePartialFail: "Some settings failed to save",
    saveAllSuccess: "All settings saved",
    commandFailed: "Command execution failed",
    logDetect: "Detect OpenClaw",
    logConfig: "Read config file path",
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

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0];
  return line || "-";
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

  return (
    response.success ||
    hasDetectSignal(detect.path) ||
    hasDetectSignal(detect.configFile) ||
    hasDetectSignal(detect.installDir) ||
    hasDetectSignal(detect.version)
  );
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    normalized === "up"
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
    normalized === "not running"
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

function analyzeGatewayInsight(
  response: CommandResponse | null,
  parsed: Record<string, unknown> | null,
  raw: string,
): GatewayInsight {
  const RUNNING_TOKENS = ["running", "active", "started", "ready", "listening", "online"];
  const STOPPED_TOKENS = [
    "not running",
    "stopped",
    "inactive",
    "not started",
    "offline",
    "down",
  ];
  const ERROR_TOKENS = ["error", "failed", "exception", "panic", "timeout"];

  const signals = parsed ? collectObjectSignals(parsed) : [];
  let running: boolean | null = null;
  let healthy: boolean | null = null;
  let summary = "";

  for (const signal of signals) {
    const signalKey = signal.key.toLowerCase();
    const boolSignal = toBooleanSignal(signal.value);
    if (
      running === null &&
      boolSignal !== null &&
      (signalKey.includes("running") ||
        signalKey.includes("active") ||
        signalKey.includes("started") ||
        signalKey.endsWith("up"))
    ) {
      running = boolSignal;
    }

    if (
      healthy === null &&
      boolSignal !== null &&
      (signalKey.includes("healthy") ||
        signalKey.includes("health") ||
        signalKey.includes("ready") ||
        signalKey.includes("available"))
    ) {
      healthy = boolSignal;
    }

    if (
      !summary &&
      typeof signal.value === "string" &&
      (signalKey.includes("status") || signalKey.includes("state") || signalKey.includes("phase"))
    ) {
      summary = signal.value;
    }
  }

  const mergedText = [
    response?.message ?? "",
    response?.stdout ?? "",
    response?.stderr ?? "",
    raw,
    summary,
  ]
    .join("\n")
    .toLowerCase();

  if (running === null) {
    if (containsToken(mergedText, STOPPED_TOKENS)) {
      running = false;
    } else if (containsToken(mergedText, RUNNING_TOKENS)) {
      running = true;
    }
  }

  if (healthy === null) {
    if (containsToken(mergedText, ["unhealthy", "not ready"])) {
      healthy = false;
    } else if (containsToken(mergedText, ["healthy", "ready", "ok"])) {
      healthy = true;
    }
  }

  const hasFieldError = signals.some((signal) => {
    const signalKey = signal.key.toLowerCase();
    if (!signalKey.includes("error") && !signalKey.includes("fail")) {
      return false;
    }
    const text = toText(signal.value).trim().toLowerCase();
    return text !== "" && text !== "false" && text !== "0" && text !== "null";
  });

  const responseFailed = response ? !response.success : false;
  const hasError = responseFailed || hasFieldError || containsToken(mergedText, ERROR_TOKENS);
  const stoppedHint = running === false || containsToken(mergedText, STOPPED_TOKENS);

  return {
    running,
    healthy,
    stoppedHint,
    hasError,
    summary: summary || firstLine(response?.message ?? ""),
  };
}

function extractDashboardUrl(response: CommandResponse | null): string {
  if (!response) {
    return "";
  }

  if (isRecord(response.parsed_json)) {
    const value = response.parsed_json.url;
    if (typeof value === "string" && value.startsWith("http")) {
      return value;
    }
  }

  const matched = response.stdout.match(/https?:\/\/[^\s]+/);
  return matched ? matched[0] : "";
}

function classifyDashboardIssue(response: CommandResponse | null): DashboardIssue | null {
  if (!response || response.success) {
    return null;
  }

  const joined = [response.message, response.stderr, response.stdout]
    .join("\n")
    .toLowerCase();

  if (
    joined.includes("gateway is not running") ||
    joined.includes("gateway not ready") ||
    joined.includes("start gateway") ||
    joined.includes("service is not running")
  ) {
    return { kind: "gateway-not-ready", detail: firstLine(response.stderr || response.stdout) };
  }
  if (joined.includes("failed to fetch dashboard url")) {
    return { kind: "dashboard-command-failed", detail: firstLine(response.stderr || response.stdout) };
  }
  if (joined.includes("url not found") || joined.includes("no url found")) {
    return { kind: "url-missing", detail: firstLine(response.stderr || response.stdout) };
  }
  if (joined.includes("open dashboard url") || joined.includes("open url stderr")) {
    return { kind: "open-url-failed", detail: firstLine(response.stderr || response.stdout) };
  }

  return { kind: "unknown", detail: firstLine(response.stderr || response.stdout || response.message) };
}

function isGatewayBasicReady(response: CommandResponse): boolean {
  return (
    response.success &&
    (isRecord(response.parsed_json) || response.stdout.trim().length > 0)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForInstallStable(
  refreshOverview: () => Promise<{ response: CommandResponse; installed: boolean }>,
  refreshGateway: () => Promise<CommandResponse>,
  refreshSettings: () => Promise<CommandResponse>,
): Promise<{ stable: boolean; installed: boolean }> {
  let stableSuccesses = 0;
  let latestInstalled = false;

  for (let attempt = 0; attempt < INSTALL_STABILIZE_POLL_ATTEMPTS; attempt += 1) {
    const detect = await refreshOverview();
    latestInstalled = detect.installed;
    if (detect.installed) {
      stableSuccesses += 1;
    } else {
      stableSuccesses = 0;
    }

    if (stableSuccesses >= INSTALL_STABLE_SUCCESS_TARGET) {
      await refreshGateway();
      await refreshSettings();
      return { stable: true, installed: true };
    }

    if (attempt < INSTALL_STABILIZE_POLL_ATTEMPTS - 1) {
      await sleep(INSTALL_STABILIZE_POLL_INTERVAL_MS);
    }
  }

  await refreshGateway();
  if (latestInstalled) {
    await refreshSettings();
  }
  return { stable: false, installed: latestInstalled };
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => readStoredLocale() ?? "zh-CN");
  const [languageConfirmed, setLanguageConfirmed] = useState<boolean>(
    () => readStoredLocale() !== null,
  );
  const [overview, setOverview] = useState<OverviewState>({
    installed: false,
    version: "-",
    path: "-",
    configFile: "-",
  });
  const [gatewayRaw, setGatewayRaw] = useState<string>("");
  const [gatewayParsed, setGatewayParsed] = useState<Record<string, unknown> | null>(null);
  const [gatewayResponse, setGatewayResponse] = useState<CommandResponse | null>(null);
  const [gatewayReady, setGatewayReady] = useState<boolean>(false);
  const [dashboardAttempt, setDashboardAttempt] = useState<DashboardAttempt | null>(null);
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
  const dashboardUrl = useMemo(
    () => extractDashboardUrl(dashboardAttempt?.response ?? null),
    [dashboardAttempt],
  );
  const dashboardIssue = useMemo(
    () => classifyDashboardIssue(dashboardAttempt?.response ?? null),
    [dashboardAttempt],
  );

  const homeStatus: HomeStatus = useMemo(() => {
    if (!overview.installed) {
      return "not-installed";
    }

    if (
      busyAction === "install" ||
      busyAction === "gateway-start" ||
      busyAction === "gateway-restart" ||
      busyAction === "status" ||
      busyAction === "boot"
    ) {
      return "starting";
    }

    if (gatewayReady && !gatewayInsight.hasError) {
      return "console-ready";
    }

    if (gatewayInsight.hasError) {
      return "service-error";
    }

    if (gatewayInsight.stoppedHint || gatewayInsight.running === false) {
      return "installed-not-started";
    }

    return gatewayReady ? "console-ready" : "installed-not-started";
  }, [overview.installed, busyAction, gatewayReady, gatewayInsight]);

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
    homeStatus === "not-installed"
      ? t.nextInstall
      : homeStatus === "installed-not-started"
        ? t.nextStart
        : homeStatus === "starting"
          ? t.nextStarting
          : homeStatus === "service-error"
            ? t.nextRecover
            : dashboardIssue
              ? t.dashboardIssueSuggestionB
              : t.nextOpenDashboard;

  const homeActionPlan = useMemo(() => {
    if (homeStatus === "not-installed") {
      return {
        primary: "install" as HomeAction,
        secondary: "refresh-all" as HomeAction,
        minor: [] as HomeAction[],
      };
    }
    if (homeStatus === "installed-not-started") {
      return {
        primary: "start" as HomeAction,
        secondary: "refresh-status" as HomeAction,
        minor: ["refresh-all"] as HomeAction[],
      };
    }
    if (homeStatus === "starting") {
      return {
        primary: "refresh-status" as HomeAction,
        secondary: "refresh-all" as HomeAction,
        minor: [] as HomeAction[],
      };
    }
    if (homeStatus === "service-error") {
      return {
        primary: "restart" as HomeAction,
        secondary: "refresh-status" as HomeAction,
        minor: ["refresh-all"] as HomeAction[],
      };
    }
    return {
      primary: "open-dashboard" as HomeAction,
      secondary: "restart" as HomeAction,
      minor: ["stop", "refresh-status"] as HomeAction[],
    };
  }, [homeStatus]);

  const appView: AppView = !languageConfirmed
    ? "language-select"
    : overview.installed && gatewayReady
      ? "dashboard"
      : "onboarding";

  const onboardingSteps = useMemo<OnboardingStep[]>(() => {
    const stepDetectState: OnboardingStepState =
      overview.installed ? "done" : busyAction === "boot" ? "active" : "pending";

    const stepInstallState: OnboardingStepState =
      overview.installed ? "done" : busyAction === "install" ? "active" : "pending";

    const stepStartState: OnboardingStepState =
      gatewayReady
        ? "done"
        : busyAction === "gateway-start"
          ? "active"
          : overview.installed
            ? "pending"
            : "pending";

    const stepVerifyState: OnboardingStepState =
      gatewayReady
        ? "done"
        : busyAction === "status" || busyAction === "boot"
          ? "active"
          : "pending";

    return [
      {
        id: "detect",
        title: t.stepDetectTitle,
        description: t.stepDetectDescription,
        state: stepDetectState,
      },
      {
        id: "install",
        title: t.stepInstallTitle,
        description: t.stepInstallDescription,
        state: stepInstallState,
      },
      {
        id: "start",
        title: t.stepStartTitle,
        description: t.stepStartDescription,
        state: stepStartState,
      },
      {
        id: "verify",
        title: t.stepVerifyTitle,
        description: t.stepVerifyDescription,
        state: stepVerifyState,
      },
    ];
  }, [
    overview.installed,
    busyAction,
    gatewayReady,
    t.stepDetectTitle,
    t.stepDetectDescription,
    t.stepInstallTitle,
    t.stepInstallDescription,
    t.stepStartTitle,
    t.stepStartDescription,
    t.stepVerifyTitle,
    t.stepVerifyDescription,
  ]);

  const completedSteps = onboardingSteps.filter((step) => step.state === "done").length;
  const progressPercent = Math.round((completedSteps / onboardingSteps.length) * 100);

  const onboardingStatusText = homeStatusDescription;

  const isBusy = (action: string): boolean =>
    busyAction === action || busyAction === "boot";

  function homeActionText(action: HomeAction): string {
    if (action === "install") {
      return isBusy("install") ? t.actionInstalling : t.actionInstall;
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
      return isBusy("status") ? t.actionRefreshingStatus : t.actionRefreshStatus;
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
    if (action === "refresh-all") {
      return false;
    }
    return !overview.installed;
  }

  function runHomeAction(action: HomeAction) {
    if (action === "install") {
      handleInstall();
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

  async function refreshOverview(): Promise<{ response: CommandResponse; installed: boolean }> {
    const detectResponse = await detectOpenclaw();
    recordResponse(t.logDetect, detectResponse);
    const detectParsed = parseDetect(detectResponse.stdout);
    const installed = inferInstalledFromDetect(detectResponse, detectParsed);

    let configFile = detectParsed.configFile;
    if (installed) {
      const configResponse = await getConfigFile();
      recordResponse(t.logConfig, configResponse);
      if (configResponse.success) {
        configFile = firstLine(configResponse.stdout);
      }
    }

    setOverview({
      installed,
      version: detectParsed.version,
      path: detectParsed.path,
      configFile,
    });

    return { response: detectResponse, installed };
  }

  async function refreshGateway() {
    const response = await gatewayStatus();
    recordResponse(t.logGatewayStatus, response);
    setGatewayResponse(response);
    setGatewayRaw(response.stdout);
    if (isRecord(response.parsed_json)) {
      setGatewayParsed(response.parsed_json);
    } else {
      setGatewayParsed(null);
    }
    setGatewayReady(isGatewayBasicReady(response));
    return response;
  }

  async function refreshSettings() {
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
      const gatewayResponse = await refreshGateway();

      if (detect.installed) {
        await refreshSettings();
      } else {
        setSettings({ ...DEFAULT_SETTINGS });
        setDashboardAttempt(null);
      }

      markUpdated();

      if (!detect.installed) {
        setNotice({ kind: "info", text: t.noticeNeedInstall });
      } else if (!gatewayResponse.success) {
        setNotice({ kind: "info", text: t.noticeNeedGateway });
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
    afterSuccess?: () => Promise<Notice | void>,
  ) {
    setBusyAction(actionKey);
    setNotice({ kind: "info", text: `${runningText}` });
    try {
      const response = await task();
      recordResponse(runningText, response);
      if (!response.success) {
        setNotice({
          kind: "error",
          text: response.message || t.commandFailed,
        });
        return;
      }

      let postSuccessNotice: Notice | void = undefined;
      if (afterSuccess) {
        postSuccessNotice = await afterSuccess();
      }

      markUpdated();
      if (postSuccessNotice) {
        setNotice(postSuccessNotice);
      } else {
        setNotice({
          kind: "success",
          text: response.message || t.noticeRefreshed,
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  function handleGatewayAction(action: GatewayAction) {
    const labels: Record<GatewayAction, string> = {
      start: t.actionStartGateway,
      stop: t.actionStop,
      restart: t.actionRestart,
    };
    void runAction(
      `gateway-${action}`,
      labels[action],
      () => gatewayControl(action),
      async () => {
        await refreshGateway();
        if (action === "start" || action === "restart") {
          setDashboardAttempt(null);
        }
      },
    );
  }

  function handleInstall() {
    void runAction("install", t.actionInstall, installOpenclaw, async () => {
      setNotice({ kind: "info", text: t.noticeInstallPendingRefresh });
      const result = await waitForInstallStable(
        refreshOverview,
        refreshGateway,
        refreshSettings,
      );
      if (!result.stable) {
        return { kind: "info", text: t.noticeInstallDetectTimeout };
      }
      setDashboardAttempt(null);
      return undefined;
    });
  }

  function handleOpenDashboard() {
    void (async () => {
      setBusyAction("dashboard");
      setNotice({ kind: "info", text: t.actionOpenDashboard });
      try {
        const response = await openDashboard();
        recordResponse(t.actionOpenDashboard, response);
        const localeCode = locale === "zh-CN" ? "zh-CN" : "en-US";
        setDashboardAttempt({
          response,
          at: new Date().toLocaleString(localeCode),
        });

        markUpdated();
        if (!response.success) {
          setNotice({
            kind: "error",
            text: response.message || t.commandFailed,
          });
          return;
        }

        setNotice({
          kind: "success",
          text: response.message || t.noticeRefreshed,
        });
      } catch (error) {
        setNotice({ kind: "error", text: toErrorMessage(error) });
      } finally {
        setBusyAction(null);
      }
    })();
  }

  function handleRefreshStatus() {
    void runAction("status", t.actionRefreshStatus, refreshGateway);
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
        await refreshSettings();
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

      await refreshSettings();
      markUpdated();
      if (failures.length > 0) {
        setNotice({
          kind: "error",
          text: `${t.savePartialFail}: ${failures.join(", ")}`,
        });
      } else {
        setNotice({ kind: "success", text: t.saveAllSuccess });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
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
    return (
      <main className="grid-layout onboarding-layout">
        <section className="panel panel-overview">
          <h2>{t.onboardingTitle}</h2>
          <p className="lead">{t.onboardingDescription}</p>
          <div className="progress-head">
            <span>
              {t.onboardingProgress}: {completedSteps}/{onboardingSteps.length}
            </span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <label className="field-label">{t.noticeCurrentStatus}</label>
          <p className="status-summary">
            {homeStatusLabel}: {onboardingStatusText}
          </p>
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
              {!overview.installed ? (
                <button
                  className="btn btn-primary btn-main"
                  onClick={handleInstall}
                  disabled={Boolean(busyAction)}
                >
                  {isBusy("install") ? t.actionInstalling : t.actionInstall}
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-main"
                  onClick={() => handleGatewayAction("start")}
                  disabled={Boolean(busyAction)}
                >
                  {isBusy("gateway-start") ? t.actionStartingGateway : t.actionStartGateway}
                </button>
              )}
            </div>
            <div className="home-action-secondary">
              <label className="field-label">{t.actionSecondary}</label>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  if (!overview.installed) {
                    void refreshAll();
                    return;
                  }
                  handleRefreshStatus();
                }}
                disabled={Boolean(busyAction)}
              >
                {!overview.installed
                  ? isBusy("boot")
                    ? t.actionRefreshingAll
                    : t.actionRedetect
                  : isBusy("status")
                    ? t.actionRefreshingStatus
                    : t.actionRefreshStatus}
              </button>
            </div>
          </div>
          <div className="kv-grid">
            <div className="kv-row">
              <span>{t.overviewInstallStatus}</span>
              <strong>{overview.installed ? t.overviewInstalled : t.overviewNotInstalled}</strong>
            </div>
            <div className="kv-row">
              <span>{t.overviewGatewayBaseStatus}</span>
              <strong>{gatewayReady ? t.overviewGatewayReady : t.overviewGatewayNotReady}</strong>
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
    const dashboardIssueTitle =
      dashboardIssue?.kind === "gateway-not-ready"
        ? t.dashboardIssueGatewayNotReady
        : dashboardIssue?.kind === "dashboard-command-failed"
          ? t.dashboardIssueCommandFailed
          : dashboardIssue?.kind === "url-missing"
            ? t.dashboardIssueUrlMissing
            : dashboardIssue?.kind === "open-url-failed"
              ? t.dashboardIssueOpenFailed
              : t.dashboardIssueUnknown;

    const issueSuggestionTail =
      dashboardIssue?.kind === "open-url-failed"
        ? t.dashboardIssueSuggestionC
        : dashboardIssue?.kind === "gateway-not-ready"
          ? t.dashboardIssueSuggestionD
          : t.dashboardIssueSuggestionB;

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
              <strong>{overview.installed ? t.overviewInstalled : t.overviewNotInstalled}</strong>
            </div>
            <div className="home-row">
              <span>{t.homeServiceTitle}</span>
              <strong>{homeStatusLabel}</strong>
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

            {homeActionPlan.secondary ? (
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
            ) : null}
          </div>

          {homeActionPlan.minor.length > 0 ? (
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
          ) : null}
        </section>

        {dashboardIssue ? (
          <section className="panel dashboard-issue">
            <h2>{t.dashboardIssueTitle}</h2>
            <p>{dashboardIssueTitle}</p>
            {dashboardIssue.detail ? <p className="issue-detail">{dashboardIssue.detail}</p> : null}
            <p>{t.dashboardIssueSuggestionA}</p>
            <p>{issueSuggestionTail}</p>
            {dashboardAttempt ? (
              <p className="issue-meta">
                {t.dashboardIssueLastAttempt}: {dashboardAttempt.at}
              </p>
            ) : null}
            {dashboardUrl ? (
              <div className="kv-row">
                <span>{t.dashboardUrlLabel}</span>
                <strong>{dashboardUrl}</strong>
              </div>
            ) : null}
          </section>
        ) : null}

        <details className="panel fold-panel">
          <summary>{t.homeAdvancedDiagnostics}</summary>
          <p className="fold-hint">{t.homeAdvancedDiagnosticsHint}</p>
          <div className="kv-grid">
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
            <div className="kv-row">
              <span>{t.homeServiceTitle}</span>
              <strong>
                {gatewayInsight.summary || (gatewayReady ? t.overviewGatewayReady : t.overviewGatewayNotReady)}
              </strong>
            </div>
          </div>

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
                  void runAction(
                    "reload-settings",
                    t.settingsReload,
                    getCommonSettings,
                    async () => {
                      await refreshSettings();
                    },
                  );
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
