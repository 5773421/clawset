import { useEffect, useMemo, useState } from "react";
import {
  detectOpenclaw,
  gatewayStatus as getLaunchStatus,
  installOpenclaw,
  openDashboard as openOpenclawHome,
  readOpenclawProviders as readAiConnections,
  runOpenclawOnboard,
  writeOpenclawProvider as saveAiConnection,
} from "./lib/tauri";
import type { CommandResponse } from "./types";

type Locale = "zh-CN" | "en-US";
type StepId = "welcome" | "install" | "model" | "launch" | "success";
type BusyAction = "check" | "install" | "connect" | "launch" | "enter" | null;
type NoticeKind = "info" | "success" | "error";
type ServicePresetId = "openai" | "kimi" | "glm" | "openrouter" | "custom";

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
  serviceLabel: string;
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

interface ServiceFormState {
  providerName: string;
  baseUrl: string;
  api: string;
  defaultModel: string;
  apiKey: string;
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
  serviceLabel: "",
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
  api: "openai",
  defaultModel: "gpt-4o-mini",
  apiKey: "",
};

const SERVICE_PRESETS: Record<ServicePresetId, ServicePreset> = {
  openai: {
    providerName: "openai",
    baseUrl: "https://api.openai.com/v1",
    api: "openai",
    defaultModel: "gpt-4o-mini",
    label: { "zh-CN": "OpenAI", "en-US": "OpenAI" },
    hint: {
      "zh-CN": "最直接的方式，通常只需要粘贴访问密钥。",
      "en-US": "The most direct option. Most people only need the access key.",
    },
  },
  kimi: {
    providerName: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai",
    defaultModel: "moonshot-v1-8k",
    label: { "zh-CN": "Kimi", "en-US": "Kimi" },
    hint: {
      "zh-CN": "适合 Kimi / Moonshot 用户，常见值已预填。",
      "en-US": "Good for Kimi / Moonshot users, with common defaults prefilled.",
    },
  },
  glm: {
    providerName: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai",
    defaultModel: "glm-4-flash",
    label: { "zh-CN": "GLM", "en-US": "GLM" },
    hint: {
      "zh-CN": "适合 GLM 用户，默认值覆盖常见场景。",
      "en-US": "Good for GLM users. The defaults cover the common setup path.",
    },
  },
  openrouter: {
    providerName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai",
    defaultModel: "openai/gpt-4o-mini",
    label: { "zh-CN": "OpenRouter", "en-US": "OpenRouter" },
    hint: {
      "zh-CN": "适合想先试多个模型服务的人。",
      "en-US": "Useful if you want one connection that can reach many models.",
    },
  },
  custom: {
    providerName: "custom",
    baseUrl: "",
    api: "",
    defaultModel: "",
    label: { "zh-CN": "其他兼容服务", "en-US": "Other compatible service" },
    hint: {
      "zh-CN": "只有在你需要自定义地址时才展开高级项。",
      "en-US": "Use this only when you need a custom compatible endpoint.",
    },
  },
};

