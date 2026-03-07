#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{Map, Value};
use std::process::Command;

const COMMON_SETTING_PATHS: [&str; 6] = [
    "update.channel",
    "update.checkOnStart",
    "acp.enabled",
    "acp.defaultAgent",
    "agents.defaults.thinkingDefault",
    "agents.defaults.heartbeat.every",
];

#[derive(Debug)]
struct ExecOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
struct CommandResponse {
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: i32,
    message: String,
    parsed_json: Option<Value>,
}

impl CommandResponse {
    fn from_exec(exec: ExecOutput, message: impl Into<String>) -> Self {
        Self {
            success: exec.exit_code == 0,
            stdout: exec.stdout,
            stderr: exec.stderr,
            exit_code: exec.exit_code,
            message: message.into(),
            parsed_json: None,
        }
    }

    fn failure(message: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self {
            success: false,
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code: -1,
            message: message.into(),
            parsed_json: None,
        }
    }
}

fn run_command(program: &str, args: &[&str]) -> ExecOutput {
    match Command::new(program).args(args).output() {
        Ok(output) => ExecOutput {
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        },
        Err(error) => ExecOutput {
            stdout: String::new(),
            stderr: error.to_string(),
            exit_code: -1,
        },
    }
}

fn run_shell(command: &str) -> ExecOutput {
    run_command("sh", &["-lc", command])
}

fn is_allowed_setting(path: &str) -> bool {
    COMMON_SETTING_PATHS.contains(&path)
}

fn strip_ansi_sequences(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            0x1B => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }

                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() {
                            let b = bytes[i];
                            i += 1;
                            if (0x40..=0x7E).contains(&b) {
                                break;
                            }
                        }
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => {
                        i += 1;
                    }
                }
            }
            0x9B => {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7E).contains(&b) {
                        break;
                    }
                }
            }
            b => {
                output.push(b);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).to_string()
}

fn clean_cli_text(text: &str) -> String {
    strip_ansi_sequences(text)
        .replace('\r', "\n")
        .replace('\u{0000}', "")
}

fn clean_non_empty_lines(text: &str) -> Vec<String> {
    clean_cli_text(text)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_token(token: &str) -> &str {
    token.trim_matches(|c: char| {
        c == '"'
            || c == '\''
            || c == '`'
            || c == ','
            || c == ';'
            || c == ')'
            || c == ']'
            || c == '}'
            || c == '('
            || c == '['
            || c == '{'
    })
}

fn looks_like_path(value: &str) -> bool {
    if value.is_empty() || value.starts_with("https://") || value.starts_with("http://") {
        return false;
    }

    if value.starts_with("~/")
        || value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
    {
        return true;
    }

    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }

    (value.contains('/') || value.contains('\\'))
        && !value.contains(char::is_whitespace)
        && value.chars().any(|ch| ch.is_ascii_alphanumeric())
}

fn extract_config_file_path(raw_stdout: &str) -> String {
    let lines = clean_non_empty_lines(raw_stdout);
    for line in lines.iter().rev() {
        for token in line.split_whitespace() {
            let candidate = normalize_token(token);
            if looks_like_path(candidate) {
                return candidate.to_string();
            }
        }
    }

    lines
        .last()
        .cloned()
        .unwrap_or_else(|| clean_cli_text(raw_stdout).trim().to_string())
}

fn line_seems_banner_noise(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("openclaw")
        && !lower.contains(".openclaw/")
        && !lower.contains("/openclaw")
        && !lower.contains("\\openclaw")
    {
        return true;
    }

    if lower.contains("documentation")
        || lower.contains("docs")
        || lower.contains("community")
        || lower.contains("welcome")
    {
        return true;
    }

    line.chars().all(|ch| !ch.is_ascii_alphanumeric())
}

fn extract_config_get_value(path: &str, raw_stdout: &str) -> String {
    let lines = clean_non_empty_lines(raw_stdout);
    for line in lines.iter().rev() {
        if let Some((left, right)) = line.split_once('=') {
            if left.trim() == path {
                return right.trim().to_string();
            }
        }
        if let Some((left, right)) = line.split_once(':') {
            if left.trim() == path {
                return right.trim().to_string();
            }
        }
    }

    for line in lines.iter().rev() {
        if !line_seems_banner_noise(line) {
            return line.trim().to_string();
        }
    }

    lines
        .last()
        .cloned()
        .unwrap_or_else(|| clean_cli_text(raw_stdout).trim().to_string())
}

