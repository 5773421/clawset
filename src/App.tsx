import { useEffect, useMemo, useState } from "react";
import {
  detectOpenclaw,
  gatewayStatus as getLaunchStatus,
  installOpenclaw,
  launchOpenclaw,
  openDashboard as openOpenclawHome,
  readOpenclawProviders as readAiConnections,
  writeOpenclawProvider as saveAiConnection,
} from "./lib/tauri";
import type { CommandResponse } from "./types";

type Locale = "zh-CN" | "en-US";
type StepId = "welcome" | "install" | "model" | "launch" | "success";
type BusyAction = "check" | "install" | "connect" | "launch" | "enter" | null;
type NoticeKind = "info" | "success" | "error";
type ServicePresetId = "openai" | "kimi" | "glm" | "openrouter" | "custom";
type OpenclawCompatibilityValue =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "github-copilot"
  | "bedrock-converse-stream"
  | "ollama";
type CompatibilityModeId = OpenclawCompatibilityValue | "custom";
type RowTone = "ready" | "neutral" | "missing";

interface Notice {
  kind: NoticeKind;
  text: string;
}

interface InstallSnapshot {
  checked: boolean;
  installed: boolean;
  version: string;
  installDir: string;
  rawStdout: string;
  rawStderr: string;
}

interface LaunchSnapshot {
  checked: boolean;
  serviceReady: boolean | null;
  localReady: boolean | null;
  appReady: boolean | null;
  summary: string;
  rawStdout: string;
  rawStderr: string;
}

interface AiConnectionSnapshot {
  checked: boolean;
  connected: boolean;
  providerName: string;
  baseUrl: string;
  api: string;
  defaultModel: string;
  rawStdout: string;
  rawStderr: string;
}

interface ServicePreset {
  providerName: string;
  baseUrl: string;
  api: string;
  defaultModel: string;
  label: Record<Locale, string>;
  hint: Record<Locale, string>;
}

interface CompatibilityModeOption {
  value: string;
  label: Record<Locale, string>;
}

interface ServiceFormState {
  providerName: string;
  baseUrl: string;
  api: string;
  defaultModel: string;
  apiKey: string;
}

interface SnapshotBundle {
  install: InstallSnapshot;
  launch: LaunchSnapshot;
  connection: AiConnectionSnapshot;
}

const LOCALE_STORAGE_KEY = "clawset.locale";
const STEP_ORDER: StepId[] = ["welcome", "install", "model", "launch", "success"];

const EMPTY_INSTALL: InstallSnapshot = {
  checked: false,
  installed: false,
  version: "",
  installDir: "",
  rawStdout: "",
  rawStderr: "",
};

const EMPTY_LAUNCH: LaunchSnapshot = {
  checked: false,
  serviceReady: null,
  localReady: null,
  appReady: null,
  summary: "",
  rawStdout: "",
  rawStderr: "",
};

const EMPTY_CONNECTION: AiConnectionSnapshot = {
  checked: false,
  connected: false,
  providerName: "",
  baseUrl: "",
  api: "",
  defaultModel: "",
  rawStdout: "",
  rawStderr: "",
};

const DEFAULT_FORM: ServiceFormState = {
  providerName: "openai",
  baseUrl: "https://api.openai.com/v1",
  api: "openai-completions",
  defaultModel: "gpt-4o-mini",
  apiKey: "",
};

const SERVICE_PRESETS: Record<ServicePresetId, ServicePreset> = {
  openai: {
    providerName: "openai",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    defaultModel: "gpt-4o-mini",
    label: { "zh-CN": "OpenAI", "en-US": "OpenAI" },
    hint: {
      "zh-CN": "最直接，通常只要填访问密钥。",
      "en-US": "The simplest path. Most people only need the access key.",
    },
  },
  kimi: {
    providerName: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    defaultModel: "moonshot-v1-8k",
    label: { "zh-CN": "Kimi", "en-US": "Kimi" },
    hint: {
      "zh-CN": "适合 Kimi / Moonshot 用户。",
      "en-US": "Good for Kimi / Moonshot users.",
    },
  },
  glm: {
    providerName: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    defaultModel: "glm-4-flash",
    label: { "zh-CN": "GLM", "en-US": "GLM" },
    hint: {
      "zh-CN": "适合 GLM 用户。",
      "en-US": "Good for GLM users.",
    },
  },
  openrouter: {
    providerName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    defaultModel: "openai/gpt-4o-mini",
    label: { "zh-CN": "OpenRouter", "en-US": "OpenRouter" },
    hint: {
      "zh-CN": "适合想先试多个模型服务的人。",
      "en-US": "Useful if you want one connection for many models.",
    },
  },
  custom: {
    providerName: "custom",
    baseUrl: "",
    api: "openai-completions",
    defaultModel: "",
    label: { "zh-CN": "其他兼容服务", "en-US": "Other compatible service" },
    hint: {
      "zh-CN": "只有需要自定义地址时再展开高级项。",
      "en-US": "Use this only when you need a custom compatible endpoint.",
    },
  },
};

const OPENCLAW_COMPATIBILITY_VALUES: OpenclawCompatibilityValue[] = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
];

const LEGACY_COMPATIBILITY_VALUE_ALIASES: Record<string, OpenclawCompatibilityValue> = {
  openai: "openai-completions",
  anthropic: "anthropic-messages",
  google: "google-generative-ai",
  "azure-openai": "openai-completions",
};

