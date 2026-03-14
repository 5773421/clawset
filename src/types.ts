export interface CommandResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  message: string;
  parsed_json?: unknown | null;
}

export interface WriteOpenclawProviderPayload {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  defaultModel: string;
}

export interface BackupEntry {
  path: string;
  filename: string;
  size_bytes: number;
  modified_secs: number;
}