fn extract_url(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|item| {
        let cleaned = item.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == ';');
        if cleaned.starts_with("https://") || cleaned.starts_with("http://") {
            Some(cleaned.to_string())
        } else {
            None
        }
    })
}

fn open_url(url: &str) -> ExecOutput {
    #[cfg(target_os = "macos")]
    {
        return run_command("open", &[url]);
    }

    #[cfg(target_os = "linux")]
    {
        return run_command("xdg-open", &[url]);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        ExecOutput {
            stdout: String::new(),
            stderr: "Unsupported platform for opening dashboard URL".to_string(),
            exit_code: -1,
        }
    }
}

#[tauri::command]
fn detect_openclaw() -> CommandResponse {
    let version = run_command("openclaw", &["--version"]);
    let path = run_shell("command -v openclaw");
    let config_file = run_command("openclaw", &["config", "file"]);

    let mut stdout_lines = vec![
        format!(
            "version: {}",
            if version.stdout.is_empty() {
                "(empty)"
            } else {
                &version.stdout
            }
        ),
        format!(
            "path: {}",
            if path.stdout.is_empty() {
                "(empty)"
            } else {
                &path.stdout
            }
        ),
    ];
    if config_file.exit_code == 0 {
        stdout_lines.push(format!(
            "config_file: {}",
            extract_config_file_path(&config_file.stdout)
        ));
    }

    let mut stderr_lines = Vec::new();
    if !version.stderr.is_empty() {
        stderr_lines.push(format!("openclaw --version: {}", version.stderr));
    }
    if !path.stderr.is_empty() {
        stderr_lines.push(format!("command -v openclaw: {}", path.stderr));
    }
    if !config_file.stderr.is_empty() {
        stderr_lines.push(format!("openclaw config file: {}", config_file.stderr));
    }

    let success = version.exit_code == 0 && path.exit_code == 0;
    CommandResponse {
        success,
        stdout: stdout_lines.join("\n"),
        stderr: stderr_lines.join("\n"),
        exit_code: if success {
            0
        } else if version.exit_code != 0 {
            version.exit_code
        } else {
            path.exit_code
        },
        message: if success {
            "OpenClaw detected".to_string()
        } else {
            "OpenClaw not detected".to_string()
        },
        parsed_json: None,
    }
}

#[tauri::command]
fn install_openclaw() -> CommandResponse {
    let exec = run_shell(
        "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard --no-prompt",
    );
    let mut response = CommandResponse::from_exec(exec, "Install command finished");
    if response.success {
        response.message = "OpenClaw install completed".to_string();
    } else {
        response.message = "OpenClaw install failed".to_string();
    }
    response
}

#[tauri::command]
fn gateway_control(action: String) -> CommandResponse {
    let action = action.to_lowercase();
    if action != "start" && action != "stop" && action != "restart" {
        return CommandResponse::failure(
            "Invalid action; use start|stop|restart",
            format!("unsupported action: {action}"),
        );
    }

    let exec = run_command("openclaw", &["gateway", action.as_str(), "--json"]);
    let mut response =
        CommandResponse::from_exec(exec, format!("Gateway {} command completed", action));
    if !response.success {
        response.message = format!("Gateway {} failed", action);
    }
    response
}

#[tauri::command]
fn gateway_status() -> CommandResponse {
    let exec = run_command("openclaw", &["gateway", "status", "--json"]);
    let parsed_json = serde_json::from_str::<Value>(&exec.stdout).ok();

    let mut response = CommandResponse::from_exec(exec, "Gateway status fetched");
    response.parsed_json = parsed_json;
    if response.success && response.parsed_json.is_none() {
        response.message = "Gateway status fetched but stdout is not valid JSON".to_string();
    }
    response
}

#[tauri::command]
fn get_config_file() -> CommandResponse {
    let exec = run_command("openclaw", &["config", "file"]);
    let mut response = CommandResponse::from_exec(exec, "Config file path fetched");
    if response.success {
        response.stdout = extract_config_file_path(&response.stdout);
    } else {
        response.stdout = clean_cli_text(&response.stdout).trim().to_string();
        response.stderr = clean_cli_text(&response.stderr).trim().to_string();
    }
    if !response.success {
        response.message = "Failed to fetch config file path".to_string();
    }
    response
}