const COMPATIBILITY_MODE_OPTIONS: Record<CompatibilityModeId, CompatibilityModeOption> = {
  "openai-completions": {
    value: "openai-completions",
    label: { "zh-CN": "OpenAI / Chat Completions", "en-US": "OpenAI / Chat Completions" },
  },
  "openai-responses": {
    value: "openai-responses",
    label: { "zh-CN": "OpenAI / Responses API", "en-US": "OpenAI / Responses API" },
  },
  "openai-codex-responses": {
    value: "openai-codex-responses",
    label: { "zh-CN": "OpenAI / Codex Responses", "en-US": "OpenAI / Codex Responses" },
  },
  "anthropic-messages": {
    value: "anthropic-messages",
    label: { "zh-CN": "Anthropic / Messages", "en-US": "Anthropic / Messages" },
  },
  "google-generative-ai": {
    value: "google-generative-ai",
    label: { "zh-CN": "Google / Generative AI", "en-US": "Google / Generative AI" },
  },
  "github-copilot": {
    value: "github-copilot",
    label: { "zh-CN": "GitHub Copilot", "en-US": "GitHub Copilot" },
  },
  "bedrock-converse-stream": {
    value: "bedrock-converse-stream",
    label: { "zh-CN": "AWS Bedrock / ConverseStream", "en-US": "AWS Bedrock / ConverseStream" },
  },
  ollama: {
    value: "ollama",
    label: { "zh-CN": "Ollama", "en-US": "Ollama" },
  },
  custom: {
    value: "",
    label: { "zh-CN": "自定义", "en-US": "Custom" },
  },
};

function normalizeKnownCompatibilityValue(value: string): OpenclawCompatibilityValue | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized in LEGACY_COMPATIBILITY_VALUE_ALIASES) {
    return LEGACY_COMPATIBILITY_VALUE_ALIASES[normalized];
  }

  if (OPENCLAW_COMPATIBILITY_VALUES.includes(normalized as OpenclawCompatibilityValue)) {
    return normalized as OpenclawCompatibilityValue;
  }

  return null;
}

