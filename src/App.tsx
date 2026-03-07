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

const DEFAULT_SETTINGS: CommonSettings = {
  "update.channel": "",
  "update.checkOnStart": "false",
  "acp.enabled": "false",
  "acp.defaultAgent": "",
  "agents.defaults.thinkingDefault": "",
  "agents.defaults.heartbeat.every": "",
};

const SETTING_FIELDS: Array<{
  path: SettingPath;
  label: string;
  description: string;
  control: "text" | "boolean";
  placeholder: string;
}> = [
  {
    path: "update.channel",
    label: "update.channel",
    description: "更新通道（例如 stable / beta）",
    control: "text",
    placeholder: "stable",
  },
  {
    path: "update.checkOnStart",
    label: "update.checkOnStart",
    description: "启动时检查更新",
    control: "boolean",
    placeholder: "true/false",
  },
  {
    path: "acp.enabled",
    label: "acp.enabled",
    description: "是否启用 ACP",
    control: "boolean",
    placeholder: "true/false",
  },
  {
    path: "acp.defaultAgent",
    label: "acp.defaultAgent",
    description: "ACP 默认代理名称",
    control: "text",
    placeholder: "agent-name",
  },
  {
    path: "agents.defaults.thinkingDefault",
    label: "agents.defaults.thinkingDefault",
    description: "默认思考强度",
    control: "text",
    placeholder: "medium",
  },
  {
    path: "agents.defaults.heartbeat.every",
    label: "agents.defaults.heartbeat.every",
    description: "心跳间隔（例如 30s）",
    control: "text",
    placeholder: "30s",
  },
];

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0];
  return line || "-";
}

function parseDetect(stdout: string): {
  version: string;
  path: string;
  configFile: string;
} {
  let version = "-";
  let path = "-";
  let configFile = "-";
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("version:")) {
      version = line.replace("version:", "").trim() || "-";
    } else if (line.startsWith("path:")) {
      path = line.replace("path:", "").trim() || "-";
    } else if (line.startsWith("config_file:")) {
      configFile = line.replace("config_file:", "").trim() || "-";
    }
  }
  return { version, path, configFile };
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

