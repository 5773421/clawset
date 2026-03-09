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

interface GuidanceCard {
  key: RequiredCheckKey;
  title: string;
  problem: string;
  impact: string;
  action: string;
}

interface ChannelGuideContent {
  lead: string;
  prepare: string;
  afterSave: string;
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

type ProviderPresetId = "openai" | "anthropic" | "openrouter" | "kimi" | "glm" | "custom";

interface ProviderPresetDefinition {
  providerName: string;
  baseUrl: string;
  api: string;
  defaultModel: string;
  label: Record<Locale, string>;
  hint: Record<Locale, string>;
  keyHint: Record<Locale, string>;
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

const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPresetDefinition> = {
  openai: {
    providerName: "openai",
    baseUrl: "https://api.openai.com/v1",
    api: "openai",
    defaultModel: "gpt-4o-mini",
    label: {
      "zh-CN": "OpenAI",
      "en-US": "OpenAI",
    },
    hint: {
      "zh-CN": "适合直接使用 OpenAI 官方账号，默认按最常见路径预填。",
      "en-US": "Best when you want the direct OpenAI path with common defaults already filled.",
    },
    keyHint: {
      "zh-CN": "粘贴 OpenAI 访问密钥即可，其他底层参数通常不用改。",
      "en-US": "Paste your OpenAI API key. Most people can leave the lower-level fields alone.",
    },
  },
  anthropic: {
    providerName: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic",
    defaultModel: "claude-3-5-haiku-latest",
    label: {
      "zh-CN": "Anthropic",
      "en-US": "Anthropic",
    },
    hint: {
      "zh-CN": "适合已经在用 Claude API 的用户，默认走 Anthropic 官方接口。",
      "en-US": "Best for Claude users who already have an Anthropic API key.",
    },
    keyHint: {
      "zh-CN": "粘贴 Anthropic 访问密钥即可，默认模型和接口已代填。",
      "en-US": "Paste your Anthropic API key. The usual endpoint and model are already prefilled.",
    },
  },
  openrouter: {
    providerName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai",
    defaultModel: "openai/gpt-4o-mini",
    label: {
      "zh-CN": "OpenRouter",
      "en-US": "OpenRouter",
    },
    hint: {
      "zh-CN": "适合想先用一个入口切换多个模型的用户。",
      "en-US": "Useful when you want one entry point for many models.",
    },
    keyHint: {
      "zh-CN": "粘贴 OpenRouter 访问密钥即可，默认按兼容接口填写。",
      "en-US": "Paste your OpenRouter API key. The OpenAI-compatible defaults are already set.",
    },
  },
  kimi: {
    providerName: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai",
    defaultModel: "moonshot-v1-8k",
    label: {
      "zh-CN": "Kimi",
      "en-US": "Kimi",
    },
    hint: {
      "zh-CN": "适合 Kimi / Moonshot 用户，默认按常见兼容接口预填。",
      "en-US": "Best for Kimi / Moonshot users with the common compatible path prefilled.",
    },
    keyHint: {
      "zh-CN": "粘贴 Kimi 访问密钥即可，通常不用手动修改接口参数。",
      "en-US": "Paste your Kimi API key. Most users won’t need to touch endpoint details.",
    },
  },
  glm: {
    providerName: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai",
    defaultModel: "glm-4-flash",
    label: {
      "zh-CN": "GLM",
      "en-US": "GLM",
    },
    hint: {
      "zh-CN": "适合智谱 GLM 用户，默认按常见兼容接口预填。",
      "en-US": "Best for Zhipu GLM users with the common compatible path prefilled.",
    },
    keyHint: {
      "zh-CN": "粘贴 GLM 访问密钥即可，先按默认模型与协议即可。",
      "en-US": "Paste your GLM API key. The default model and protocol are already filled for the usual path.",
    },
  },
  custom: {
    providerName: "custom",
    baseUrl: "",
    api: "",
    defaultModel: "",
    label: {
      "zh-CN": "自定义",
      "en-US": "Custom",
    },
    hint: {
      "zh-CN": "适合兼容接口、中转地址或私有部署；需要你补全技术字段。",
      "en-US": "For compatible APIs, proxies, or self-hosted setups where you need to fill the technical details.",
    },
    keyHint: {
      "zh-CN": "可先填访问密钥；如果不是官方预设，还需要展开补全接口地址、协议和默认模型。",
      "en-US": "You can paste the API key first, then expand advanced fields to finish the endpoint, protocol, and model.",
    },
  },
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
    appSubtitle: "OpenClaw 首次设置",
    language: "语言",
    running: "执行中",
    lastUpdated: "最后刷新",
    noticeReady: "就绪",
    noticeRefreshing: "正在检查设置进度...",
    noticeRefreshed: "设置进度已刷新",
    noticeNeedInstall: "请先安装 OpenClaw。安装完成后，桌面端会重新检测环境。",
    noticeNeedProvider: "请先选择模型服务并保存访问密钥，这样 Onboard 才能真正连上模型。",
    noticeNeedRuntime: "请运行 Onboard 完成后台准备。",
    languageTitle: "选择语言",
    languageDescription: "首次使用请选择界面语言。默认简体中文，后续可随时切换。",
    languageConfirm: "继续",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "首次设置向导",
    onboardingDescription:
      "按这个顺序完成最省事：安装 OpenClaw → 选择模型服务 → 填访问密钥 → 运行 Onboard → 进入首页。聊天工具接入可稍后再配。",
    quickStartTitle: "最快开始",
    quickStartHint: "先把最短可用路径跑通，聊天工具接入和高级项都可以稍后补。",
    quickStartStepInstall: "安装 OpenClaw",
    quickStartStepProvider: "选择模型服务并填访问密钥",
    quickStartStepOnboard: "运行 Onboard",
    quickStartStepHome: "进入首页",
    quickStartOptional: "聊天工具接入不是首次完成设置的必需项。",
    onboardingProgress: "当前进度",
    onboardingMissing: "现在先处理这些",
    onboardingAllDone: "基础设置已经齐了。你可以继续进入首页，频道也可以按需稍后补充。",
    onboardingIssuesHint: "这些就是当前会挡住首次完成设置的项目。",
    onboardingStepsTitle: "接下来按这个顺序",
    onboardingStepsHint: "从上到下完成就好，保持简单。",
    setupChecksTitle: "底层状态（排查时再看）",
    setupChecksHint: "如果设置结果和预期不一致，再展开查看这些底层信号。",
    setupCheckCli: "已安装 OpenClaw",
    setupCheckConfig: "本地配置已就绪",
    setupCheckProvider: "模型服务已选好",
    setupCheckDaemon: "后台服务已准备",
    setupCheckGateway: "服务入口已启动",
    setupCheckRpc: "桌面连接已就绪",
    setupCheckDone: "已满足",
    setupCheckPending: "待完成",
    setupCheckOptional: "可选",
    stepEnvTitle: "确认本机环境",
    stepEnvDescription: "先确认 OpenClaw 已安装且本地配置可用，后面的保存结果才会真正生效。",
    stepProviderTitle: "选一个模型服务",
    stepProviderDescription: "大多数人只需要选择常用服务并填写访问密钥，高级字段可以先不动。",
    stepChannelTitle: "连接聊天工具（可选）",
    stepChannelDescription: "只有在你希望从聊天工具收消息时才需要配置，可在进入首页后再补。",
    stepRuntimeTitle: "准备后台服务",
    stepRuntimeDescription: "最后运行 Onboard，让 OpenClaw 自动补齐后台服务和桌面连接。完成后就能进入首页。",
    stepDone: "已完成",
    stepActive: "进行中",
    stepPending: "待处理",
    recommendTitle: "推荐下一步",
    recommendInstall: "先安装 OpenClaw",
    recommendRefreshConfig: "重新检查安装和本地配置",
    recommendProvider: "先选模型服务并填访问密钥",
    recommendRuntime: "运行 Onboard 完成后台准备",
    recommendReady: "进入首页",
    actionsTitle: "继续设置",
    actionPrimary: "推荐一步",
    actionSecondary: "重新检查",
    actionRefreshAll: "重新检查设置",
    actionRefreshingAll: "刷新中...",
    actionInstall: "安装 OpenClaw",
    actionInstalling: "安装中...",
    actionRunOnboard: "运行 Onboard",
    actionRunningOnboard: "Onboard 中...",
    actionStartGateway: "启动后台入口",
    actionStartingGateway: "启动中...",
    actionRefreshStatus: "检查后台连接",
    actionRefreshingStatus: "刷新中...",
    actionOpenDashboard: "进入首页",
    actionOpeningDashboard: "打开中...",
    actionStart: "启动",
    actionStop: "停止",
    actionRestart: "重启",
    actionStopping: "停止中...",
    actionRestarting: "重启中...",
    setupProviderTitle: "模型服务",
    setupProviderHint: "默认只需要选择一个常用模型服务并填写访问密钥。接口地址、协议和默认模型这些高级项，仅在自定义接入时再展开。",
    providerPresetTitle: "常用服务",
    providerPresetHint: "先选一个常见服务；系统会替你填好大部分技术项。",
    providerPresetSummary: "当前选择",
    providerSimpleTitle: "你现在要填的",
    providerSimpleHint: "大多数人只需要填写访问密钥。",
    providerAutoFillTitle: "系统已替你填好",
    providerAutoFillBody: "接口地址、接口协议和默认模型已按所选服务预填，先不用改。",
    providerCustomBody: "自定义接入通常还要补齐接口地址、接口协议和默认模型。",
    providerName: "本地保存名称",
    providerNameHelp: "只是这台电脑里的显示名称。常用服务会自动代填。",
    providerBaseUrl: "接口地址",
    providerBaseUrlHelp: "只有接代理、中转或私有部署时，才需要手动修改。",
    providerApiKey: "访问密钥（API Key）",
    providerApiKeyHelp: "普通情况下，你只需要填写这一项。",
    providerApiKeyPlaceholder: "粘贴你的访问密钥",
    providerApiProtocol: "接口协议",
    providerApiProtocolHelp: "常用服务已自动匹配，通常不需要自己改。",
    providerDefaultModel: "默认模型",
    providerDefaultModelHelp: "普通用户先保留默认值即可，后续需要时再换。",
    providerAdvancedToggle: "我需要修改接口地址 / 模型 / 协议",
    providerAdvancedHint: "只有在自定义接口、代理地址或特殊模型时，才需要展开这些字段。",
    actionSaveProvider: "保存模型服务",
    actionSavingProvider: "保存中...",
    providerConfiguredCount: "已保存服务数",
    providerAfterSave: "保存后会写入 OpenClaw 配置；下一步通常直接运行 Onboard。",
    setupChannelTitle: "聊天工具接入（可选）",
    setupChannelHint: "这一步不是首次完成设置的必需项。只有你希望从聊天工具收消息时才需要配置。",
    channelOptionalTitle: "可稍后再配",
    channelOptionalBody: "普通用户先完成安装、模型服务和 Onboard 就可以进入首页；聊天工具接入适合后续按需补充。",
    channelShowSetup: "展开可选聊天工具接入",
    channelHideSetup: "收起可选聊天工具接入",
    channelTelegram: "Telegram",
    channelFeishu: "飞书",
    channelQq: "QQ（占位）",
    channelBotToken: "Bot Token",
    channelAppId: "App ID",
    channelAppSecret: "App Secret",
    actionSaveTelegram: "保存 Telegram 接入",
    actionSaveFeishu: "保存飞书接入",
    actionSavingChannel: "保存中...",
    channelConfigured: "已配置",
    channelNotConfigured: "未配置",
    channelWhyConnectTitle: "为什么要连接频道",
    channelWhyConnectBody:
      "连上后，OpenClaw 才能通过聊天工具接收消息、触发能力，并把结果回到对应会话。",
    channelChooseTitle: "先选哪个",
    channelChooseBody:
      "个人或快速试用通常先选 Telegram；团队协作场景更适合飞书。后面还可以再补另一个。",
    channelPrepareTitle: "需要准备",
    channelAfterSaveTitle: "保存之后",
    channelTelegramLead: "Telegram 适合快速自测。你只需要先创建机器人，再把 Bot Token 填进来。",
    channelTelegramPrepare: "准备一个由 BotFather 创建的 Bot Token。",
    channelTelegramAfterSave:
      "保存后，Telegram 配置会写入 OpenClaw。接下来可运行 Onboard，或稍后再补后台准备。",
    channelFeishuLead:
      "飞书适合团队内部使用。先准备应用凭证，再把 App ID 和 App Secret 填进来。",
    channelFeishuPrepare: "准备飞书应用的 App ID 和 App Secret。",
    channelFeishuAfterSave:
      "保存后，飞书配置会写入 OpenClaw。接下来可运行 Onboard，或返回继续补其他设置。",
    channelBotTokenHelp: "可在 BotFather 创建机器人后获取。",
    channelAppIdHelp: "可在飞书应用后台的凭证页获取。",
    channelAppSecretHelp: "与 App ID 配套，用于让 OpenClaw 连接飞书应用。",
    channelSaveHelper: "保存不会立刻启动服务；通常下一步是运行 Onboard 或刷新状态。",
    setupBlockedByInstall: "请先完成 OpenClaw 安装；安装完成后，这里的配置才能写入本机。",
    qqPlaceholderText: "QQ 接入仍在完善中，这一步不会阻塞设置；需要时可先查看官方说明。",
    qqPlaceholderLink: "打开 QQ 官方接入说明",
    overviewTitle: "环境概览",
    overviewInstallStatus: "OpenClaw 安装",
    overviewGatewayStatus: "后台入口",
    overviewRpcStatus: "桌面连接",
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
    homeSubtitle: "OpenClaw 已准备就绪",
    homeStatusTitle: "当前进度",
    homeServiceTitle: "后台服务",
    homeNextStepTitle: "下一步建议",
    homeQuickActionsTitle: "其他操作",
    statusHumanNotInstalled: "未安装",
    statusHumanInstalledNotStarted: "已安装，继续设置",
    statusHumanStarting: "初始化中",
    statusHumanServiceError: "需要处理",
    statusHumanReady: "已就绪",
    statusExplainNotInstalled: "当前设备未检测到 OpenClaw。",
    statusExplainInstalledNotStarted: "OpenClaw 已安装，但后台服务或桌面连接还没有完全准备好。",
    statusExplainStarting: "正在等待安装或后台准备完成。",
    statusExplainServiceError: "后台状态看起来不正常，建议重新运行 Onboard 后再检查。",
    statusExplainReady: "全部检查通过，可以进入首页开始使用。",
    nextInstall: "先安装 OpenClaw。",
    nextProvider: "先选模型服务并填写访问密钥。",
    nextRuntime: "运行 Onboard，等待后台服务和桌面连接就绪。",
    nextOpenDashboard: "进入首页开始使用。",
    homeReadyNext: "现在可以直接开始使用；需要时再补频道或高级设置。",
    homeAdvancedDiagnostics: "高级诊断",
    homeAdvancedDiagnosticsHint: "包含原始 JSON、命令输出和底层路径信息，默认折叠。",
    diagnosticsStructuredStatus: "后台入口状态（结构化）",
    diagnosticsRawGateway: "后台入口原始输出",
    diagnosticsLastCommand: "最近命令输出",
    diagnosticsHistory: "执行历史",
    diagnosticsNone: "暂无结构化状态，已保留原始输出。",
    homeAdvancedSettings: "高级设置",
    homeAdvancedSettingsHint: "仅在需要时修改常用配置。",
    settingsTitle: "常用设置",
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
    issueProblemLabel: "问题",
    issueImpactLabel: "影响",
    issueActionLabel: "建议操作",
    issueReadyTitle: "基础环境已可继续",
    issueReadyBody: "必需检查都通过了。现在可以进入首页；聊天工具接入可根据使用场景继续补充。",
    issueCliProblem: "还没有安装 OpenClaw。",
    issueCliImpact: "桌面端无法读取配置，也无法继续初始化运行时。",
    issueCliAction: "点击“安装 OpenClaw”。安装完成后会自动重新检测环境。",
    issueConfigProblem: "还没有找到 OpenClaw 配置文件。",
    issueConfigImpact: "模型服务和聊天工具接入可能无法保存到本机，后续步骤也很难稳定继续。",
    issueConfigAction: "先重新检查环境；如果刚安装完成，通常再检测一次就会生成或找到配置文件。",
    issueProviderProblem: "还没有保存可用的模型服务。",
    issueProviderImpact: "OpenClaw 还不能真正调用模型能力，Onboard 后也无法顺利处理请求。",
    issueProviderAction: "先选一个常用模型服务并填写访问密钥；其他底层字段可先保持预设。",
    issueDaemonProblem: "后台服务还没准备好。",
    issueDaemonImpact: "服务入口和桌面连接还不能完整启动，桌面端无法进入可用状态。",
    issueDaemonAction: "运行 Onboard，让 OpenClaw 自动补齐后台服务依赖。",
    issueGatewayProblem: "服务入口还没启动。",
    issueGatewayImpact: "聊天工具消息和桌面端请求都还不能送达 OpenClaw。",
    issueGatewayAction: "先运行 Onboard；如果已执行过，可再尝试启动后台入口或刷新状态。",
    issueRpcProblem: "桌面连接还没建立。",
    issueRpcImpact: "桌面端暂时无法和运行时通信，首页也不会进入可用状态。",
    issueRpcAction: "先刷新状态；若仍未恢复，重新运行 Onboard 通常能补齐连接。",
    validationProviderName: "请填写保存名称，方便识别这组模型配置。",
    validationProviderBaseUrl: "请填写接口地址，OpenClaw 需要知道请求发到哪里。",
    validationProviderApiKey: "请填写访问密钥，保存后才能调用模型服务。",
    validationProviderApiProtocol: "请填写接口协议，用来匹配正确的接入方式。",
    validationProviderDefaultModel: "请填写默认模型，方便后续直接调用。",
    validationTelegramToken: "请填写 Bot Token，这样 Telegram 才能接入 OpenClaw。",
    validationFeishuCredentials:
      "请填写 App ID 和 App Secret，这样飞书频道才能连接到 OpenClaw。",
    logDetect: "检测 OpenClaw",
    logConfigFile: "读取配置文件路径",
    logConfigJson: "读取 OpenClaw 配置",
    logProviders: "读取模型服务列表",
    logGatewayStatus: "读取后台状态",
    logSettings: "读取常用配置",
  },
  "en-US": {
    appTitle: "Clawset Desktop",
    appSubtitle: "OpenClaw First-Time Setup",
    language: "Language",
    running: "Running",
    lastUpdated: "Last Updated",
    noticeReady: "Ready",
    noticeRefreshing: "Checking setup progress...",
    noticeRefreshed: "Setup progress refreshed",
    noticeNeedInstall: "Install OpenClaw first. The desktop app will re-check the environment right after that.",
    noticeNeedProvider: "Choose a model service and save an API key first so Onboard can actually use it.",
    noticeNeedRuntime: "Run Onboard to finish background setup.",
    languageTitle: "Choose Language",
    languageDescription: "Choose your UI language on first launch.",
    languageConfirm: "Continue",
    languageChinese: "简体中文",
    languageEnglish: "English",
    onboardingTitle: "Setup Guide",
    onboardingDescription:
      "Shortest path: install OpenClaw → choose a model service → paste API key → run Onboard → enter Home. Chat app setup is an optional follow-up step.",
    quickStartTitle: "Quick Start",
    quickStartHint: "Get to a working first run first, then add chat apps or advanced settings later.",
    quickStartStepInstall: "Install OpenClaw",
    quickStartStepProvider: "Choose model service and paste API key",
    quickStartStepOnboard: "Run Onboard",
    quickStartStepHome: "Enter Home",
    quickStartOptional: "Chat app setup is not required for first-time success.",
    onboardingProgress: "Progress",
    onboardingMissing: "Handle these next",
    onboardingAllDone: "Core setup is ready. You can enter Home now, and connect chat apps later if needed.",
    onboardingIssuesHint: "These are the only items still blocking first-time setup.",
    onboardingStepsTitle: "Then follow this order",
    onboardingStepsHint: "Keep it simple and finish the remaining steps from top to bottom.",
    setupChecksTitle: "Technical signals",
    setupChecksHint: "Only open this if setup does not behave as expected.",
    setupCheckCli: "OpenClaw Installed",
    setupCheckConfig: "Local Config Ready",
    setupCheckProvider: "Model Service Ready",
    setupCheckDaemon: "Background Service Ready",
    setupCheckGateway: "Service Entry Running",
    setupCheckRpc: "Desktop Connection Ready",
    setupCheckDone: "Done",
    setupCheckPending: "Pending",
    setupCheckOptional: "Optional",
    stepEnvTitle: "Confirm this device",
    stepEnvDescription: "First confirm that OpenClaw is installed and local config is available, so later saves really stick.",
    stepProviderTitle: "Choose a model service",
    stepProviderDescription: "Most users only need to choose a common provider and paste an API key. Expand advanced fields only if needed.",
    stepChannelTitle: "Connect chat apps (optional)",
    stepChannelDescription: "Only needed if you want messages to come from chat tools. You can add this after reaching Home.",
    stepRuntimeTitle: "Prepare background service",
    stepRuntimeDescription: "Run Onboard last. It fills in the background service and desktop connection so you can enter Home.",
    stepDone: "Done",
    stepActive: "Active",
    stepPending: "Pending",
    recommendTitle: "Recommended Next Step",
    recommendInstall: "Install OpenClaw first",
    recommendRefreshConfig: "Re-check install and local config",
    recommendProvider: "Choose a model service and paste API key",
    recommendRuntime: "Run Onboard to finish background setup",
    recommendReady: "Enter Home",
    actionsTitle: "Continue Setup",
    actionPrimary: "Recommended",
    actionSecondary: "Re-check",
    actionRefreshAll: "Re-check Setup",
    actionRefreshingAll: "Refreshing...",
    actionInstall: "Install OpenClaw",
    actionInstalling: "Installing...",
    actionRunOnboard: "Run Onboard",
    actionRunningOnboard: "Running Onboard...",
    actionStartGateway: "Start Service Entry",
    actionStartingGateway: "Starting...",
    actionRefreshStatus: "Check Background Service",
    actionRefreshingStatus: "Refreshing...",
    actionOpenDashboard: "Enter Home",
    actionOpeningDashboard: "Opening...",
    actionStart: "Start",
    actionStop: "Stop",
    actionRestart: "Restart",
    actionStopping: "Stopping...",
    actionRestarting: "Restarting...",
    setupProviderTitle: "Model Service",
    setupProviderHint: "Most people only need to choose a common provider and paste an API key. Endpoint, protocol, and default model stay under advanced for custom setups.",
    providerPresetTitle: "Common Providers",
    providerPresetHint: "Pick a common provider first. The app fills most technical fields for you.",
    providerPresetSummary: "Selected provider",
    providerSimpleTitle: "What you need now",
    providerSimpleHint: "For most people, API key is the only field to fill.",
    providerAutoFillTitle: "Already filled for you",
    providerAutoFillBody: "Endpoint URL, protocol, and default model are already prefilled for the selected provider.",
    providerCustomBody: "Custom services usually need you to finish endpoint URL, protocol, and default model manually.",
    providerName: "Saved Name",
    providerNameHelp: "This is only the local saved name. Common providers already fill it for you.",
    providerBaseUrl: "Endpoint URL",
    providerBaseUrlHelp: "Only change this when you use a proxy, relay, or self-hosted endpoint.",
    providerApiKey: "API Key",
    providerApiKeyHelp: "In the normal path, this is usually the only field you need to paste.",
    providerApiKeyPlaceholder: "Paste your API key",
    providerApiProtocol: "Protocol",
    providerApiProtocolHelp: "Common providers are already matched automatically, so most people can leave this alone.",
    providerDefaultModel: "Default model",
    providerDefaultModelHelp: "The default value is fine for most first-time setups.",
    providerAdvancedToggle: "I need to change endpoint / model / protocol",
    providerAdvancedHint: "Expand only when you use a custom endpoint, proxy, or a non-default model path.",
    actionSaveProvider: "Save Model Service",
    actionSavingProvider: "Saving...",
    providerConfiguredCount: "Saved Services",
    providerAfterSave: "After saving, this model service is written into OpenClaw config. The usual next step is running Onboard.",
    setupChannelTitle: "Chat App Setup (Optional)",
    setupChannelHint: "This is not required for first-time success. Only set it up if you want OpenClaw to receive messages from chat tools.",
    channelOptionalTitle: "Can wait until later",
    channelOptionalBody: "Most people can enter Home after install, model service setup, and Onboard. Chat app setup works best as a later add-on.",
    channelShowSetup: "Expand optional chat app setup",
    channelHideSetup: "Collapse optional chat app setup",
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
    channelWhyConnectTitle: "Why connect a chat app",
    channelWhyConnectBody:
      "Once connected, OpenClaw can receive messages from your chat tool, trigger actions, and send results back to the same conversation.",
    channelChooseTitle: "Which one first",
    channelChooseBody:
      "Telegram is usually the fastest for personal testing. Feishu is a better first pick for team workflows. You can always add the other later.",
    channelPrepareTitle: "What to prepare",
    channelAfterSaveTitle: "What happens next",
    channelTelegramLead: "Telegram is best for quick self-testing. Create a bot first, then paste its Bot Token here.",
    channelTelegramPrepare: "Have a Bot Token created via BotFather ready.",
    channelTelegramAfterSave:
      "Saving writes Telegram settings into OpenClaw. Your next step is usually to run Onboard, or come back later to finish background setup.",
    channelFeishuLead:
      "Feishu works well for internal team use. Prepare the app credentials first, then paste App ID and App Secret here.",
    channelFeishuPrepare: "Have the Feishu app App ID and App Secret ready.",
    channelFeishuAfterSave:
      "Saving writes Feishu settings into OpenClaw. Your next step is usually to run Onboard, or continue the rest of setup first.",
    channelBotTokenHelp: "You can get this after creating a bot with BotFather.",
    channelAppIdHelp: "Find this in your Feishu app credentials page.",
    channelAppSecretHelp: "This pairs with the App ID so OpenClaw can connect to your Feishu app.",
    channelSaveHelper: "Saving does not start services immediately; the usual next step is running Onboard or refreshing status.",
    setupBlockedByInstall: "Install OpenClaw first before these settings can be written to your local config.",
    qqPlaceholderText: "QQ integration is still being completed. It does not block setup, and you can check the official guide if needed.",
    qqPlaceholderLink: "Open QQ official integration page",
    overviewTitle: "Environment Overview",
    overviewInstallStatus: "OpenClaw Install",
    overviewGatewayStatus: "Service Entry",
    overviewRpcStatus: "Desktop Connection",
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
    homeSubtitle: "OpenClaw is ready to use",
    homeStatusTitle: "Current Progress",
    homeServiceTitle: "Background Service",
    homeNextStepTitle: "Next Suggestion",
    homeQuickActionsTitle: "Other Actions",
    statusHumanNotInstalled: "Not installed",
    statusHumanInstalledNotStarted: "Installed, keep going",
    statusHumanStarting: "Initializing",
    statusHumanServiceError: "Needs attention",
    statusHumanReady: "Ready",
    statusExplainNotInstalled: "OpenClaw is not detected on this machine.",
    statusExplainInstalledNotStarted: "OpenClaw is installed, but the background service or desktop connection is not fully ready yet.",
    statusExplainStarting: "Waiting for installation or background setup to finish.",
    statusExplainServiceError: "Background state looks abnormal. Try running Onboard again, then re-check setup.",
    statusExplainReady: "All checks passed. Home is ready.",
    nextInstall: "Install OpenClaw first.",
    nextProvider: "Choose a model service and paste API key.",
    nextRuntime: "Run Onboard and wait for the background service and desktop connection.",
    nextOpenDashboard: "Enter Home to continue.",
    homeReadyNext: "You can start using OpenClaw now, and add chat apps or advanced settings later.",
    homeAdvancedDiagnostics: "Advanced Diagnostics",
    homeAdvancedDiagnosticsHint: "Contains raw JSON, command output, and low-level path details. Collapsed by default.",
    diagnosticsStructuredStatus: "Structured service entry status",
    diagnosticsRawGateway: "Raw service entry output",
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
    issueProblemLabel: "Problem",
    issueImpactLabel: "Impact",
    issueActionLabel: "Next step",
    issueReadyTitle: "Core setup is ready to continue",
    issueReadyBody: "All required checks have passed. You can enter Home now, and keep chat app setup optional based on your workflow.",
    issueCliProblem: "OpenClaw is not installed yet.",
    issueCliImpact: "The desktop app cannot read config or continue runtime initialization.",
    issueCliAction: 'Click "Install OpenClaw". The app re-checks the environment automatically after install.',
    issueConfigProblem: "OpenClaw config file has not been found yet.",
    issueConfigImpact: "Model service and chat app settings may not persist, and later steps cannot continue reliably.",
    issueConfigAction:
      "Re-check setup first. If installation just finished, one more detection pass usually creates or finds the config file.",
    issueProviderProblem: "No model service has been saved yet.",
    issueProviderImpact: "OpenClaw cannot use model capabilities yet, so requests still cannot be handled even after Onboard.",
    issueProviderAction: "Choose a common provider and paste an API key first. Leave the lower-level fields on their defaults unless you need customization.",
    issueDaemonProblem: "Background service is not ready yet.",
    issueDaemonImpact: "Service entry and desktop connection cannot fully start, so the desktop app cannot become usable.",
    issueDaemonAction: "Run Onboard so OpenClaw can fill in the required background service pieces automatically.",
    issueGatewayProblem: "Service entry is not running yet.",
    issueGatewayImpact: "Chat app messages and desktop requests cannot reach OpenClaw.",
    issueGatewayAction: "Run Onboard first. If you already did, try starting the service entry again or refresh status.",
    issueRpcProblem: "Desktop connection is not ready yet.",
    issueRpcImpact: "The desktop app cannot talk to the runtime, so Home will not become Ready.",
    issueRpcAction: "Refresh status first. If it still fails, running Onboard again usually repairs the connection.",
    validationProviderName: "Enter a saved name so this model setup is easy to recognize.",
    validationProviderBaseUrl: "Enter an endpoint URL so OpenClaw knows where to send requests.",
    validationProviderApiKey: "Enter an API Key so model requests can actually be authenticated.",
    validationProviderApiProtocol: "Enter the protocol so OpenClaw can match the correct interface shape.",
    validationProviderDefaultModel: "Enter a default model so later requests have a ready model target.",
    validationTelegramToken: "Enter a Bot Token so Telegram can connect to OpenClaw.",
    validationFeishuCredentials: "Enter both App ID and App Secret so the Feishu channel can connect to OpenClaw.",
    logDetect: "Detect OpenClaw",
    logConfigFile: "Read config file path",
    logConfigJson: "Read OpenClaw config",
    logProviders: "Read model services",
    logGatewayStatus: "Read background status",
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

function inferProviderPreset(values: Pick<ProviderFormState, "providerName" | "baseUrl" | "api">): ProviderPresetId {
  const combined = `${values.providerName} ${values.baseUrl} ${values.api}`.toLowerCase();

  if (combined.includes("openrouter")) {
    return "openrouter";
  }

  if (combined.includes("moonshot") || combined.includes("kimi")) {
    return "kimi";
  }

  if (combined.includes("bigmodel") || combined.includes("glm")) {
    return "glm";
  }

  if (combined.includes("anthropic") || combined.includes("claude")) {
    return "anthropic";
  }

  if (combined.includes("openai")) {
    return "openai";
  }

  return "custom";
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

function localizeCommandMessage(locale: Locale, message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }

  const providerSaved = trimmed.match(/^Provider '(.+)' saved$/);
  if (providerSaved) {
    return locale === "zh-CN"
      ? `模型服务“${providerSaved[1]}”已保存`
      : `Model service "${providerSaved[1]}" saved`;
  }

  const channelSaved = trimmed.match(/^Channel '(.+)' saved$/);
  if (channelSaved) {
    const channel = channelSaved[1] === "feishu" ? (locale === "zh-CN" ? "飞书" : "Feishu") : "Telegram";
    return locale === "zh-CN" ? `${channel} 接入已保存` : `${channel} saved`;
  }

  const gatewayDone = trimmed.match(/^Gateway (start|stop|restart) command completed$/);
  if (gatewayDone) {
    const action = gatewayDone[1];
    if (locale === "zh-CN") {
      if (action === "start") return "后台入口已启动";
      if (action === "stop") return "后台入口已停止";
      return "后台入口已重启";
    }
    if (action === "start") return "Service entry started";
    if (action === "stop") return "Service entry stopped";
    return "Service entry restarted";
  }

  const gatewayFailed = trimmed.match(/^Gateway (start|stop|restart) failed$/);
  if (gatewayFailed) {
    const action = gatewayFailed[1];
    if (locale === "zh-CN") {
      if (action === "start") return "后台入口启动失败";
      if (action === "stop") return "后台入口停止失败";
      return "后台入口重启失败";
    }
    if (action === "start") return "Failed to start service entry";
    if (action === "stop") return "Failed to stop service entry";
    return "Failed to restart service entry";
  }

  const staticMap =
    locale === "zh-CN"
      ? {
          "OpenClaw detected": "已检测到 OpenClaw",
          "OpenClaw not detected": "未检测到 OpenClaw",
          "OpenClaw install completed": "OpenClaw 安装完成",
          "OpenClaw install failed": "OpenClaw 安装失败",
          "Gateway status fetched": "已检查后台状态",
          "Gateway status fetched but stdout is not valid JSON": "已检查后台状态，但返回内容不是有效的 JSON",
          "Failed to fetch dashboard URL": "获取首页地址失败",
          "Failed to open dashboard URL": "打开首页失败",
          "OpenClaw config loaded": "已读取 OpenClaw 配置",
          "OpenClaw providers loaded": "已读取模型服务列表",
          "Failed to read OpenClaw config": "读取 OpenClaw 配置失败",
          "Failed to read OpenClaw providers": "读取模型服务列表失败",
          "Failed to write OpenClaw provider": "保存模型服务失败",
          "Failed to write OpenClaw channel": "保存聊天工具接入失败",
          "OpenClaw onboard command completed": "Onboard 已完成",
          "OpenClaw onboard failed": "Onboard 失败",
          "OpenClaw CLI is not installed or not available": "OpenClaw 尚未安装，或当前环境无法调用。",
        }
      : {
          "OpenClaw detected": "OpenClaw detected",
          "OpenClaw not detected": "OpenClaw not detected",
          "OpenClaw install completed": "OpenClaw install completed",
          "OpenClaw install failed": "OpenClaw install failed",
          "Gateway status fetched": "Background status checked",
          "Gateway status fetched but stdout is not valid JSON": "Background status checked, but the output is not valid JSON",
          "Failed to fetch dashboard URL": "Failed to fetch Home URL",
          "Failed to open dashboard URL": "Failed to open Home",
          "OpenClaw config loaded": "OpenClaw config loaded",
          "OpenClaw providers loaded": "Model services loaded",
          "Failed to read OpenClaw config": "Failed to read OpenClaw config",
          "Failed to read OpenClaw providers": "Failed to read model services",
          "Failed to write OpenClaw provider": "Failed to save model service",
          "Failed to write OpenClaw channel": "Failed to save chat app setup",
          "OpenClaw onboard command completed": "Onboard completed",
          "OpenClaw onboard failed": "Onboard failed",
          "OpenClaw CLI is not installed or not available": "OpenClaw is not installed or cannot be called from this environment.",
        };

  return staticMap[trimmed as keyof typeof staticMap] ?? trimmed;
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
  const [providerPreset, setProviderPreset] = useState<ProviderPresetId>("openai");
  const [showProviderAdvanced, setShowProviderAdvanced] = useState<boolean>(false);
  const [showChannelSetup, setShowChannelSetup] = useState<boolean>(false);
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
  const activeProviderPreset = PROVIDER_PRESETS[providerPreset];
  const activeProviderKeyHint = activeProviderPreset.keyHint[locale];

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

  const quickStartSteps = [
    { label: t.quickStartStepInstall, done: setupChecks.cliInstalled },
    { label: t.quickStartStepProvider, done: setupChecks.providerConfigured },
    {
      label: t.quickStartStepOnboard,
      done: setupChecks.daemonInstalled && setupChecks.gatewayListening && setupChecks.rpcConnected,
    },
    { label: t.quickStartStepHome, done: isReady },
  ];

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

  const issueGuides: Record<RequiredCheckKey, GuidanceCard> = {
    cliInstalled: {
      key: "cliInstalled",
      title: t.setupCheckCli,
      problem: t.issueCliProblem,
      impact: t.issueCliImpact,
      action: t.issueCliAction,
    },
    configExists: {
      key: "configExists",
      title: t.setupCheckConfig,
      problem: t.issueConfigProblem,
      impact: t.issueConfigImpact,
      action: t.issueConfigAction,
    },
    providerConfigured: {
      key: "providerConfigured",
      title: t.setupCheckProvider,
      problem: t.issueProviderProblem,
      impact: t.issueProviderImpact,
      action: t.issueProviderAction,
    },
    daemonInstalled: {
      key: "daemonInstalled",
      title: t.setupCheckDaemon,
      problem: t.issueDaemonProblem,
      impact: t.issueDaemonImpact,
      action: t.issueDaemonAction,
    },
    gatewayListening: {
      key: "gatewayListening",
      title: t.setupCheckGateway,
      problem: t.issueGatewayProblem,
      impact: t.issueGatewayImpact,
      action: t.issueGatewayAction,
    },
    rpcConnected: {
      key: "rpcConnected",
      title: t.setupCheckRpc,
      problem: t.issueRpcProblem,
      impact: t.issueRpcImpact,
      action: t.issueRpcAction,
    },
  };

  const pendingIssueGuides = missingRequired.map((key) => issueGuides[key]);

  const onboardingMinorActions: HomeAction[] =
    !overview.installed || !setupChecks.providerConfigured || isReady
      ? []
      : (["run-onboard", !setupChecks.gatewayListening ? "start" : null, "refresh-status"] as Array<
          HomeAction | null
        >).filter((action): action is HomeAction => action !== null && action !== recommendedPrimaryAction);

  const dashboardMinorActions: HomeAction[] = [
    setupChecks.gatewayListening ? "restart" : "start",
    "stop",
    "run-onboard",
  ];

  const activeChannelGuide: ChannelGuideContent =
    channelTab === "telegram"
      ? {
          lead: t.channelTelegramLead,
          prepare: t.channelTelegramPrepare,
          afterSave: t.channelTelegramAfterSave,
        }
      : {
          lead: t.channelFeishuLead,
          prepare: t.channelFeishuPrepare,
          afterSave: t.channelFeishuAfterSave,
        };

  const activeChannelConfigured =
    channelTab === "telegram" ? channels.telegramConfigured : channels.feishuConfigured;

  const activeChannelActionText =
    channelTab === "telegram"
      ? busyAction === "save-channel-telegram"
        ? t.actionSavingChannel
        : t.actionSaveTelegram
      : busyAction === "save-channel-feishu"
        ? t.actionSavingChannel
        : t.actionSaveFeishu;

  const handleSaveActiveChannel = channelTab === "telegram" ? handleSaveTelegram : handleSaveFeishu;

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
        const nextProviderForm = {
          providerName,
          baseUrl: isNonEmptyString(providerData.baseUrl)
            ? String(providerData.baseUrl)
            : DEFAULT_PROVIDER_FORM.baseUrl,
          apiKey: isNonEmptyString(providerData.apiKey) ? String(providerData.apiKey) : "",
          api: isNonEmptyString(providerData.api) ? String(providerData.api) : DEFAULT_PROVIDER_FORM.api,
          defaultModel:
            models && isNonEmptyString(models.default_model)
              ? String(models.default_model)
              : DEFAULT_PROVIDER_FORM.defaultModel,
        };
        const inferredPreset = inferProviderPreset(nextProviderForm);

        setProviderForm((current) => ({
          ...current,
          ...nextProviderForm,
        }));
        setProviderPreset(inferredPreset);
        setShowProviderAdvanced(inferredPreset === "custom");
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
      setNotice({ kind: "error", text: localizeCommandMessage(locale, toErrorMessage(error)) });
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

      const responseMessage = response.message ? localizeCommandMessage(locale, response.message) : "";

      if (!response.success) {
        setNotice({ kind: "error", text: responseMessage || t.commandFailed });
        return;
      }

      if (afterSuccess) {
        await afterSuccess();
      }

      markUpdated();
      setNotice({ kind: "success", text: responseMessage || t.noticeRefreshed });
    } catch (error) {
      setNotice({ kind: "error", text: localizeCommandMessage(locale, toErrorMessage(error)) });
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
      return t.validationProviderName;
    }
    if (!providerForm.baseUrl.trim()) {
      return t.validationProviderBaseUrl;
    }
    if (!providerForm.apiKey.trim()) {
      return t.validationProviderApiKey;
    }
    if (!providerForm.api.trim()) {
      return t.validationProviderApiProtocol;
    }
    if (!providerForm.defaultModel.trim()) {
      return t.validationProviderDefaultModel;
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

  function handleSelectProviderPreset(nextPreset: ProviderPresetId) {
    setProviderPreset(nextPreset);

    const preset = PROVIDER_PRESETS[nextPreset];
    setShowProviderAdvanced(nextPreset === "custom");
    setProviderForm((current) => ({
      ...current,
      providerName: preset.providerName,
      baseUrl: preset.baseUrl,
      api: preset.api,
      defaultModel: preset.defaultModel,
    }));
  }

  function handleSaveTelegram() {
    if (!overview.installed) {
      setNotice({ kind: "error", text: t.noticeNeedInstall });
      return;
    }

    if (!telegramForm.botToken.trim()) {
      setNotice({ kind: "error", text: t.validationTelegramToken });
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
      setNotice({ kind: "error", text: t.validationFeishuCredentials });
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
      setNotice({ kind: "error", text: localizeCommandMessage(locale, toErrorMessage(error)) });
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

          <div className="quick-start-card">
            <div className="quick-start-head">
              <strong>{t.quickStartTitle}</strong>
              <span className="state-pill state-console-ready quick-start-badge">
                {completedRequiredCount}/{REQUIRED_CHECK_ORDER.length}
              </span>
            </div>
            <p>{t.quickStartHint}</p>
            <div className="quick-start-grid">
              {quickStartSteps.map((step, index) => (
                <div key={step.label} className={`quick-start-step ${step.done ? "quick-start-step-done" : ""}`}>
                  <span>{index + 1}</span>
                  <strong>{step.label}</strong>
                </div>
              ))}
            </div>
            <small className="field-help provider-footnote">{t.quickStartOptional}</small>
          </div>

          <div className="progress-head">
            <span>
              {t.onboardingProgress}: {completedRequiredCount}/{REQUIRED_CHECK_ORDER.length}
            </span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>

          <label className="field-label">{t.onboardingMissing}</label>
          <p className="field-help section-hint">{t.onboardingIssuesHint}</p>
          {pendingIssueGuides.length === 0 ? (
            <div className="helper-callout helper-callout-success">
              <strong>{t.issueReadyTitle}</strong>
              <p>{t.issueReadyBody}</p>
            </div>
          ) : (
            <div className="guidance-list">
              {pendingIssueGuides.map((issue) => (
                <article key={issue.key} className="guidance-card">
                  <strong>{issue.title}</strong>
                  <div className="guidance-pair">
                    <span>{t.issueProblemLabel}</span>
                    <p>{issue.problem}</p>
                  </div>
                  <div className="guidance-pair">
                    <span>{t.issueImpactLabel}</span>
                    <p>{issue.impact}</p>
                  </div>
                  <div className="guidance-pair">
                    <span>{t.issueActionLabel}</span>
                    <p>{issue.action}</p>
                  </div>
                </article>
              ))}
            </div>
          )}

          <label className="field-label">{t.onboardingStepsTitle}</label>
          <p className="field-help section-hint">{t.onboardingStepsHint}</p>
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

          <details className="onboarding-checks-panel fold-panel">
            <summary>{t.setupChecksTitle}</summary>
            <p className="fold-hint">{t.setupChecksHint}</p>
            <div className="status-grid setup-check-grid">
              {REQUIRED_CHECK_ORDER.map((key) => (
                <div key={key} className={`status-item status-${setupChecks[key] ? "done" : "todo"}`}>
                  <span>{checkLabels[key]}</span>
                  <strong>{setupChecks[key] ? t.setupCheckDone : t.setupCheckPending}</strong>
                </div>
              ))}
            </div>
          </details>
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
              {onboardingMinorActions.length === 0 ? (
                <small className="field-help minor-empty">{t.quickStartOptional}</small>
              ) : (
                onboardingMinorActions.map((action) => (
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
                ))
              )}
            </div>
          </div>

          <div className="helper-callout setup-summary-callout">
            <strong>{homeStatusLabel}</strong>
            <p>{homeStatusDescription}</p>
          </div>
        </section>

        <section className="panel panel-status setup-provider-card">
          <h2>{t.setupProviderTitle}</h2>
          <p className="home-subtitle">{t.setupProviderHint}</p>
          {!overview.installed ? (
            <div className="helper-callout">
              <p>{t.setupBlockedByInstall}</p>
            </div>
          ) : null}
          <div className="provider-simple-card">
            <label className="field-label">{t.providerPresetTitle}</label>
            <small className="field-help">{t.providerPresetHint}</small>
            <div className="preset-grid">
              {(Object.keys(PROVIDER_PRESETS) as ProviderPresetId[]).map((presetId) => (
                <button
                  key={presetId}
                  className={`preset-card ${providerPreset === presetId ? "preset-card-active" : ""}`}
                  onClick={() => {
                    handleSelectProviderPreset(presetId);
                  }}
                  disabled={setupConfigDisabled}
                >
                  <strong>{PROVIDER_PRESETS[presetId].label[locale]}</strong>
                  <span>{PROVIDER_PRESETS[presetId].hint[locale]}</span>
                </button>
              ))}
            </div>

            <div className="provider-choice-card">
              <span className="field-label">{t.providerPresetSummary}</span>
              <strong>{activeProviderPreset.label[locale]}</strong>
              <p>{activeProviderPreset.hint[locale]}</p>
            </div>

            <div className="provider-support-grid">
              <div className="provider-support-card">
                <span>{t.providerSimpleTitle}</span>
                <p>{t.providerSimpleHint}</p>
              </div>
              <div className="provider-support-card">
                <span>{t.providerAutoFillTitle}</span>
                <p>{providerPreset === "custom" ? t.providerCustomBody : t.providerAutoFillBody}</p>
              </div>
            </div>

            <label className="input-block" htmlFor="provider-api-key">
              <span className="field-label">{t.providerApiKey}</span>
              <small className="field-help">{activeProviderKeyHint}</small>
              <input
                id="provider-api-key"
                type="password"
                placeholder={t.providerApiKeyPlaceholder}
                value={providerForm.apiKey}
                onChange={(event) => {
                  setProviderForm((current) => ({ ...current, apiKey: event.target.value }));
                }}
                disabled={setupConfigDisabled}
              />
            </label>
          </div>

          <details
            className="provider-advanced-panel"
            open={showProviderAdvanced}
            onToggle={(event) => {
              setShowProviderAdvanced(event.currentTarget.open);
            }}
          >
            <summary>{t.providerAdvancedToggle}</summary>
            <p className="fold-hint">{providerPreset === "custom" ? t.providerCustomBody : t.providerAdvancedHint}</p>
            <div className="form-grid provider-advanced-grid">
              <label className="input-block" htmlFor="provider-name">
                <span className="field-label">{t.providerName}</span>
                <small className="field-help">{t.providerNameHelp}</small>
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
              <label className="input-block" htmlFor="provider-default-model">
                <span className="field-label">{t.providerDefaultModel}</span>
                <small className="field-help">{t.providerDefaultModelHelp}</small>
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
              <label className="input-block" htmlFor="provider-base-url">
                <span className="field-label">{t.providerBaseUrl}</span>
                <small className="field-help">{t.providerBaseUrlHelp}</small>
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
              <label className="input-block" htmlFor="provider-api">
                <span className="field-label">{t.providerApiProtocol}</span>
                <small className="field-help">{t.providerApiProtocolHelp}</small>
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
            </div>
          </details>
          <button
            className="btn btn-primary"
            onClick={handleSaveProvider}
            disabled={setupConfigDisabled}
          >
            {isBusy("save-provider") ? t.actionSavingProvider : t.actionSaveProvider}
          </button>
          <small className="field-help provider-footnote">{t.providerAfterSave}</small>
        </section>

        <section className="panel panel-status setup-channel-card">
          <h2>{t.setupChannelTitle}</h2>
          <p className="home-subtitle">{t.setupChannelHint}</p>

          <div className="helper-callout">
            <strong>{t.channelOptionalTitle}</strong>
            <p>{t.channelOptionalBody}</p>
          </div>

          <details
            className="channel-optional-panel"
            open={showChannelSetup}
            onToggle={(event) => {
              setShowChannelSetup(event.currentTarget.open);
            }}
          >
            <summary>{showChannelSetup ? t.channelHideSetup : t.channelShowSetup}</summary>

            <div className="channel-optional-body">
              <div className="channel-guide-grid channel-guide-grid-intro">
                <div className="channel-guide-card">
                  <span className="field-label">{t.channelWhyConnectTitle}</span>
                  <p>{t.channelWhyConnectBody}</p>
                </div>
                <div className="channel-guide-card">
                  <span className="field-label">{t.channelChooseTitle}</span>
                  <p>{t.channelChooseBody}</p>
                </div>
              </div>

              {!overview.installed ? (
                <div className="helper-callout">
                  <p>{t.setupBlockedByInstall}</p>
                </div>
              ) : null}

              <div className="channel-tabs" role="tablist" aria-label="channel-tabs">
                <button
                  className={`btn btn-ghost ${channelTab === "telegram" ? "tab-active" : ""}`}
                  onClick={() => {
                    setChannelTab("telegram");
                  }}
                  disabled={Boolean(busyAction)}
                >
                  {t.channelTelegram}
                </button>
                <button
                  className={`btn btn-ghost ${channelTab === "feishu" ? "tab-active" : ""}`}
                  onClick={() => {
                    setChannelTab("feishu");
                  }}
                  disabled={Boolean(busyAction)}
                >
                  {t.channelFeishu}
                </button>
              </div>

              <div className="channel-pane">
                <div className="channel-badge-row">
                  <span className="field-help">
                    {channelTab === "telegram" ? t.channelTelegram : t.channelFeishu}
                  </span>
                  <span
                    className={`state-pill ${activeChannelConfigured ? "state-console-ready" : "state-installed-not-started"}`}
                  >
                    {activeChannelConfigured ? t.channelConfigured : t.channelNotConfigured}
                  </span>
                </div>

                <p className="channel-lead">{activeChannelGuide.lead}</p>

                <div className="channel-guide-grid">
                  <div className="channel-guide-card">
                    <span className="field-label">{t.channelPrepareTitle}</span>
                    <p>{activeChannelGuide.prepare}</p>
                  </div>
                  <div className="channel-guide-card">
                    <span className="field-label">{t.channelAfterSaveTitle}</span>
                    <p>{activeChannelGuide.afterSave}</p>
                  </div>
                </div>

                {channelTab === "telegram" ? (
                  <label className="input-block" htmlFor="telegram-token">
                    <span className="field-label">{t.channelBotToken}</span>
                    <small className="field-help">{t.channelBotTokenHelp}</small>
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
                ) : (
                  <>
                    <label className="input-block" htmlFor="feishu-app-id">
                      <span className="field-label">{t.channelAppId}</span>
                      <small className="field-help">{t.channelAppIdHelp}</small>
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
                      <small className="field-help">{t.channelAppSecretHelp}</small>
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
                  </>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleSaveActiveChannel}
                  disabled={setupConfigDisabled}
                >
                  {activeChannelActionText}
                </button>
                <small className="field-help provider-footnote">{t.channelSaveHelper}</small>
              </div>

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
            </div>
          </details>
        </section>

        <details className="panel fold-panel">
          <summary>{t.homeAdvancedDiagnostics}</summary>
          <p className="fold-hint">{t.homeAdvancedDiagnosticsHint}</p>
          <label className="field-label">{t.diagnosticsLastCommand}</label>
          <pre className="raw">{lastCommandOutput || t.outputEmpty}</pre>
          <label className="field-label">{t.outputHistoryTitle}</label>
          <pre className="raw history">{commandHistory.join("\n") || t.outputEmpty}</pre>
        </details>
      </main>
    );
  }

  function renderDashboard() {
    const homeActionPlan = {
      primary: "open-dashboard" as HomeAction,
      secondary: "refresh-all" as HomeAction,
      minor: dashboardMinorActions,
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
              <strong>{t.statusHumanReady}</strong>
            </div>
            <div className="home-row home-row-wrap">
              <span>{t.homeNextStepTitle}</span>
              <strong>{isReady ? t.homeReadyNext : nextSuggestion}</strong>
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
              <span>{t.setupCheckProvider}</span>
              <strong>{setupChecks.providerConfigured ? t.overviewReady : t.overviewNotReady}</strong>
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
              <span>{t.setupCheckConfig}</span>
              <strong>{setupChecks.configExists ? t.overviewReady : t.overviewNotReady}</strong>
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

          <label className="field-label">{t.overviewPath}</label>
          <pre className="raw">{overview.path}</pre>

          <label className="field-label">{t.overviewConfigFile}</label>
          <pre className="raw">{overview.configFile}</pre>

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