const I18N = {
  "zh-CN": {
    brand: "Clawset Desktop",
    badge: "OpenClaw 安装助手",
    technicalDetails: "查看技术详情",
    previewHint: "浏览器预览模式只能看界面。真正安装、初始化和配置写入需要在 Tauri 桌面环境中执行。",
    states: {
      ready: "已就绪",
      waiting: "待确认",
      attention: "需处理",
    },
    actions: {
      back: "上一步",
      continue: "继续",
      checkAgain: "重新检查",
      checking: "检查中...",
      install: "安装 OpenClaw",
      installing: "安装中...",
      connect: "保存并继续",
      connecting: "保存中...",
      showAdvanced: "展开高级项",
      hideAdvanced: "收起高级项",
      launch: "启动并完成初始化",
      launching: "启动中...",
      startUsing: "开始使用 OpenClaw",
      starting: "打开中...",
    },
    notices: {
      checking: "正在检查当前安装状态...",
      checked: "状态已更新。",
      installSuccess: "OpenClaw 已安装完成。",
      installFailed: "OpenClaw 安装未完成。",
      connectSuccess: "AI 服务已连接。",
      connectFailed: "AI 服务连接失败。",
      keyRequired: "请先填写访问密钥。",
      customRequired: "请补全服务地址、兼容模式和默认模型。",
      launchSuccess: "OpenClaw 已完成启动与初始化。",
      launchFailed: "OpenClaw 启动或初始化失败。",
      launchRecovered: "启动流程返回了错误，但当前状态看起来已经可用。",
      launchIncomplete: "启动检查已执行，但还有一项检查没有通过。",
      openSuccess: "正在打开 OpenClaw。",
      openFailed: "未能打开 OpenClaw。",
    },
    steps: {
      welcome: {
        label: "1 / 5",
        title: "选择语言",
        description: "先选语言，然后开始安装。",
      },
      install: {
        label: "2 / 5",
        title: "安装 OpenClaw",
        description: "如果这台电脑还没装好，就在这里完成安装。",
      },
      model: {
        label: "3 / 5",
        title: "连接 AI 服务",
        description: "连接一个你已经有权限使用的服务。",
      },
      launch: {
        label: "4 / 5",
        title: "启动并完成初始化",
        description: "把首次使用必须的启动动作一次做完。",
      },
      success: {
        label: "5 / 5",
        title: "完成 / 开始使用",
        description: "现在可以直接进入 OpenClaw。",
      },
    },
    welcome: {
      title: "先选语言，然后按步骤完成安装。",
      body: "首次安装只保留必要主路径。",
      languageTitle: "界面语言",
      languageBody: "后续按钮、说明和错误提示会跟随这里的选择。",
    },
    install: {
      title: "先把 OpenClaw 装好",
      body: "确认是否已安装；未安装就在这里完成。",
      detectedTitle: "已检测到可用安装",
      detectedBody: "可以直接继续。",
      missingTitle: "还没有检测到 OpenClaw",
      missingBody: "点击按钮后，安装器会完成安装并重新检查。",
      versionLabel: "当前版本",
      locationLabel: "安装位置",
      emptyVersion: "尚未检测到",
      emptyLocation: "安装完成后显示",
    },
    model: {
      title: "连接一个 AI 服务",
      body: "选择一个服务并填写访问密钥。",
      connectedTitle: "当前已检测到可用连接",
      connectedBody: "如需更换服务或更新密钥，可以重新保存。",
      emptyTitle: "还没有可用 AI 连接",
      emptyBody: "完成这一步后才能开始使用。",
      currentLabel: "当前连接",
      accessKeyLabel: "访问密钥",
      accessKeyHint: "通常这是唯一需要手动填写的字段。",
      advancedHint: "仅在使用自定义兼容地址时再展开。",
      baseUrlLabel: "服务地址",
      apiLabel: "兼容模式",
      customApiLabel: "自定义兼容值",
      customApiHint: "只有你的服务使用其它标识时才需要填写。",
      modelLabel: "默认模型",
    },
    launch: {
      title: "启动并完成初始化",
      body: "完成首次启动，并确认三项状态已就绪。",
      cards: {
        service: "OpenClaw 服务",
        local: "本地网关",
        app: "桌面连接",
      },
      readyTitle: "当前已经可以继续",
      readyBody: "启动与首次初始化看起来都已完成。",
      pendingTitle: "还需要完成最后的启动检查",
      pendingBody: "如果你还没执行过这一步，点击按钮后应用会尝试完成启动和首次初始化。",
      readySummary: "OpenClaw 服务、本地网关和桌面连接都已经就绪。",
      serviceHint: "还没检测到 OpenClaw 服务处于可用状态，请先执行这一步来安装或拉起服务。",
      localHint: "服务可能已存在，但本地网关还没有确认监听成功。",
      appHint: "本地网关看起来已经起来了，但桌面端还没有完成最终连接；请查看技术详情里的具体错误。",
    },
    success: {
      title: "OpenClaw 已可以开始使用",
      body: "安装、连接和首次启动已经完成。",
      summary: {
        install: "OpenClaw 已安装",
        ai: "AI 服务已连接",
        launch: "首次启动已完成",
      },
      laterNote: "Channel 仍然留到后续可选，不会挡在首次安装路径前面。",
    },
  },
  "en-US": {
    brand: "Clawset Desktop",
    badge: "OpenClaw installer",
    technicalDetails: "Technical details",
    previewHint: "Browser preview only shows the UI. Real install, initialization, and config writes run inside the Tauri desktop app.",
    states: {
      ready: "Ready",
      waiting: "Waiting",
      attention: "Needs attention",
    },
    actions: {
      back: "Back",
      continue: "Continue",
      checkAgain: "Check again",
      checking: "Checking...",
      install: "Install OpenClaw",
      installing: "Installing...",
      connect: "Save and continue",
      connecting: "Saving...",
      showAdvanced: "Show advanced",
      hideAdvanced: "Hide advanced",
      launch: "Start and finish setup",
      launching: "Starting...",
      startUsing: "Start using OpenClaw",
      starting: "Opening...",
    },
    notices: {
      checking: "Checking the current setup status...",
      checked: "Status updated.",
      installSuccess: "OpenClaw is installed.",
      installFailed: "OpenClaw installation did not complete.",
      connectSuccess: "AI service connected.",
      connectFailed: "AI service connection failed.",
      keyRequired: "Enter an access key first.",
      customRequired: "Fill in the service URL, compatibility mode, and default model.",
      launchSuccess: "OpenClaw finished startup and first-time initialization.",
      launchFailed: "OpenClaw could not finish startup or initialization.",
      launchRecovered: "Startup reported an error, but the current status now looks usable.",
      launchIncomplete: "Startup checks ran, but one startup check still needs attention.",
      openSuccess: "Opening OpenClaw.",
      openFailed: "Could not open OpenClaw.",
    },
    steps: {
      welcome: {
        label: "1 / 5",
        title: "Choose language",
        description: "Pick a language, then begin setup.",
      },
      install: {
        label: "2 / 5",
        title: "Install OpenClaw",
        description: "Install OpenClaw here if this computer does not have it yet.",
      },
      model: {
        label: "3 / 5",
        title: "Connect AI service",
        description: "Connect one service you already have access to.",
      },
      launch: {
        label: "4 / 5",
        title: "Start and finish setup",
        description: "Finish the startup work required for first use.",
      },
      success: {
        label: "5 / 5",
        title: "Done / Start using",
        description: "You can go straight into OpenClaw now.",
      },
    },
    welcome: {
      title: "Choose a language, then finish setup step by step.",
      body: "This installer keeps only the essential first path.",
      languageTitle: "Interface language",
      languageBody: "Buttons, guidance, and errors follow this choice.",
    },
    install: {
      title: "Get OpenClaw installed first",
      body: "Confirm whether OpenClaw is installed. If not, finish it here.",
      detectedTitle: "A usable install is already detected",
      detectedBody: "You can continue now.",
      missingTitle: "OpenClaw is not detected yet",
      missingBody: "Use the button below to install it and check again.",
      versionLabel: "Current version",
      locationLabel: "Install location",
      emptyVersion: "Not detected yet",
      emptyLocation: "Shown after install",
    },
    model: {
      title: "Connect one AI service",
      body: "Pick a service and paste an access key.",
      connectedTitle: "A usable connection is already detected",
      connectedBody: "Save again here if you want to switch providers or update the key.",
      emptyTitle: "No usable AI connection yet",
      emptyBody: "OpenClaw is not ready until this step is done.",
      currentLabel: "Current connection",
      accessKeyLabel: "Access key",
      accessKeyHint: "This is usually the only field you need to type manually.",
      advancedHint: "Open this only for custom compatible endpoints.",
      baseUrlLabel: "Service URL",
      apiLabel: "Compatibility mode",
      customApiLabel: "Custom compatibility value",
      customApiHint: "Only needed if your service uses another identifier.",
      modelLabel: "Default model",
    },
    launch: {
      title: "Start and finish setup",
      body: "Finish first startup and confirm the three checks are ready.",
      cards: {
        service: "OpenClaw service",
        local: "Local gateway",
        app: "Desktop connection",
      },
      readyTitle: "You can continue now",
      readyBody: "Startup and first-time initialization both look complete.",
      pendingTitle: "One final startup check still needs attention",
      pendingBody: "If you have not run this step yet, the button below attempts startup and first-time initialization for you.",
      readySummary: "The OpenClaw service, local gateway, and desktop connection all look ready.",
      serviceHint: "The OpenClaw service does not look usable yet, so this step still needs to install or start it.",
      localHint: "The service may exist, but the local gateway is not confirmed as listening yet.",
      appHint: "The local gateway appears to be up, but the desktop app has not finished the final connection; check Technical details for the concrete error.",
    },
    success: {
      title: "OpenClaw is ready to use",
      body: "Installation, connection, and first startup are complete.",
      summary: {
        install: "OpenClaw is installed",
        ai: "AI service is connected",
        launch: "First startup is complete",
      },
      laterNote: "Channels still stay as an optional later step and no longer block the first setup path.",
    },
  },
} as const;

type Copy = (typeof I18N)[Locale];

function getInitialLocale(): Locale {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en-US") {
    return saved;
  }

  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstLine(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function firstNonEmpty(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "";
}

function isWarningOnlyDetailLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.startsWith("warning:")
    || normalized.startsWith("warn:")
    || normalized.includes("running in non-interactive mode because stdin is not a tty");
}

function isNonActionableDetailLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return isWarningOnlyDetailLine(line)
    || normalized.startsWith("usage:")
    || normalized.startsWith("options:")
    || normalized.startsWith("🦞 openclaw")
    || normalized.endsWith(" stdout:")
    || normalized.endsWith(" stderr:")
    || normalized.includes(" exit_code:");
}

