import { invoke } from "@tauri-apps/api/core";
import type { CommandResponse, GatewayAction, SettingPath } from "../types";

function call<T extends CommandResponse>(
  command: string,
  args?: Record<string, unknown>,
) {
  return invoke<T>(command, args);
}

export function detectOpenclaw() {
  return call("detect_openclaw");
}

export function installOpenclaw() {
  return call("install_openclaw");
}

export function gatewayControl(action: GatewayAction) {
  return call("gateway_control", { action });
}

export function gatewayStatus() {
  return call("gateway_status");
}

export function getConfigFile() {
  return call("get_config_file");
}

export function getCommonSettings() {
  return call("get_common_settings");
}

export function setCommonSetting(path: SettingPath, value: string) {
  return call("set_common_setting", { path, value });
}

export function openDashboard() {
  return call("open_dashboard");
}