export default function App() {
  const [overview, setOverview] = useState<OverviewState>({
    installed: false,
    version: "-",
    path: "-",
    configFile: "-",
  });
  const [gatewayRaw, setGatewayRaw] = useState<string>("");
  const [gatewayParsed, setGatewayParsed] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<CommonSettings>(DEFAULT_SETTINGS);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastCommandOutput, setLastCommandOutput] = useState<string>("");
  const [lastUpdated, setLastUpdated] = useState<string>("未刷新");

  const gatewayEntries = useMemo(() => {
    if (!gatewayParsed) {
      return [];
    }
    return Object.entries(gatewayParsed);
  }, [gatewayParsed]);

  const isBusy = (action: string): boolean =>
    busyAction === action || busyAction === "boot";

  function markUpdated() {
    setLastUpdated(new Date().toLocaleString());
  }

  function recordResponse(response: CommandResponse) {
    const lines = [
      `success: ${response.success}`,
      `exit_code: ${response.exit_code}`,
      `message: ${response.message}`,
      `stdout:\n${response.stdout || "(empty)"}`,
      `stderr:\n${response.stderr || "(empty)"}`,
    ];
    setLastCommandOutput(lines.join("\n"));
  }

  async function refreshOverview() {
    const detectResponse = await detectOpenclaw();
    recordResponse(detectResponse);
    const detectParsed = parseDetect(detectResponse.stdout);

    const configResponse = await getConfigFile();
    recordResponse(configResponse);

    setOverview({
      installed: detectResponse.success,
      version: detectParsed.version,
      path: detectParsed.path,
      configFile: configResponse.success
        ? firstLine(configResponse.stdout)
        : detectParsed.configFile,
    });
  }

  async function refreshGateway() {
    const response = await gatewayStatus();
    recordResponse(response);
    setGatewayRaw(response.stdout);
    if (isRecord(response.parsed_json)) {
      setGatewayParsed(response.parsed_json);
    } else {
      setGatewayParsed(null);
    }
    return response;
  }

  async function refreshSettings() {
    const response = await getCommonSettings();
    recordResponse(response);

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
  }

  async function refreshAll() {
    setBusyAction("boot");
    setNotice({ kind: "info", text: "正在刷新状态..." });
    try {
      await refreshOverview();
      await refreshGateway();
      await refreshSettings();
      markUpdated();
      setNotice({ kind: "success", text: "状态已刷新" });
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  async function runAction(
    actionKey: string,
    runningText: string,
    task: () => Promise<CommandResponse>,
    afterSuccess?: () => Promise<void>,
  ) {
    setBusyAction(actionKey);
    setNotice({ kind: "info", text: `${runningText}...` });
    try {
      const response = await task();
      recordResponse(response);
      if (!response.success) {
        setNotice({
          kind: "error",
          text: response.message || "命令执行失败",
        });
        return;
      }

      if (afterSuccess) {
        await afterSuccess();
      }
      markUpdated();
      setNotice({
        kind: "success",
        text: response.message || "执行成功",
      });
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  function handleGatewayAction(action: GatewayAction) {
    const labels: Record<GatewayAction, string> = {
      start: "启动 Gateway",
      stop: "停止 Gateway",
      restart: "重启 Gateway",
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
    void runAction("install", "安装 OpenClaw", installOpenclaw, async () => {
      await refreshOverview();
    });
  }

  function handleOpenDashboard() {
    void runAction("dashboard", "打开 Dashboard", openDashboard);
  }

  function handleRefreshStatus() {
    void runAction("status", "刷新 Gateway 状态", refreshGateway);
  }

  function handleSettingChange(path: SettingPath, value: string) {
    setSettings((current) => ({ ...current, [path]: value } as CommonSettings));
  }

  function handleSaveOne(path: SettingPath) {
    void runAction(
      `save-${path}`,
      `保存 ${path}`,
      () => setCommonSetting(path, settings[path]),
      async () => {
        await refreshSettings();
      },
    );
  }

  async function handleSaveAll() {
    setBusyAction("save-all");
    setNotice({ kind: "info", text: "正在保存全部设置..." });
    try {
      const failures: string[] = [];
      for (const field of SETTING_FIELDS) {
        const response = await setCommonSetting(field.path, settings[field.path]);
        recordResponse(response);
        if (!response.success) {
          failures.push(field.path);
        }
      }

      await refreshSettings();
      markUpdated();
      if (failures.length > 0) {
        setNotice({
          kind: "error",
          text: `部分设置保存失败: ${failures.join(", ")}`,
        });
      } else {
        setNotice({ kind: "success", text: "全部设置已保存" });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  const badgeClass = notice ? `notice notice-${notice.kind}` : "notice notice-info";

  return (
    <div className="app-shell">
      <header className="header">
        <div>
          <h1>Clawset Desktop</h1>
          <p>OpenClaw Gateway P0 MVP</p>
        </div>
        <div className="header-meta">
          <span className="stamp">Last Updated: {lastUpdated}</span>
          {busyAction ? <span className="stamp">Running: {busyAction}</span> : null}
        </div>
      </header>

      <div className={badgeClass}>{notice ? notice.text : "就绪"}</div>

      <main className="grid-layout">
        <section className="panel panel-overview">
          <h2>Overview</h2>
          <div className="kv-grid">
            <div className="kv-row">
              <span>OpenClaw</span>
              <strong>{overview.installed ? "Installed" : "Not Installed"}</strong>
            </div>
            <div className="kv-row">
              <span>Version</span>
              <strong>{overview.version}</strong>
            </div>
            <div className="kv-row">
              <span>Path</span>
              <strong>{overview.path}</strong>
            </div>
            <div className="kv-row">
              <span>Config File</span>
              <strong>{overview.configFile}</strong>
            </div>
          </div>
        </section>

        <section className="panel panel-actions">
          <h2>Actions</h2>
          <div className="actions-grid">
            <button
              className="btn btn-primary"
              onClick={handleInstall}
              disabled={Boolean(busyAction)}
            >
              {isBusy("install") ? "Installing..." : "Install"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => handleGatewayAction("start")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-start") ? "Starting..." : "Start"}
            </button>
            <button
              className="btn btn-warning"
              onClick={() => handleGatewayAction("stop")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-stop") ? "Stopping..." : "Stop"}
            </button>
            <button
              className="btn btn-warning"
              onClick={() => handleGatewayAction("restart")}
              disabled={Boolean(busyAction)}
            >
              {isBusy("gateway-restart") ? "Restarting..." : "Restart"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleRefreshStatus}
              disabled={Boolean(busyAction)}
            >
              {isBusy("status") ? "Refreshing..." : "Refresh Status"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleOpenDashboard}
              disabled={Boolean(busyAction)}
            >
              {isBusy("dashboard") ? "Opening..." : "Open Dashboard"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void refreshAll();
              }}
              disabled={Boolean(busyAction)}
            >
              {isBusy("boot") ? "Refreshing..." : "Refresh All"}
            </button>
          </div>
        </section>

        <section className="panel panel-status">
          <h2>Gateway Status</h2>
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
            <p className="empty">无法解析 JSON，已展示原始输出。</p>
          )}
          <label className="field-label">Raw output</label>
          <pre className="raw">{gatewayRaw || "(empty)"}</pre>
        </section>

        <section className="panel panel-settings">
          <div className="settings-title">
            <h2>Settings</h2>
            <div className="settings-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  void runAction("reload-settings", "刷新配置", getCommonSettings, async () => {
                    await refreshSettings();
                  });
                }}
                disabled={Boolean(busyAction)}
              >
                {isBusy("reload-settings") ? "Reloading..." : "Reload Settings"}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void handleSaveAll();
                }}
                disabled={Boolean(busyAction)}
              >
                {isBusy("save-all") ? "Saving..." : "Save All"}
              </button>
            </div>
          </div>

          <div className="settings-grid">
            {SETTING_FIELDS.map((field) => (
              <div key={field.path} className="setting-card">
                <label className="field-label" htmlFor={field.path}>
                  {field.label}
                </label>
                <small className="field-help">{field.description}</small>
                {field.control === "boolean" ? (
                  <select
                    id={field.path}
                    value={normalizeBoolean(settings[field.path])}
                    onChange={(event) => {
                      handleSettingChange(field.path, event.target.value);
                    }}
                    disabled={Boolean(busyAction)}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
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
                  {isBusy(`save-${field.path}`) ? "Saving..." : "Save"}
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="panel panel-output">
          <h2>Latest Command Output</h2>
          <pre className="raw">{lastCommandOutput || "(none)"}</pre>
        </section>
      </main>
    </div>
  );
}
