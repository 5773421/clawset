import { invoke } from "@tauri-apps/api/core";
import type {
  CommandResponse,
  WriteOpenclawProviderPayload,
} from "../types";

const PREVIEW_MODE_MESSAGE =
  "Desktop runtime is unavailable in browser preview mode. Please run this app in Tauri.";

function isTauriRuntimeAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return "__TAURI_INTERNALS__" in window;
}

function nonTauriFallback(command: string): CommandResponse {
  return {
    success: false,
    stdout: "",
    stderr: "",
    exit_code: -1,
    message: `${PREVIEW_MODE_MESSAGE} (command: ${command})`,
    parsed_json: null,
  };
}

function call<T extends CommandResponse>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntimeAvailable()) {
    return Promise.resolve(nonTauriFallback(command) as T);
  }

  return invoke<T>(command, args);
}

export function detectOpenclaw() {
  return call("detect_openclaw");
}

export function installOpenclaw() {
  return call("install_openclaw");
}

export function gatewayStatus() {
  return call("gateway_status");
}

export function openDashboard() {
  return call("open_dashboard");
}

export function readOpenclawProviders() {
  return call("read_openclaw_providers");
}

export function writeOpenclawProvider(payload: WriteOpenclawProviderPayload) {
  return call("write_openclaw_provider", {
    providerName: payload.providerName,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    api: payload.api,
    defaultModel: payload.defaultModel,
  });
}

export function runOpenclawOnboard() {
  return call("run_openclaw_onboard");
}