const I18N = {
  "zh-CN": {
    brand: "Clawset Desktop",
    badge: "OpenClaw 安装助手",
    progressTitle: "安装主路径",
    progressBody: "只保留普通用户真正需要走完的 5 步：装上 OpenClaw、连上 AI、启动服务、开始使用。",
    currentStepLabel: "当前步骤",
    languageLabel: "语言",
    lastCheckedLabel: "最近同步",
    neverChecked: "尚未同步",
    technicalDetails: "查看技术详情",
    previewHint: "浏览器预览模式只能看界面。真正安装、初始化和配置写入需要在 Tauri 桌面环境中执行。",
    optionalTitle: "后续再做",
    optionalIntro: "这些能力不再挡在首次安装主路径前面。",
    optionalItems: ["聊天渠道接入", "更细的高级选项", "排查用技术详情"],
    states: {
      current: "当前",
      done: "完成",
      later: "稍后",
      ready: "已就绪",
      waiting: "待完成",
    },
    actions: {
      back: "上一步",
      continue: "继续",
      checkAgain: "重新同步",
      checking: "同步中...",
      install: "安装 OpenClaw",
      installing: "安装中...",
      connect: "保存并继续",
      connecting: "连接中...",
      showAdvanced: "显示高级项",
      hideAdvanced: "收起高级项",
      launch: "启动并完成初始化",
      launching: "启动中...",
      startUsing: "开始使用 OpenClaw",
      starting: "打开中...",
    },
    notices: {
      checking: "正在同步当前安装状态...",
      checked: "状态已同步。",
      installSuccess: "OpenClaw 已安装完成。",
      installFailed: "OpenClaw 安装未完成。",
      connectSuccess: "AI 服务已连接。",
      connectFailed: "AI 服务连接失败。",
      keyRequired: "请先填写访问密钥。",
      customRequired: "请补全服务地址、兼容模式和默认模型。",
      launchSuccess: "OpenClaw 已完成启动与初始化。",
      launchFailed: "OpenClaw 启动或初始化失败。",
      openSuccess: "正在打开 OpenClaw。",
      openFailed: "未能打开 OpenClaw。",
    },
    steps: {
      welcome: {
        label: "步骤 1 / 5",
        title: "选择语言",
        description: "先选语言，然后开始安装。",
      },
      install: {
        label: "步骤 2 / 5",
        title: "安装 OpenClaw",
        description: "如果还没装好，这一步直接完成安装。",
      },
      model: {
        label: "步骤 3 / 5",
        title: "连接 AI 服务",
        description: "连接一个你已经有权限使用的服务。",
      },
      launch: {
        label: "步骤 4 / 5",
        title: "启动并完成初始化",
        description: "把首次使用必须的启动动作一次做完。",
      },
      success: {
        label: "步骤 5 / 5",
        title: "完成 / 开始使用",
        description: "现在可以直接进入 OpenClaw。",
      },
    },
    welcome: {
      eyebrow: "为普通用户重做的安装器",
      title: "跟着这几步，装完就能开始使用 OpenClaw。",
      body: "这个界面不再先展示设置中心、控制台或诊断面板，而是只带你完成真正必要的首次安装路径。",
      languageTitle: "选择界面语言",
      languageBody: "后续按钮、说明和引导都会切换到你选择的语言。",
      chinese: "简体中文",
      chineseHint: "安装说明、错误提示和按钮都使用简体中文。",
      english: "English",
      englishHint: "Buttons, guidance, and errors will use English.",
      promiseTitle: "接下来会帮你完成",
      promiseItems: ["检查是否已经装好 OpenClaw", "连接一个 AI 服务", "启动并完成首次初始化"],
    },
    install: {
      title: "先把 OpenClaw 装好",
      body: "这一步会先确认这台电脑上是否已经安装 OpenClaw。如果没有，点击按钮后应用会替你完成安装。",
      detectedTitle: "这台电脑已经装有 OpenClaw",
      detectedBody: "已检测到可用安装，你可以直接继续下一步。",
      missingTitle: "还没有检测到 OpenClaw",
      missingBody: "点击下方按钮后，安装器会自动完成安装，然后重新同步状态。",
      versionLabel: "当前版本",
      locationLabel: "安装位置",
      emptyVersion: "尚未检测到",
      emptyLocation: "安装完成后会显示",
    },
    model: {
      title: "连接一个 AI 服务",
      body: "为了让 OpenClaw 真正可用，这里需要连接一个你已有权限使用的 AI 服务。大多数人只需要选服务并填写访问密钥。",
      connectedTitle: "当前可用连接",
      connectedBody: "如果你已经连好服务，可以直接继续。想换服务或更新密钥，也可以在这里重新保存。",
      emptyTitle: "还没有可用的 AI 连接",
      emptyBody: "完成这一步后，OpenClaw 才能真正开始工作。",
      commonTitle: "常见服务",
      accessKeyLabel: "访问密钥",
      accessKeyHint: "通常这里只需要填这一个字段。",
      advancedHint: "只有在你使用兼容地址或自定义服务时，才需要展开高级项。",
      baseUrlLabel: "服务地址",
      apiLabel: "兼容模式",
      modelLabel: "默认模型",
    },
    launch: {
      title: "启动 OpenClaw 并完成首次初始化",
      body: "这一步会把首次使用必须的启动动作一次完成。你不需要手动输入命令。",
      cards: {
        service: "OpenClaw 服务",
        local: "本地连接",
        app: "桌面应用连接",
      },
      readyTitle: "启动所需内容已经就绪",
      readyBody: "可以直接进入最后一步。",
      pendingTitle: "还差最后一次启动",
      pendingBody: "点击下面按钮，应用会自动完成启动和首次初始化。",
    },
    success: {
      title: "OpenClaw 已经可以使用",
      body: "安装、AI 连接和启动初始化都已完成。现在可以直接进入 OpenClaw。",
      summary: {
        install: "OpenClaw 已安装",
        ai: "AI 服务已连接",
        launch: "首次启动已完成",
      },
      nextTitle: "可选下一步",
      nextBody: "聊天渠道不再阻塞首次可用闭环。你可以稍后在 OpenClaw 里再接入。",
      nextCards: {
        telegram: "Telegram：后续按需接入",
        feishu: "Feishu：后续按需接入",
        advanced: "更多高级选项：以后再调",
      },
    },
  },
  "en-US": {
    brand: "Clawset Desktop",
    badge: "OpenClaw setup assistant",
    progressTitle: "Setup path",
    progressBody: "Only the five steps a normal user really needs: install OpenClaw, connect AI, start the service, and begin using it.",
    currentStepLabel: "Current step",
    languageLabel: "Language",
    lastCheckedLabel: "Last synced",
    neverChecked: "Not synced yet",
    technicalDetails: "View technical details",
    previewHint: "Browser preview only shows the UI. Real install, initialization, and config writes need the Tauri desktop runtime.",
    optionalTitle: "Later, not now",
    optionalIntro: "These no longer block the first-run path.",
    optionalItems: ["Chat channel connections", "More advanced options", "Technical troubleshooting details"],
    states: {
      current: "Current",
      done: "Done",
      later: "Later",
      ready: "Ready",
      waiting: "Waiting",
    },
    actions: {
      back: "Back",
      continue: "Continue",
      checkAgain: "Sync again",
      checking: "Syncing...",
      install: "Install OpenClaw",
      installing: "Installing...",
      connect: "Save and continue",
      connecting: "Connecting...",
      showAdvanced: "Show advanced fields",
      hideAdvanced: "Hide advanced fields",
      launch: "Start and finish setup",
      launching: "Starting...",
      startUsing: "Start using OpenClaw",
      starting: "Opening...",
    },
    notices: {
      checking: "Syncing the current setup state...",
      checked: "The latest state is synced.",
      installSuccess: "OpenClaw is installed.",
      installFailed: "OpenClaw installation did not finish.",
      connectSuccess: "The AI service is connected.",
      connectFailed: "The AI service could not be connected.",
      keyRequired: "Please paste an access key first.",
      customRequired: "Please complete the service URL, compatibility mode, and default model.",
      launchSuccess: "OpenClaw finished startup and first-time initialization.",
      launchFailed: "OpenClaw could not finish startup or initialization.",
      openSuccess: "Opening OpenClaw.",
      openFailed: "Could not open OpenClaw.",
    },
    steps: {
      welcome: {
        label: "Step 1 / 5",
        title: "Choose language",
        description: "Pick a language, then start setup.",
      },
      install: {
        label: "Step 2 / 5",
        title: "Install OpenClaw",
        description: "If it is not installed yet, this step handles it.",
      },
      model: {
        label: "Step 3 / 5",
        title: "Connect AI service",
        description: "Connect one service you already have access to.",
      },
      launch: {
        label: "Step 4 / 5",
        title: "Start and finish setup",
        description: "Complete the startup work needed for first use.",
      },
      success: {
        label: "Step 5 / 5",
        title: "Done / Start using",
        description: "You can now go straight into OpenClaw.",
      },
    },
    welcome: {
      eyebrow: "An installer rebuilt for normal users",
      title: "Follow these steps and start using OpenClaw right after setup.",
      body: "This UI no longer starts with a settings center, control console, or diagnostic panel. It only walks you through the first-run path that actually matters.",
      languageTitle: "Choose your language",
      languageBody: "All buttons, guidance, and setup text switch to the language you choose.",
      chinese: "简体中文",
      chineseHint: "Setup guidance, errors, and buttons use Simplified Chinese.",
      english: "English",
      englishHint: "Buttons, guidance, and errors use English.",
      promiseTitle: "This assistant will help you",
      promiseItems: ["Check whether OpenClaw is already installed", "Connect one AI service", "Start OpenClaw and finish first-time setup"],
    },
    install: {
      title: "Get OpenClaw installed first",
      body: "This step first checks whether OpenClaw is already on this computer. If not, use the button below and the app installs it for you.",
      detectedTitle: "OpenClaw is already on this computer",
      detectedBody: "A usable installation is already detected, so you can move on.",
      missingTitle: "OpenClaw is not detected yet",
      missingBody: "Use the button below and the installer will complete the installation, then sync the result again automatically.",
      versionLabel: "Current version",
      locationLabel: "Install location",
      emptyVersion: "Not detected yet",
      emptyLocation: "Shown after install",
    },
    model: {
      title: "Connect one AI service",
      body: "To make OpenClaw actually usable, this step connects one AI service you already have access to. Most people only need to choose a service and paste an access key.",
      connectedTitle: "Current usable connection",
      connectedBody: "If a service is already connected, you can continue. If you want to switch services or update the key, save a new one here.",
      emptyTitle: "No usable AI connection yet",
      emptyBody: "OpenClaw is not truly ready until this step is done.",
      commonTitle: "Common services",
      accessKeyLabel: "Access key",
      accessKeyHint: "Usually this is the only field you need to fill in manually.",
      advancedHint: "Only expand the advanced fields if you use a compatible custom endpoint.",
      baseUrlLabel: "Service URL",
      apiLabel: "Compatibility mode",
      modelLabel: "Default model",
    },
    launch: {
      title: "Start OpenClaw and finish first-time setup",
      body: "This step completes the startup work needed before normal first use. You do not need to type commands manually.",
      cards: {
        service: "OpenClaw service",
        local: "Local connection",
        app: "Desktop app connection",
      },
      readyTitle: "Everything needed for startup looks ready",
      readyBody: "You can go straight to the last step.",
      pendingTitle: "One final startup step remains",
      pendingBody: "Use the button below and the app finishes startup and first-time initialization for you.",
    },
    success: {
      title: "OpenClaw is ready to use",
      body: "Installation, AI connection, and first startup are all complete. You can go straight into OpenClaw now.",
      summary: {
        install: "OpenClaw is installed",
        ai: "AI service is connected",
        launch: "First startup is complete",
      },
      nextTitle: "Optional next steps",
      nextBody: "Chat channels no longer block the first usable setup loop. You can add them later inside OpenClaw.",
      nextCards: {
        telegram: "Telegram: add later if needed",
        feishu: "Feishu: add later if needed",
        advanced: "More advanced options: tune later",
      },
    },
  },
} as const;

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
  if (["true", "running", "active", "started", "ready", "healthy", "ok", "connected", "listening", "up"].includes(normalized)) {
    return true;
  }
  if (["false", "stopped", "inactive", "failed", "error", "down", "disconnected", "not connected", "offline"].includes(normalized)) {
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
  const rawText = [response.message, response.stdout, response.stderr].join("\n").toLowerCase();

  let serviceReady = inferSignal(
    signals,
    ["daemon"],
    ["installed", "running", "active", "ready", "ok"],
    ["missing", "failed", "error", "stopped", "not installed"],
  );
  let localReady = inferSignal(
    signals,
    ["gateway", "listen", "server", "port", "http"],
    ["listening", "running", "active", "online", "ready", "up"],
    ["not listening", "stopped", "failed", "offline", "down"],
  );
  let appReady = inferSignal(
    signals,
    ["rpc"],
    ["connected", "ready", "available", "ok"],
    ["not connected", "disconnected", "failed", "timeout", "error"],
  );

  if (serviceReady === null) {
    serviceReady = textHasToken(rawText, ["daemon ready", "daemon running", "daemon installed"])
      ? true
      : textHasToken(rawText, ["daemon missing", "daemon failed", "daemon error"])
        ? false
        : null;
  }

  if (localReady === null) {
    localReady = textHasToken(rawText, ["gateway running", "gateway started", "listening"])
      ? true
      : textHasToken(rawText, ["gateway failed", "not listening", "stopped"])
        ? false
        : null;
  }

  if (appReady === null) {
    appReady = textHasToken(rawText, ["rpc connected", "rpc ready", "rpc available"])
      ? true
      : textHasToken(rawText, ["rpc failed", "not connected", "disconnected"])
        ? false
        : null;
  }

  return {
    checked: true,
    serviceReady,
    localReady,
    appReady,
    summary: firstNonEmpty(firstLine(response.message), firstLine(response.stderr)),
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

function parseAiConnectionResponse(response: CommandResponse, locale: Locale): AiConnectionSnapshot {
  const parsed = isRecord(response.parsed_json) ? response.parsed_json : null;
  const providers = parsed ? Object.entries(parsed) : [];
  const firstConfigured = providers.find(([, value]) => {
    if (!isRecord(value)) {
      return false;
    }

    const apiKey = toText(value.apiKey).trim();
    const baseUrl = toText(value.baseUrl).trim();
    const models = isRecord(value.models) ? value.models : null;
    const defaultModel = models ? toText(models.default_model).trim() : "";
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

  const models = isRecord(providerValue.models) ? providerValue.models : null;
  const providerName = toText(providerValue.providerName).trim() || providerKey;
  const baseUrl = toText(providerValue.baseUrl).trim();
  const api = toText(providerValue.api).trim();
  const defaultModel = models ? toText(models.default_model).trim() : "";

  return {
    checked: true,
    connected: true,
    serviceLabel: serviceLabelForProvider(locale, providerName, baseUrl),
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
  return firstNonEmpty(firstLine(response.message), firstLine(response.stderr), firstLine(response.stdout));
}

function formatTimestamp(locale: Locale, value: string, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buttonLabel(
  busyAction: BusyAction,
  currentAction: Exclude<BusyAction, null>,
  idleLabel: string,
  busyLabel: string,
): string {
  return busyAction === currentAction ? busyLabel : idleLabel;
}

function hasTechnicalOutput(stdout: string, stderr: string): boolean {
  return Boolean(stdout.trim() || stderr.trim());
}

function StatusPill({ tone, text }: { tone: "current" | "done" | "later"; text: string }) {
  return <span className={`progress-state progress-state-${tone}`}>{text}</span>;
}

function InfoCard({ label, value, tone }: { label: string; value: string; tone: "ready" | "neutral" | "missing" }) {
  return (
    <div className={`info-card info-card-${tone}`}>
      <span className="info-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TechnicalDetails({ title, stdout, stderr }: { title: string; stdout: string; stderr: string }) {
  if (!hasTechnicalOutput(stdout, stderr)) {
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
      <div className="skeleton-grid">
        <div className="skeleton-card" />
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
  const [lastCheckedAt, setLastCheckedAt] = useState("");
  const [installState, setInstallState] = useState<InstallSnapshot>(EMPTY_INSTALL);
  const [launchState, setLaunchState] = useState<LaunchSnapshot>(EMPTY_LAUNCH);
  const [aiConnection, setAiConnection] = useState<AiConnectionSnapshot>(EMPTY_CONNECTION);
  const [selectedPreset, setSelectedPreset] = useState<ServicePresetId>("openai");
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [serviceForm, setServiceForm] = useState<ServiceFormState>(DEFAULT_FORM);

  const copy = useMemo(() => I18N[locale], [locale]);
  const launchReady = isLaunchReady(launchState);

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

    setSelectedPreset(presetId);
    setShowAdvancedFields(presetId === "custom");
    setServiceForm((current) => ({
      providerName: aiConnection.providerName || preset.providerName,
      baseUrl: aiConnection.baseUrl || preset.baseUrl,
      api: aiConnection.api || preset.api,
      defaultModel: aiConnection.defaultModel || preset.defaultModel,
      apiKey: current.apiKey,
    }));
  }, [aiConnection.api, aiConnection.baseUrl, aiConnection.connected, aiConnection.defaultModel, aiConnection.providerName]);

  const steps = STEP_ORDER.map((stepId, index) => {
    const done =
      stepId === "welcome"
        ? currentStep !== "welcome"
        : stepId === "install"
          ? installState.installed
          : stepId === "model"
            ? aiConnection.connected
            : stepId === "launch"
              ? launchReady
              : installState.installed && aiConnection.connected && launchReady;

    const tone = currentStep === stepId ? "current" : done ? "done" : "later";

    return {
      id: stepId,
      index: index + 1,
      label: copy.steps[stepId].label,
      title: copy.steps[stepId].title,
      description: copy.steps[stepId].description,
      tone,
    };
  });

  async function syncState(routeToBlockingStep: boolean) {
    setBootstrapping(true);
    if (!routeToBlockingStep) {
      setBusyAction("check");
      setNotice({ kind: "info", text: copy.notices.checking });
    }

    const installResponse = await detectOpenclaw();
    const installSnapshot = parseInstallResponse(installResponse);

    let launchSnapshot = EMPTY_LAUNCH;
    let connectionSnapshot = EMPTY_CONNECTION;

    if (installSnapshot.installed) {
      const [launchResponse, connectionsResponse] = await Promise.all([
        getLaunchStatus(),
        readAiConnections(),
      ]);
      launchSnapshot = parseLaunchResponse(launchResponse);
      connectionSnapshot = parseAiConnectionResponse(connectionsResponse, locale);
    }

    setInstallState(installSnapshot);
    setLaunchState(launchSnapshot);
    setAiConnection(connectionSnapshot);
    setLastCheckedAt(new Date().toISOString());
    setBootstrapping(false);
    setBusyAction(null);

    if (routeToBlockingStep) {
      setCurrentStep(nextBlockingStep(installSnapshot, connectionSnapshot, launchSnapshot));
      return;
    }

    setNotice({ kind: "success", text: copy.notices.checked });
  }

  function handleWelcomeContinue() {
    setCurrentStep("install");
    void syncState(false);
  }

  function handleBack() {
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (currentIndex > 0) {
      setCurrentStep(STEP_ORDER[currentIndex - 1]);
    }
  }

  function handlePresetSelect(presetId: ServicePresetId) {
    const preset = SERVICE_PRESETS[presetId];
    setSelectedPreset(presetId);
    setShowAdvancedFields(presetId === "custom");
    setServiceForm((current) => ({
      providerName: preset.providerName,
      baseUrl: preset.baseUrl,
      api: preset.api,
      defaultModel: preset.defaultModel,
      apiKey: current.apiKey,
    }));
  }

  async function handleInstall() {
    setBusyAction("install");
    const response = await installOpenclaw();

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.installSuccess });
      await syncState(true);
      return;
    }

    setBusyAction(null);
    setNotice({ kind: "error", text: [copy.notices.installFailed, commandErrorDetail(response)].filter(Boolean).join(" ") });
  }

  async function handleConnectAi() {
    if (!serviceForm.apiKey.trim()) {
      setNotice({ kind: "error", text: copy.notices.keyRequired });
      return;
    }

    if (
      selectedPreset === "custom" &&
      (!serviceForm.baseUrl.trim() || !serviceForm.api.trim() || !serviceForm.defaultModel.trim())
    ) {
      setNotice({ kind: "error", text: copy.notices.customRequired });
      return;
    }

    setBusyAction("connect");
    const response = await saveAiConnection({
      providerName: serviceForm.providerName,
      baseUrl: serviceForm.baseUrl,
      apiKey: serviceForm.apiKey,
      api: serviceForm.api,
      defaultModel: serviceForm.defaultModel,
    });

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.connectSuccess });
      setServiceForm((current) => ({ ...current, apiKey: "" }));
      await syncState(true);
      return;
    }

    setBusyAction(null);
    setNotice({ kind: "error", text: [copy.notices.connectFailed, commandErrorDetail(response)].filter(Boolean).join(" ") });
  }

  async function handleLaunch() {
    setBusyAction("launch");
    const response = await runOpenclawOnboard();

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.launchSuccess });
      await syncState(true);
      return;
    }

    setBusyAction(null);
    setNotice({ kind: "error", text: [copy.notices.launchFailed, commandErrorDetail(response)].filter(Boolean).join(" ") });
  }

  async function handleStartUsing() {
    setBusyAction("enter");
    const response = await openOpenclawHome();

    if (response.success) {
      setNotice({ kind: "success", text: copy.notices.openSuccess });
    } else {
      setNotice({ kind: "error", text: [copy.notices.openFailed, commandErrorDetail(response)].filter(Boolean).join(" ") });
    }

    setBusyAction(null);
  }

  const currentMeta = copy.steps[currentStep];
  const timeLabel = formatTimestamp(locale, lastCheckedAt, copy.neverChecked);
  const canSkipSavingAi = aiConnection.connected && !serviceForm.apiKey.trim();
  const completedCount = steps.filter((step) => step.tone === "done").length;
  const progressPercent = `${((STEP_ORDER.indexOf(currentStep) + 1) / STEP_ORDER.length) * 100}%`;

  return (
    <div className="installer-shell">
      <div className="installer-backdrop" aria-hidden="true">
        <span className="backdrop-orb backdrop-orb-primary" />
        <span className="backdrop-orb backdrop-orb-secondary" />
        <span className="backdrop-grid" />
      </div>

      <div className="installer-window">
        <div className="window-chrome">
          <div className="window-controls" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="window-title">{copy.brand}</div>
          <div className="window-status">{currentMeta.label}</div>
        </div>

        <div className="installer-frame">
          <aside className="progress-pane">
            <div className="surface hero-panel">
              <div className="brand-row">
                <span className="brand-mark" aria-hidden="true" />
                <div className="brand-copy">
                  <span className="brand-name">{copy.brand}</span>
                  <span className="brand-badge">{copy.badge}</span>
                </div>
              </div>

              <div className="hero-copy">
                <h1>{copy.progressTitle}</h1>
                <p>{copy.progressBody}</p>
              </div>

              <div className="hero-meta-grid">
                <div className="hero-meta-card">
                  <span className="metric-label">{copy.currentStepLabel}</span>
                  <strong>{currentMeta.title}</strong>
                  <span>{currentMeta.label}</span>
                </div>
                <div className="hero-meta-card">
                  <span className="metric-label">{copy.lastCheckedLabel}</span>
                  <strong>{timeLabel}</strong>
                  <span>
                    {completedCount} / {STEP_ORDER.length}
                  </span>
                </div>
              </div>
            </div>

            <div className="surface progress-panel">
              <div className="panel-heading panel-heading-compact">
                <div>
                  <span className="section-label">{copy.currentStepLabel}</span>
                  <strong>{currentMeta.title}</strong>
                </div>
                <span className="progress-fraction">
                  {STEP_ORDER.indexOf(currentStep) + 1}/{STEP_ORDER.length}
                </span>
              </div>

              <div className="progress-bar" aria-hidden="true">
                <span className="progress-bar-fill" style={{ width: progressPercent }} />
              </div>

              <div className="progress-list">
                {steps.map((step) => (
                  <div key={step.id} className={`progress-step progress-step-${step.tone}`}>
                    <div className="progress-index">{step.index}</div>
                    <div className="progress-copy">
                      <span className="progress-kicker">{step.label}</span>
                      <strong>{step.title}</strong>
                      <span>{step.description}</span>
                    </div>
                    <StatusPill
                      tone={step.tone as "current" | "done" | "later"}
                      text={
                        step.tone === "current"
                          ? copy.states.current
                          : step.tone === "done"
                            ? copy.states.done
                            : copy.states.later
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="surface aside-panel">
              <span className="section-label">{copy.optionalTitle}</span>
              <p className="aside-copy">{copy.optionalIntro}</p>
              <ul className="aside-list">
                {copy.optionalItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </aside>

          <main className="stage-pane">
            <header className="surface header-panel">
              <div className="header-copy">
                <span className="section-label">{currentMeta.label}</span>
                <h2>{currentMeta.title}</h2>
                <p className="header-summary">{currentMeta.description}</p>
              </div>

              <div className="header-tools">
                <label className="locale-field">
                  <span>{copy.languageLabel}</span>
                  <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                  </select>
                </label>

                <div className="timestamp-pill">
                  <span>{copy.lastCheckedLabel}</span>
                  <strong>{timeLabel}</strong>
                </div>
              </div>
            </header>

            {notice ? <div className={`notice notice-${notice.kind}`}>{notice.text}</div> : null}

            <section className="surface stage-card">
              {bootstrapping ? (
                <StageSkeleton />
              ) : currentStep === "welcome" ? (
                <div className="welcome-layout">
                  <div className="welcome-copy">
                    <span className="hero-label">{copy.welcome.eyebrow}</span>
                    <h3>{copy.welcome.title}</h3>
                    <p className="lead">{copy.welcome.body}</p>

                    <div className="soft-panel">
                      <div className="panel-heading">
                        <strong>{copy.welcome.promiseTitle}</strong>
                        <span>{copy.progressBody}</span>
                      </div>
                      <ul className="feature-list">
                        {copy.welcome.promiseItems.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="soft-panel language-panel">
                    <div className="panel-heading">
                      <strong>{copy.welcome.languageTitle}</strong>
                      <span>{copy.welcome.languageBody}</span>
                    </div>

                    <div className="language-grid">
                      <button
                        type="button"
                        className={`language-choice ${locale === "zh-CN" ? "language-choice-active" : ""}`}
                        onClick={() => setLocale("zh-CN")}
                      >
                        <strong>{copy.welcome.chinese}</strong>
                        <span>{copy.welcome.chineseHint}</span>
                      </button>
                      <button
                        type="button"
                        className={`language-choice ${locale === "en-US" ? "language-choice-active" : ""}`}
                        onClick={() => setLocale("en-US")}
                      >
                        <strong>{copy.welcome.english}</strong>
                        <span>{copy.welcome.englishHint}</span>
                      </button>
                    </div>

                    <div className="action-row action-row-single">
                      <button type="button" className="button button-primary button-large" onClick={handleWelcomeContinue}>
                        {copy.actions.continue}
                      </button>
                    </div>
                  </div>
                </div>
              ) : currentStep === "install" ? (
                <>
                  <span className="hero-label">{copy.steps.install.label}</span>
                  <h3>{copy.install.title}</h3>
                  <p className="lead">{copy.install.body}</p>

                  <div className="split-layout">
                    <div className="soft-panel">
                      <div className="panel-heading">
                        <strong>{installState.installed ? copy.install.detectedTitle : copy.install.missingTitle}</strong>
                        <span>{installState.installed ? copy.install.detectedBody : copy.install.missingBody}</span>
                      </div>
                    </div>

                    <div className="detail-grid">
                      <InfoCard
                        label={copy.install.versionLabel}
                        value={installState.version || copy.install.emptyVersion}
                        tone={installState.version ? "ready" : "neutral"}
                      />
                      <InfoCard
                        label={copy.install.locationLabel}
                        value={installState.installDir || copy.install.emptyLocation}
                        tone={installState.installDir ? "ready" : "neutral"}
                      />
                    </div>
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
                      {buttonLabel(busyAction, "check", copy.actions.checkAgain, copy.actions.checking)}
                    </button>
                    <button
                      type="button"
                      className="button button-primary button-large"
                      onClick={installState.installed ? () => setCurrentStep("model") : () => void handleInstall()}
                      disabled={busyAction === "install"}
                    >
                      {installState.installed
                        ? copy.actions.continue
                        : buttonLabel(busyAction, "install", copy.actions.install, copy.actions.installing)}
                    </button>
                  </div>
                </>
              ) : currentStep === "model" ? (
                <>
                  <span className="hero-label">{copy.steps.model.label}</span>
                  <h3>{copy.model.title}</h3>
                  <p className="lead">{copy.model.body}</p>

                  <div className="soft-panel status-panel">
                    <div className="panel-heading">
                      <strong>{aiConnection.connected ? copy.model.connectedTitle : copy.model.emptyTitle}</strong>
                      <span>{aiConnection.connected ? copy.model.connectedBody : copy.model.emptyBody}</span>
                    </div>
                    <div className="detail-grid detail-grid-single">
                      <InfoCard
                        label={copy.model.commonTitle}
                        value={aiConnection.connected ? aiConnection.serviceLabel : copy.states.waiting}
                        tone={aiConnection.connected ? "ready" : "missing"}
                      />
                    </div>
                  </div>

                  <div className="panel-heading standalone-heading">
                    <strong>{copy.model.commonTitle}</strong>
                    <span>{copy.model.body}</span>
                  </div>

                  <div className="service-grid">
                    {(Object.entries(SERVICE_PRESETS) as Array<[ServicePresetId, ServicePreset]>).map(([presetId, preset]) => (
                      <button
                        key={presetId}
                        type="button"
                        className={`service-card ${selectedPreset === presetId ? "service-card-active" : ""}`}
                        onClick={() => handlePresetSelect(presetId)}
                      >
                        <strong>{preset.label[locale]}</strong>
                        <span>{preset.hint[locale]}</span>
                      </button>
                    ))}
                  </div>

                  <div className="soft-panel form-panel">
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
                      <div className="detail-grid detail-grid-single">
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
                          <input
                            type="text"
                            value={serviceForm.api}
                            onChange={(event) => setServiceForm((current) => ({ ...current, api: event.target.value }))}
                          />
                        </label>
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
                      {buttonLabel(busyAction, "check", copy.actions.checkAgain, copy.actions.checking)}
                    </button>
                    <button
                      type="button"
                      className="button button-primary button-large"
                      onClick={canSkipSavingAi ? () => setCurrentStep("launch") : () => void handleConnectAi()}
                      disabled={busyAction === "connect" || !installState.installed}
                    >
                      {canSkipSavingAi
                        ? copy.actions.continue
                        : buttonLabel(busyAction, "connect", copy.actions.connect, copy.actions.connecting)}
                    </button>
                  </div>
                </>
              ) : currentStep === "launch" ? (
                <>
                  <span className="hero-label">{copy.steps.launch.label}</span>
                  <h3>{copy.launch.title}</h3>
                  <p className="lead">{copy.launch.body}</p>

                  <div className="detail-grid launch-grid">
                    <InfoCard
                      label={copy.launch.cards.service}
                      value={launchState.serviceReady ? copy.states.ready : copy.states.waiting}
                      tone={launchState.serviceReady ? "ready" : launchState.serviceReady === false ? "missing" : "neutral"}
                    />
                    <InfoCard
                      label={copy.launch.cards.local}
                      value={launchState.localReady ? copy.states.ready : copy.states.waiting}
                      tone={launchState.localReady ? "ready" : launchState.localReady === false ? "missing" : "neutral"}
                    />
                    <InfoCard
                      label={copy.launch.cards.app}
                      value={launchState.appReady ? copy.states.ready : copy.states.waiting}
                      tone={launchState.appReady ? "ready" : launchState.appReady === false ? "missing" : "neutral"}
                    />
                  </div>

                  <div className="soft-panel">
                    <div className="panel-heading">
                      <strong>{launchReady ? copy.launch.readyTitle : copy.launch.pendingTitle}</strong>
                      <span>{launchReady ? copy.launch.readyBody : copy.launch.pendingBody}</span>
                    </div>
                    {launchState.summary ? <p className="helper-copy">{launchState.summary}</p> : null}
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
                      {buttonLabel(busyAction, "check", copy.actions.checkAgain, copy.actions.checking)}
                    </button>
                    <button
                      type="button"
                      className="button button-primary button-large"
                      onClick={launchReady ? () => setCurrentStep("success") : () => void handleLaunch()}
                      disabled={busyAction === "launch" || !installState.installed || !aiConnection.connected}
                    >
                      {launchReady
                        ? copy.actions.continue
                        : buttonLabel(busyAction, "launch", copy.actions.launch, copy.actions.launching)}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="hero-label">{copy.steps.success.label}</span>
                  <h3>{copy.success.title}</h3>
                  <p className="lead">{copy.success.body}</p>

                  <div className="detail-grid launch-grid">
                    <InfoCard
                      label={copy.success.summary.install}
                      value={installState.installed ? copy.states.ready : copy.states.waiting}
                      tone={installState.installed ? "ready" : "missing"}
                    />
                    <InfoCard
                      label={copy.success.summary.ai}
                      value={aiConnection.connected ? copy.states.ready : copy.states.waiting}
                      tone={aiConnection.connected ? "ready" : "missing"}
                    />
                    <InfoCard
                      label={copy.success.summary.launch}
                      value={launchReady ? copy.states.ready : copy.states.waiting}
                      tone={launchReady ? "ready" : "missing"}
                    />
                  </div>

                  <div className="soft-panel">
                    <div className="panel-heading">
                      <strong>{copy.success.nextTitle}</strong>
                      <span>{copy.success.nextBody}</span>
                    </div>
                    <div className="detail-grid launch-grid">
                      <InfoCard label="Telegram" value={copy.success.nextCards.telegram} tone="neutral" />
                      <InfoCard label="Feishu" value={copy.success.nextCards.feishu} tone="neutral" />
                      <InfoCard label="Later" value={copy.success.nextCards.advanced} tone="neutral" />
                    </div>
                  </div>

                  <div className="action-row">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void syncState(false)}
                      disabled={busyAction === "check"}
                    >
                      {buttonLabel(busyAction, "check", copy.actions.checkAgain, copy.actions.checking)}
                    </button>
                    <button
                      type="button"
                      className="button button-primary button-large"
                      onClick={() => void handleStartUsing()}
                      disabled={busyAction === "enter"}
                    >
                      {buttonLabel(busyAction, "enter", copy.actions.startUsing, copy.actions.starting)}
                    </button>
                  </div>
                </>
              )}
            </section>

            <p className="footer-copy">{copy.previewHint}</p>
          </main>
        </div>
      </div>
    </div>
  );
}