function firstActionableDetailLine(value: string): string {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.find((line) => !isNonActionableDetailLine(line)) ?? lines[0] ?? "";
}

function isTransientGatewayDetail(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    "config overwrite",
    "gateway closed",
    "abnormal closure",
    "no close reason",
    "no close frame",
    "websocket reset",
    "websocket closed",
    "ws reset",
    "ws closed",
    "connection reset",
    "reset by peer",
  ].some((token) => normalized.includes(token));
}

function mergeNoticeText(...values: string[]): string {
  const seen = new Set<string>();
  const parts = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });

  return parts.join(" ");
}

function normalizeDetectValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "(empty)" || normalized === "(none)") {
    return "";
  }
  return normalized;
}

function parseInstallResponse(response: CommandResponse): InstallSnapshot {
  const snapshot: InstallSnapshot = {
    checked: true,
    installed: response.success,
    version: "",
    installDir: "",
    rawStdout: response.stdout,
    rawStderr: response.stderr,
  };

  for (const rawLine of response.stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("installed:")) {
      snapshot.installed = line.replace("installed:", "").trim() === "true";
    } else if (line.startsWith("version:")) {
      snapshot.version = normalizeDetectValue(line.replace("version:", ""));
    } else if (line.startsWith("install_dir:")) {
      snapshot.installDir = normalizeDetectValue(line.replace("install_dir:", ""));
    }
  }

  if (!snapshot.version && response.success) {
    snapshot.version = firstLine(response.message);
  }

  return snapshot;
}

function flattenSignals(
  value: Record<string, unknown>,
  prefix = "",
  output: Array<{ key: string; value: unknown }> = [],
): Array<{ key: string; value: unknown }> {
  for (const [key, nextValue] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    output.push({ key: nextKey.toLowerCase(), value: nextValue });
    if (isRecord(nextValue)) {
      flattenSignals(nextValue, nextKey, output);
    }
  }
  return output;
}

function toBooleanSignal(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    return value > 0 ? true : null;
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "running", "active", "started", "ready", "healthy", "ok", "connected", "listening", "up", "loaded"].includes(normalized)) {
    return true;
  }
  if (["false", "stopped", "inactive", "failed", "error", "down", "disconnected", "not connected", "offline", "not loaded"].includes(normalized)) {
    return false;
  }
  return null;
}

