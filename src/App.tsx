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
  const [gatewayReady, setGatewayReady] = useState<boolean>(false);
  const [settings, setSettings] = useState<CommonSettings>(DEFAULT_SETTINGS);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastCommandOutput, setLastCommandOutput] = useState<string>("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("-");

  const t = I18N[locale];
  const gatewayEntries = useMemo(() => Object.entries(gatewayParsed ?? {}), [gatewayParsed]);

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

  const onboardingStatusText = !overview.installed
    ? t.statusNeedInstall
    : gatewayReady
      ? t.statusReady
      : t.statusNeedGateway;

  const isBusy = (action: string): boolean =>
    busyAction === action || busyAction === "boot";

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
      return undefined;
    });
  }

  function handleOpenDashboard() {
    void runAction("dashboard", t.actionOpenDashboard, openDashboard);
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
          <p className="status-summary">{onboardingStatusText}</p>
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
          <div className="actions-grid">
            <button
              className="btn btn-secondary"
              onClick={() => {
                void refreshAll();
              }}
              disabled={Boolean(busyAction)}
            >
              {isBusy("boot") ? t.actionRefreshingAll : t.actionRedetect}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleInstall}
              disabled={Boolean(busyAction) || overview.installed}
            >
              {isBusy("install") ? t.actionInstalling : t.actionInstall}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => handleGatewayAction("start")}
              disabled={Boolean(busyAction) || !overview.installed}
            >
              {isBusy("gateway-start") ? t.actionStartingGateway : t.actionStartGateway}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleRefreshStatus}
              disabled={Boolean(busyAction) || !overview.installed}
            >
              {isBusy("status") ? t.actionRefreshingStatus : t.actionRefreshStatus}
            </button>
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
    return (
      <main className="grid-layout">
        <section className="panel panel-overview">
          <h2>{t.overviewTitle}</h2>
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

        <section className="panel panel-actions">
          <h2>{t.actionsTitle}</h2>
          <div className="actions-grid">
            <button
              className="btn btn-primary"
              onClick={handleInstall}
              disabled={Boolean(busyAction)}
            >
              {isBusy("install") ? t.actionInstalling : t.actionInstall}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => handleGatewayAction("start")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-start") ? t.actionStarting : t.actionStart}
            </button>
            <button
              className="btn btn-warning"
              onClick={() => handleGatewayAction("stop")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-stop") ? t.actionStopping : t.actionStop}
            </button>
            <button
              className="btn btn-warning"
              onClick={() => handleGatewayAction("restart")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-restart") ? t.actionRestarting : t.actionRestart}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleRefreshStatus}
              disabled={Boolean(busyAction)}
            >
              {isBusy("status") ? t.actionRefreshingStatus : t.actionRefreshStatus}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleOpenDashboard}
              disabled={Boolean(busyAction)}
            >
              {isBusy("dashboard") ? t.actionOpeningDashboard : t.actionOpenDashboard}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void refreshAll();
              }}
              disabled={Boolean(busyAction)}
            >
              {isBusy("boot") ? t.actionRefreshingAll : t.actionRefreshAll}
            </button>
          </div>
        </section>

        <section className="panel panel-status">
          <h2>{t.gatewayStatusTitle}</h2>
          {gatewayEntries.length > 0 ? (
            <div className="status-grid">
              {gatewayEntries.map(([key, value]) => (
                <div key={key} className="status-item">
                  <span>{key}</span>
                  <strong>{toText(value)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">{t.rawParseFallback}</p>
          )}
          <label className="field-label">{t.rawOutput}</label>
          <pre className="raw">{gatewayRaw || t.outputEmpty}</pre>
        </section>

        <section className="panel panel-settings">
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
        </section>

        <section className="panel panel-output">
          <h2>{t.outputTitle}</h2>
          <pre className="raw">{lastCommandOutput || t.outputEmpty}</pre>
        </section>
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
          <p>{appView === "dashboard" ? t.dashboardTitle : t.appSubtitle}</p>
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
