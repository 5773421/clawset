export interface CommandResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  message: string;
  parsed_json?: unknown | null;
}

export type GatewayAction = "start" | "stop" | "restart";

export type SettingPath =
  | "update.channel"
  | "update.checkOnStart"
  | "acp.enabled"
  | "acp.defaultAgent"
  | "agents.defaults.thinkingDefault"
  | "agents.defaults.heartbeat.every";

export type CommonSettings = Record<SettingPath, string>;