function textHasToken(text: string, tokens: string[]): boolean {
  const normalized = text.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function inferSignal(
  signals: Array<{ key: string; value: unknown }>,
  keyTokens: string[],
  positiveTokens: string[],
  negativeTokens: string[],
): boolean | null {
  for (const signal of signals) {
    if (!keyTokens.some((token) => signal.key.includes(token))) {
      continue;
    }

    const direct = toBooleanSignal(signal.value);
    if (direct !== null) {
      return direct;
    }

    const text = toText(signal.value).toLowerCase();
    if (textHasToken(text, negativeTokens)) {
      return false;
    }
    if (textHasToken(text, positiveTokens)) {
      return true;
    }
  }

  return null;
}

function parseLaunchResponse(response: CommandResponse): LaunchSnapshot {
  const parsed = isRecord(response.parsed_json) ? response.parsed_json : null;
  const signals = parsed ? flattenSignals(parsed) : [];
  const service = parsed && isRecord(parsed.service) ? parsed.service : null;
  const serviceRuntime = service && isRecord(service.runtime) ? service.runtime : null;
  const configAudit = service && isRecord(service.configAudit) ? service.configAudit : null;
  const gateway = parsed && isRecord(parsed.gateway) ? parsed.gateway : null;
  const port = parsed && isRecord(parsed.port) ? parsed.port : null;
  const rpc = parsed && isRecord(parsed.rpc) ? parsed.rpc : null;
  const rawText = [response.message, response.stdout, response.stderr].join("\n").toLowerCase();

  let serviceReady = inferSignal(
    signals,
    ["daemon", "service.loaded", "service.runtime", "service.state"],
    ["installed", "running", "active", "ready", "ok", "loaded"],
    ["missing", "failed", "error", "stopped", "not installed", "not loaded"],
  );

  if (serviceReady === null) {
    serviceReady =
      toBooleanSignal(service?.loaded) ??
      toBooleanSignal(serviceRuntime?.status) ??
      toBooleanSignal(serviceRuntime?.state);
  }

  if (serviceReady === null) {
    serviceReady = textHasToken(rawText, ["daemon ready", "daemon running", "daemon installed", "launchagent", "service running"])
      ? true
      : textHasToken(rawText, ["daemon missing", "daemon failed", "daemon error", "service failed"])
        ? false
        : null;
  }

  let localReady = inferSignal(
    signals,
    ["gateway", "listen", "server", "port", "http"],
    ["listening", "running", "active", "online", "ready", "up", "busy"],
    ["not listening", "stopped", "failed", "offline", "down"],
  );

  if (localReady === null) {
    const portStatus = toText(port?.status).trim().toLowerCase();
    const listenerCount = Array.isArray(port?.listeners) ? port.listeners.length : 0;
    const probeUrl = toText(gateway?.probeUrl).trim();
    if (portStatus === "busy" || listenerCount > 0 || probeUrl) {
      localReady = true;
    }
  }

  if (localReady === null) {
    localReady = textHasToken(rawText, ["gateway running", "gateway started", "listening", "loopback-only gateway"])
      ? true
      : textHasToken(rawText, ["gateway failed", "not listening", "stopped"])
        ? false
        : null;
  }

  let appReady = inferSignal(
    signals,
    ["rpc"],
    ["connected", "ready", "available", "ok"],
    ["not connected", "disconnected", "failed", "timeout", "error"],
  );

  if (appReady === null) {
    appReady = toBooleanSignal(rpc?.ok);
  }

  if (appReady === null) {
    appReady = textHasToken(rawText, ["rpc connected", "rpc ready", "rpc available"])
      ? true
      : textHasToken(rawText, ["rpc failed", "not connected", "disconnected"])
        ? false
        : null;
  }

  const issues = configAudit && Array.isArray(configAudit.issues) ? configAudit.issues : [];
  const firstIssue = issues.find((issue) => isRecord(issue));
  const rpcError = rpc ? firstLine(toText(rpc.error)) : "";
  const serviceIssue = firstIssue ? firstLine(toText(firstIssue.message)) : "";

  return {
    checked: true,
    serviceReady,
    localReady,
    appReady,
    summary: firstNonEmpty(
      appReady === false ? rpcError : "",
      serviceReady === false ? serviceIssue : "",
      firstLine(response.stderr),
      firstLine(response.stdout),
      response.success ? "" : firstLine(response.message),
    ),
    rawStdout: response.stdout,
    rawStderr: response.stderr,
  };
}

function presetIdFromProvider(providerName: string, baseUrl: string): ServicePresetId {
  const normalizedName = providerName.trim().toLowerCase();
  const normalizedUrl = baseUrl.trim().toLowerCase();

  for (const [presetId, preset] of Object.entries(SERVICE_PRESETS) as Array<[ServicePresetId, ServicePreset]>) {
    if (preset.providerName === normalizedName) {
      return presetId;
    }
    if (preset.baseUrl && preset.baseUrl.toLowerCase() === normalizedUrl) {
      return presetId;
    }
  }

  return "custom";
}

function serviceLabelForProvider(locale: Locale, providerName: string, baseUrl: string): string {
  const presetId = presetIdFromProvider(providerName, baseUrl);
  if (presetId !== "custom") {
    return SERVICE_PRESETS[presetId].label[locale];
  }
  return providerName || SERVICE_PRESETS.custom.label[locale];
}

function compatibilityModeIdFromValue(value: string): CompatibilityModeId {
  const normalized = normalizeKnownCompatibilityValue(value);
  return normalized ?? (value.trim() ? "custom" : "openai-completions");
}

function defaultModelFromProviderModels(models: unknown): string {
  if (isRecord(models)) {
    return toText(models.default_model).trim();
  }

  if (!Array.isArray(models)) {
    return "";
  }

  for (const item of models) {
    if (typeof item === "string") {
      const modelId = item.trim();
      if (modelId) {
        return modelId;
      }
      continue;
    }

    if (!isRecord(item)) {
      continue;
    }

    const modelId = toText(item.id).trim();
    if (modelId) {
      return modelId;
    }

    const legacyDefault = toText(item.default_model).trim();
    if (legacyDefault) {
      return legacyDefault;
    }

    const modelName = toText(item.name).trim();
    if (modelName) {
      return modelName;
    }
  }

  return "";
}

function parseAiConnectionResponse(response: CommandResponse): AiConnectionSnapshot {
  const parsed = isRecord(response.parsed_json) ? response.parsed_json : null;
  const providers = parsed ? Object.entries(parsed) : [];
  const firstConfigured = providers.find(([, value]) => {
    if (!isRecord(value)) {
      return false;
    }

    const apiKey = toText(value.apiKey).trim();
    const baseUrl = toText(value.baseUrl).trim();
    const defaultModel = defaultModelFromProviderModels(value.models);
    return Boolean(apiKey || baseUrl || defaultModel);
  });

  const [providerKey, providerValue] = firstConfigured ?? [];
  if (!providerKey || !providerValue || !isRecord(providerValue)) {
    return {
      ...EMPTY_CONNECTION,
      checked: true,
      rawStdout: response.stdout,
      rawStderr: response.stderr,
    };
  }

  const providerName = toText(providerValue.providerName).trim() || providerKey;
  const baseUrl = toText(providerValue.baseUrl).trim();
  const api = toText(providerValue.api).trim();
  const defaultModel = defaultModelFromProviderModels(providerValue.models);

  return {
    checked: true,
    connected: true,
    providerName,
    baseUrl,
    api,
    defaultModel,
    rawStdout: response.stdout,
    rawStderr: response.stderr,
  };
}

function isLaunchReady(snapshot: LaunchSnapshot): boolean {
  return snapshot.serviceReady === true && snapshot.localReady === true && snapshot.appReady === true;
}

function nextBlockingStep(
  install: InstallSnapshot,
  connection: AiConnectionSnapshot,
  launch: LaunchSnapshot,
): StepId {
  if (!install.installed) {
    return "install";
  }
  if (!connection.connected) {
    return "model";
  }
  if (!isLaunchReady(launch)) {
    return "launch";
  }
  return "success";
}

function commandErrorDetail(response: CommandResponse): string {
  return firstNonEmpty(
    firstActionableDetailLine(response.stderr),
    firstActionableDetailLine(response.stdout),
    firstActionableDetailLine(response.message),
  );
}

function launchStatusValue(copy: Copy, value: boolean | null): string {
  if (value === true) {
    return copy.states.ready;
  }
  if (value === false) {
    return copy.states.attention;
  }
  return copy.states.waiting;
}

function launchStatusTone(value: boolean | null): RowTone {
  if (value === true) {
    return "ready";
  }
  if (value === false) {
    return "missing";
  }
  return "neutral";
}

function launchGuidance(snapshot: LaunchSnapshot, copy: Copy): string {
  if (snapshot.serviceReady === false) {
    return copy.launch.serviceHint;
  }
  if (snapshot.localReady === false) {
    return copy.launch.localHint;
  }
  if (snapshot.appReady === false) {
    return copy.launch.appHint;
  }
  return copy.launch.pendingBody;
}

function launchSummaryText(snapshot: LaunchSnapshot, copy: Copy): string {
  if (isLaunchReady(snapshot)) {
    return copy.launch.readySummary;
  }
  return firstNonEmpty(snapshot.summary, launchGuidance(snapshot, copy));
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: RowTone }) {
  return (
    <div className={`status-row status-row-${tone}`}>
      <span className="status-label">{label}</span>
      <strong className="status-value">{value}</strong>
    </div>
  );
}