#[tauri::command]
fn get_common_settings() -> CommandResponse {
    let mut parsed_settings = Map::new();
    let mut stdout_lines = Vec::new();
    let mut stderr_lines = Vec::new();
    let mut exit_code = 0;
    let mut success = true;

    for path in COMMON_SETTING_PATHS {
        let exec = run_command("openclaw", &["config", "get", path]);
        if exec.exit_code == 0 {
            let value = extract_config_get_value(path, &exec.stdout);
            parsed_settings.insert(path.to_string(), Value::String(value.clone()));
            stdout_lines.push(format!("{path}={value}"));
        } else {
            success = false;
            if exit_code == 0 {
                exit_code = exec.exit_code;
            }
            parsed_settings.insert(path.to_string(), Value::Null);
            stdout_lines.push(format!("{path}="));
            if exec.stderr.is_empty() {
                stderr_lines.push(format!("{path}: unknown error"));
            } else {
                stderr_lines.push(format!("{path}: {}", exec.stderr));
            }
        }
    }

    CommandResponse {
        success,
        stdout: stdout_lines.join("\n"),
        stderr: stderr_lines.join("\n"),
        exit_code: if success { 0 } else { exit_code },
        message: if success {
            "Common settings loaded".to_string()
        } else {
            "Some settings failed to load".to_string()
        },
        parsed_json: Some(Value::Object(parsed_settings)),
    }
}

#[tauri::command]
fn set_common_setting(path: String, value: String) -> CommandResponse {
    if !is_allowed_setting(&path) {
        return CommandResponse::failure(
            "Unsupported config path",
            format!("path is not allowed: {path}"),
        );
    }

    let exec = run_command(
        "openclaw",
        &["config", "set", path.as_str(), value.as_str()],
    );
    let mut response = CommandResponse::from_exec(exec, format!("Updated setting {path}"));
    if !response.success {
        response.message = format!("Failed to update {path}");
    }
    response
}

#[tauri::command]
fn open_dashboard() -> CommandResponse {
    let dashboard_exec = run_command("openclaw", &["dashboard", "--no-open"]);
    if dashboard_exec.exit_code != 0 {
        return CommandResponse::from_exec(dashboard_exec, "Failed to fetch dashboard URL");
    }

    let url = match extract_url(&dashboard_exec.stdout) {
        Some(value) => value,
        None => {
            return CommandResponse {
                success: false,
                stdout: dashboard_exec.stdout,
                stderr: "No URL found in `openclaw dashboard --no-open` output".to_string(),
                exit_code: -1,
                message: "Dashboard URL not found".to_string(),
                parsed_json: None,
            }
        }
    };

    let opener_exec = open_url(&url);
    let success = opener_exec.exit_code == 0;

    let mut stderr_lines = Vec::new();
    if !dashboard_exec.stderr.is_empty() {
        stderr_lines.push(format!("dashboard stderr: {}", dashboard_exec.stderr));
    }
    if !opener_exec.stderr.is_empty() {
        stderr_lines.push(format!("open url stderr: {}", opener_exec.stderr));
    }

    CommandResponse {
        success,
        stdout: format!(
            "dashboard_url: {}\nraw:\n{}",
            url,
            if dashboard_exec.stdout.is_empty() {
                "(empty)"
            } else {
                dashboard_exec.stdout.as_str()
            }
        ),
        stderr: stderr_lines.join("\n"),
        exit_code: if success { 0 } else { opener_exec.exit_code },
        message: if success {
            "Dashboard opened".to_string()
        } else {
            "Failed to open dashboard URL".to_string()
        },
        parsed_json: Some(serde_json::json!({ "url": url })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_preserves_utf8_content() {
        let raw = "\u{1b}[32m路径: ~/.openclaw/openclaw.json\u{1b}[0m";
        assert_eq!(strip_ansi_sequences(raw), "路径: ~/.openclaw/openclaw.json");
    }

    #[test]
    fn extracts_config_file_path_from_noisy_output() {
        let raw = "\
\u{1b}[35mOpenClaw CLI\u{1b}[0m
Welcome to OpenClaw
Config file: ~/.openclaw/openclaw.json";

        assert_eq!(extract_config_file_path(raw), "~/.openclaw/openclaw.json");
    }

    #[test]
    fn extracts_config_get_value_from_key_value_line() {
        let raw = "\
\u{1b}[36mOpenClaw CLI\u{1b}[0m
update.channel = stable";

        assert_eq!(extract_config_get_value("update.channel", raw), "stable");
    }

    #[test]
    fn extracts_config_get_value_from_last_non_banner_line() {
        let raw = "\
\u{1b}[36mOpenClaw CLI\u{1b}[0m
Documentation: https://openclaw.ai/docs
beta";

        assert_eq!(extract_config_get_value("update.channel", raw), "beta");
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_openclaw,
            install_openclaw,
            gateway_control,
            gateway_status,
            get_config_file,
            get_common_settings,
            set_common_setting,
            open_dashboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