function TechnicalDetails({ title, stdout, stderr }: { title: string; stdout: string; stderr: string }) {
  if (!stdout.trim() && !stderr.trim()) {
    return null;
  }

  return (
    <details className="technical-panel">
      <summary>{title}</summary>
      {stdout.trim() ? <pre>{stdout}</pre> : null}
      {stderr.trim() ? <pre>{stderr}</pre> : null}
    </details>
  );
}

function StageSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton-line skeleton-line-short" />
      <div className="skeleton-line skeleton-line-title" />
      <div className="skeleton-line" />
      <div className="skeleton-list">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </div>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale());
  const [currentStep, setCurrentStep] = useState<StepId>("welcome");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [installState, setInstallState] = useState<InstallSnapshot>(EMPTY_INSTALL);
  const [launchState, setLaunchState] = useState<LaunchSnapshot>(EMPTY_LAUNCH);
  const [aiConnection, setAiConnection] = useState<AiConnectionSnapshot>(EMPTY_CONNECTION);
  const [selectedPreset, setSelectedPreset] = useState<ServicePresetId>("openai");
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [selectedCompatibilityMode, setSelectedCompatibilityMode] = useState<CompatibilityModeId>("openai-completions");
  const [customCompatibilityValue, setCustomCompatibilityValue] = useState("");
  const [serviceForm, setServiceForm] = useState<ServiceFormState>(DEFAULT_FORM);

  const copy = useMemo(() => I18N[locale], [locale]);
  const launchReady = isLaunchReady(launchState);
  const currentMeta = copy.steps[currentStep];
  const currentStepIndex = STEP_ORDER.indexOf(currentStep);
  const progressPercent = `${((currentStepIndex + 1) / STEP_ORDER.length) * 100}%`;
  const connectedServiceLabel = aiConnection.connected
    ? serviceLabelForProvider(locale, aiConnection.providerName, aiConnection.baseUrl)
    : copy.states.waiting;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    if (!aiConnection.connected) {
      return;
    }

    const presetId = presetIdFromProvider(aiConnection.providerName, aiConnection.baseUrl);
    const preset = SERVICE_PRESETS[presetId];
    const nextApiSource = aiConnection.api || preset.api || DEFAULT_FORM.api;
    const nextCompatibilityMode = compatibilityModeIdFromValue(nextApiSource);
    const nextApi = nextCompatibilityMode === "custom"
      ? nextApiSource.trim()
      : COMPATIBILITY_MODE_OPTIONS[nextCompatibilityMode].value;

    setSelectedPreset(presetId);
    setShowAdvancedFields(presetId === "custom");
    setSelectedCompatibilityMode(nextCompatibilityMode);
    setCustomCompatibilityValue(nextCompatibilityMode === "custom" ? nextApiSource.trim() : "");
    setServiceForm((current) => ({
      providerName: aiConnection.providerName || preset.providerName,
      baseUrl: aiConnection.baseUrl || preset.baseUrl,
      api: nextApi,
      defaultModel: aiConnection.defaultModel || preset.defaultModel,
      apiKey: current.apiKey,
    }));
  }, [aiConnection.api, aiConnection.baseUrl, aiConnection.connected, aiConnection.defaultModel, aiConnection.providerName]);

  async function readSnapshots(): Promise<SnapshotBundle> {
    const installResponse = await detectOpenclaw();
    const installSnapshot = parseInstallResponse(installResponse);

    let launchSnapshot = EMPTY_LAUNCH;
    let connectionSnapshot = EMPTY_CONNECTION;

    if (installSnapshot.installed) {
      const [launchResponse, connectionsResponse] = await Promise.all([getLaunchStatus(), readAiConnections()]);
      launchSnapshot = parseLaunchResponse(launchResponse);
      connectionSnapshot = parseAiConnectionResponse(connectionsResponse);
    }

    return {
      install: installSnapshot,
      launch: launchSnapshot,
      connection: connectionSnapshot,
    };
  }

  function applySnapshots(snapshots: SnapshotBundle) {
    setInstallState(snapshots.install);
    setLaunchState(snapshots.launch);
    setAiConnection(snapshots.connection);
  }

  async function syncState(routeToBlockingStep: boolean, options: { announce?: boolean } = {}) {
    const announce = options.announce ?? !routeToBlockingStep;

    setBootstrapping(true);
    if (announce) {
      setBusyAction("check");
      setNotice({ kind: "info", text: copy.notices.checking });
    }

    const snapshots = await readSnapshots();
    applySnapshots(snapshots);

    setBootstrapping(false);
    setBusyAction(null);

    if (routeToBlockingStep) {
      setCurrentStep(nextBlockingStep(snapshots.install, snapshots.connection, snapshots.launch));
    } else if (announce) {
      setNotice({ kind: "success", text: copy.notices.checked });
    }

    return snapshots;
  }

  function handleWelcomeContinue() {
    setCurrentStep("install");
    void syncState(false);
  }

  function handleBack() {
    const index = STEP_ORDER.indexOf(currentStep);
    if (index > 0) {
      setCurrentStep(STEP_ORDER[index - 1]);
    }
  }

  function handlePresetSelect(presetId: ServicePresetId) {
    const preset = SERVICE_PRESETS[presetId];
    const nextApi = preset.api || DEFAULT_FORM.api;
    const nextCompatibilityMode = compatibilityModeIdFromValue(nextApi);

    setSelectedPreset(presetId);
    setShowAdvancedFields(presetId === "custom");
    setSelectedCompatibilityMode(nextCompatibilityMode);
    setCustomCompatibilityValue(nextCompatibilityMode === "custom" ? nextApi : "");
    setServiceForm((current) => ({
      providerName: preset.providerName,
      baseUrl: preset.baseUrl,
      api: nextApi,
      defaultModel: preset.defaultModel,
      apiKey: current.apiKey,
    }));
  }

  function handleCompatibilityModeChange(modeId: CompatibilityModeId) {
    setSelectedCompatibilityMode(modeId);

    if (modeId === "custom") {
      setServiceForm((current) => ({ ...current, api: customCompatibilityValue }));
      return;
    }

    setServiceForm((current) => ({ ...current, api: COMPATIBILITY_MODE_OPTIONS[modeId].value }));
  }

  async function handleInstall() {
    setBusyAction("install");
    const response = await installOpenclaw();

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.installSuccess });
      await syncState(true, { announce: false });
      return;
    }

    setBusyAction(null);
    setNotice({ kind: "error", text: mergeNoticeText(copy.notices.installFailed, commandErrorDetail(response)) });
  }

  async function handleConnectAi() {
    const compatibilityValue = selectedCompatibilityMode === "custom"
      ? customCompatibilityValue.trim()
      : COMPATIBILITY_MODE_OPTIONS[selectedCompatibilityMode].value;

    if (!serviceForm.apiKey.trim()) {
      setNotice({ kind: "error", text: copy.notices.keyRequired });
      return;
    }

    if (selectedPreset === "custom" && (!serviceForm.baseUrl.trim() || !compatibilityValue || !serviceForm.defaultModel.trim())) {
      setNotice({ kind: "error", text: copy.notices.customRequired });
      return;
    }

    setBusyAction("connect");
    const response = await saveAiConnection({
      providerName: serviceForm.providerName,
      baseUrl: serviceForm.baseUrl,
      apiKey: serviceForm.apiKey,
      api: compatibilityValue,
      defaultModel: serviceForm.defaultModel,
    });

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.connectSuccess });
      setServiceForm((current) => ({ ...current, apiKey: "" }));
      await syncState(true, { announce: false });
      return;
    }

    setBusyAction(null);
    setNotice({ kind: "error", text: mergeNoticeText(copy.notices.connectFailed, commandErrorDetail(response)) });
  }

  async function handleLaunch() {
    setBusyAction("launch");
    const response = await launchOpenclaw();
    const snapshots = await syncState(true, { announce: false });
    const detail = commandErrorDetail(response);
    const launchDetail = launchSummaryText(snapshots.launch, copy);

    if (isLaunchReady(snapshots.launch)) {
      const recoveredDetail = response.success || isTransientGatewayDetail(detail) ? "" : detail;
      setNotice({
        kind: "success",
        text: response.success ? copy.notices.launchSuccess : mergeNoticeText(copy.notices.launchRecovered, recoveredDetail),
      });
      return;
    }

    if (response.success) {
      setNotice({ kind: "info", text: mergeNoticeText(copy.notices.launchIncomplete, launchDetail) });
      return;
    }

    setNotice({ kind: "error", text: mergeNoticeText(copy.notices.launchFailed, detail, launchDetail) });
  }

  async function handleStartUsing() {
    setBusyAction("enter");
    const response = await openOpenclawHome();

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.openSuccess });
    } else {
      setNotice({ kind: "error", text: mergeNoticeText(copy.notices.openFailed, commandErrorDetail(response)) });
    }

    setBusyAction(null);
  }

  const canSkipSavingAi = aiConnection.connected && !serviceForm.apiKey.trim();

  function renderStage() {
    if (bootstrapping) {
      return <StageSkeleton />;
    }

    if (currentStep === "welcome") {
      return (
        <>
          <div className="stage-intro">
            <h1>{copy.welcome.title}</h1>
            <p className="lead">{copy.welcome.body}</p>
          </div>

          <div className="form-stack">
            <label className="field">
              <span>{copy.welcome.languageTitle}</span>
              <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English</option>
              </select>
              <small>{copy.welcome.languageBody}</small>
            </label>
          </div>

          <div className="action-row action-row-single">
            <button type="button" className="button button-primary button-large" onClick={handleWelcomeContinue}>
              {copy.actions.continue}
            </button>
          </div>
        </>
      );
    }

    if (currentStep === "install") {
      return (
        <>
          <div className="stage-intro">
            <h1>{copy.install.title}</h1>
            <p className="lead">{copy.install.body}</p>
          </div>

          <p className="stage-note">{installState.installed ? copy.install.detectedBody : copy.install.missingBody}</p>

          <div className="status-list">
            <StatusRow
              label={copy.install.versionLabel}
              value={installState.version || copy.install.emptyVersion}
              tone={installState.version ? "ready" : "neutral"}
            />
            <StatusRow
              label={copy.install.locationLabel}
              value={installState.installDir || copy.install.emptyLocation}
              tone={installState.installDir ? "ready" : "neutral"}
            />
          </div>

          <TechnicalDetails title={copy.technicalDetails} stdout={installState.rawStdout} stderr={installState.rawStderr} />

          <div className="action-row">
            <button type="button" className="button button-secondary" onClick={handleBack}>
              {copy.actions.back}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void syncState(false)}
              disabled={busyAction === "check"}
            >
              {busyAction === "check" ? copy.actions.checking : copy.actions.checkAgain}
            </button>
            <button
              type="button"
              className="button button-primary button-large"
              onClick={installState.installed ? () => setCurrentStep("model") : () => void handleInstall()}
              disabled={busyAction === "install"}
            >
              {installState.installed ? copy.actions.continue : busyAction === "install" ? copy.actions.installing : copy.actions.install}
            </button>
          </div>
        </>
      );
    }

    if (currentStep === "model") {
      return (
        <>
          <div className="stage-intro">
            <h1>{copy.model.title}</h1>
            <p className="lead">{copy.model.body}</p>
          </div>

          <p className="stage-note">{aiConnection.connected ? copy.model.connectedBody : copy.model.emptyBody}</p>

          <div className="status-list">
            <StatusRow label={copy.model.currentLabel} value={connectedServiceLabel} tone={aiConnection.connected ? "ready" : "missing"} />
          </div>

          <div className="option-grid option-grid-services">
            {(Object.entries(SERVICE_PRESETS) as Array<[ServicePresetId, ServicePreset]>).map(([presetId, preset]) => (
              <button
                key={presetId}
                type="button"
                className={`choice-card ${selectedPreset === presetId ? "choice-card-active" : ""}`}
                onClick={() => handlePresetSelect(presetId)}
              >
                <strong>{preset.label[locale]}</strong>
                <span>{preset.hint[locale]}</span>
              </button>
            ))}
          </div>

          <div className="form-stack">
            <label className="field">
              <span>{copy.model.accessKeyLabel}</span>
              <input
                type="password"
                value={serviceForm.apiKey}
                placeholder="sk-..."
                onChange={(event) => setServiceForm((current) => ({ ...current, apiKey: event.target.value }))}
              />
              <small>{copy.model.accessKeyHint}</small>
            </label>

            <div className="inline-bar">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowAdvancedFields((current) => !current)}
              >
                {showAdvancedFields ? copy.actions.hideAdvanced : copy.actions.showAdvanced}
              </button>
              <span className="helper-copy">{copy.model.advancedHint}</span>
            </div>

            {showAdvancedFields ? (
              <div className="form-stack form-stack-tight">
                <label className="field">
                  <span>{copy.model.baseUrlLabel}</span>
                  <input
                    type="text"
                    value={serviceForm.baseUrl}
                    onChange={(event) => setServiceForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{copy.model.apiLabel}</span>
                  <select value={selectedCompatibilityMode} onChange={(event) => handleCompatibilityModeChange(event.target.value as CompatibilityModeId)}>
                    {(Object.entries(COMPATIBILITY_MODE_OPTIONS) as Array<[CompatibilityModeId, CompatibilityModeOption]>).map(([modeId, option]) => (
                      <option key={modeId} value={modeId}>
                        {option.label[locale]}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedCompatibilityMode === "custom" ? (
                  <label className="field">
                    <span>{copy.model.customApiLabel}</span>
                    <input
                      type="text"
                      value={customCompatibilityValue}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setCustomCompatibilityValue(nextValue);
                        setServiceForm((current) => ({ ...current, api: nextValue }));
                      }}
                    />
                    <small>{copy.model.customApiHint}</small>
                  </label>
                ) : null}
                <label className="field">
                  <span>{copy.model.modelLabel}</span>
                  <input
                    type="text"
                    value={serviceForm.defaultModel}
                    onChange={(event) => setServiceForm((current) => ({ ...current, defaultModel: event.target.value }))}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <TechnicalDetails title={copy.technicalDetails} stdout={aiConnection.rawStdout} stderr={aiConnection.rawStderr} />

          <div className="action-row">
            <button type="button" className="button button-secondary" onClick={handleBack}>
              {copy.actions.back}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void syncState(false)}
              disabled={busyAction === "check"}
            >
              {busyAction === "check" ? copy.actions.checking : copy.actions.checkAgain}
            </button>
            <button
              type="button"
              className="button button-primary button-large"
              onClick={canSkipSavingAi ? () => setCurrentStep("launch") : () => void handleConnectAi()}
              disabled={busyAction === "connect" || !installState.installed}
            >
              {canSkipSavingAi ? copy.actions.continue : busyAction === "connect" ? copy.actions.connecting : copy.actions.connect}
            </button>
          </div>
        </>
      );
    }

    if (currentStep === "launch") {
      return (
        <>
          <div className="stage-intro">
            <h1>{copy.launch.title}</h1>
            <p className="lead">{copy.launch.body}</p>
          </div>

          <p className="stage-note">{launchSummaryText(launchState, copy)}</p>

          <div className="status-list">
            <StatusRow
              label={copy.launch.cards.service}
              value={launchStatusValue(copy, launchState.serviceReady)}
              tone={launchStatusTone(launchState.serviceReady)}
            />
            <StatusRow
              label={copy.launch.cards.local}
              value={launchStatusValue(copy, launchState.localReady)}
              tone={launchStatusTone(launchState.localReady)}
            />
            <StatusRow
              label={copy.launch.cards.app}
              value={launchStatusValue(copy, launchState.appReady)}
              tone={launchStatusTone(launchState.appReady)}
            />
          </div>

          <TechnicalDetails title={copy.technicalDetails} stdout={launchState.rawStdout} stderr={launchState.rawStderr} />

          <div className="action-row">
            <button type="button" className="button button-secondary" onClick={handleBack}>
              {copy.actions.back}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void syncState(false)}
              disabled={busyAction === "check"}
            >
              {busyAction === "check" ? copy.actions.checking : copy.actions.checkAgain}
            </button>
            <button
              type="button"
              className="button button-primary button-large"
              onClick={launchReady ? () => setCurrentStep("success") : () => void handleLaunch()}
              disabled={busyAction === "launch" || !installState.installed || !aiConnection.connected}
            >
              {launchReady ? copy.actions.continue : busyAction === "launch" ? copy.actions.launching : copy.actions.launch}
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <div className="stage-intro">
          <h1>{copy.success.title}</h1>
          <p className="lead">{copy.success.body}</p>
        </div>

        <div className="status-list">
          <StatusRow label={copy.success.summary.install} value={copy.states.ready} tone="ready" />
          <StatusRow label={copy.success.summary.ai} value={copy.states.ready} tone="ready" />
          <StatusRow label={copy.success.summary.launch} value={copy.states.ready} tone="ready" />
        </div>

        <p className="helper-copy">{copy.success.laterNote}</p>

        <div className="action-row">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void syncState(false)}
            disabled={busyAction === "check"}
          >
            {busyAction === "check" ? copy.actions.checking : copy.actions.checkAgain}
          </button>
          <button
            type="button"
            className="button button-primary button-large"
            onClick={() => void handleStartUsing()}
            disabled={busyAction === "enter"}
          >
            {busyAction === "enter" ? copy.actions.starting : copy.actions.startUsing}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="installer-shell">
      <main className="installer-stage">
        <header className="topbar">
          <div className="brand-lockup">
            <span className="brand-name">{copy.brand}</span>
            <span className="brand-subtitle">{copy.badge}</span>
          </div>
        </header>

        <div className="stage-meta">
          <span className="step-badge">{currentMeta.label}</span>
          <div className="progress-track" aria-hidden="true">
            <span className="progress-fill" style={{ width: progressPercent }} />
          </div>
        </div>

        {notice ? <div className={`notice notice-${notice.kind}`}>{notice.text}</div> : null}

        <section className="stage-card">{renderStage()}</section>

        <p className="support-copy">{copy.previewHint}</p>
      </main>
    </div>
  );
}
