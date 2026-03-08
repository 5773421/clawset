#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::process::Command;

const COMMON_SETTING_PATHS: [&str; 6] = [
    "update.channel",
    "update.checkOnStart",
    "acp.enabled",
    "acp.defaultAgent",
    "agents.defaults.thinkingDefault",
    "agents.defaults.heartbeat.every",
];

#[derive(Debug, Clone)]
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

fn extract_command_path(raw_stdout: &str) -> Option<String> {
    for line in clean_non_empty_lines(raw_stdout) {
        if looks_like_path(line.as_str()) {
            return Some(line);
        }

        for token in line.split_whitespace() {
            let candidate = normalize_token(token);
            if looks_like_path(candidate) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn first_existing_file_path(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn first_existing_dir_path(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| candidate.is_dir())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn known_openclaw_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(home.join(".openclaw").join("bin").join("openclaw"));
        candidates.push(home.join(".local").join("bin").join("openclaw"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/openclaw"));
    candidates.push(PathBuf::from("/usr/bin/openclaw"));
    candidates
}

fn known_openclaw_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".openclaw"));
    }
    if let Some(path) = std::env::var_os("OPENCLAW_HOME") {
        dirs.push(PathBuf::from(path));
    }
    dirs
}

fn default_openclaw_config_file() -> Option<String> {
    let candidate = home_dir()?.join(".openclaw").join("openclaw.json");
    if candidate.is_file() {
        Some(candidate.to_string_lossy().to_string())
    } else {
        None
    }
}

fn extract_version_text(raw_stdout: &str) -> String {
    let lines = clean_non_empty_lines(raw_stdout);
    for line in lines.iter().rev() {
        if line_seems_banner_noise(line) {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.contains("version") || line.chars().any(|ch| ch.is_ascii_digit()) {
            return line.trim().to_string();
        }
    }

    for line in lines.iter().rev() {
        if !line_seems_banner_noise(line) {
            return line.trim().to_string();
        }
    }

    String::new()
}

fn should_prefer_alternative_exec(primary: &ExecOutput, alternative: &ExecOutput) -> bool {
    let primary_strong = primary.exit_code == 0 && !primary.stdout.is_empty();
    if primary_strong {
        return false;
    }

    let alternative_strong = alternative.exit_code == 0 && !alternative.stdout.is_empty();
    if alternative_strong {
        return true;
    }

    (primary.exit_code != 0 && alternative.exit_code == 0)
        || (primary.stdout.is_empty() && !alternative.stdout.is_empty())
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
    let path_probe = run_shell("command -v openclaw");
    let command_path = extract_command_path(&path_probe.stdout);
    let fallback_path = first_existing_file_path(&known_openclaw_binary_candidates());
    let executable_path = command_path.clone().or(fallback_path.clone());
    let install_dir = first_existing_dir_path(&known_openclaw_install_dirs());

    let version_on_path = run_command("openclaw", &["--version"]);
    let config_on_path = run_command("openclaw", &["config", "file"]);

    let alternative_version = executable_path.as_ref().and_then(|program| {
        if program == "openclaw" {
            None
        } else {
            Some((program.clone(), run_command(program, &["--version"])))
        }
    });
    let alternative_config = executable_path.as_ref().and_then(|program| {
        if program == "openclaw" {
            None
        } else {
            Some((program.clone(), run_command(program, &["config", "file"])))
        }
    });

    let version = if let Some((_, alt)) = &alternative_version {
        if should_prefer_alternative_exec(&version_on_path, alt) {
            alt.clone()
        } else {
            version_on_path.clone()
        }
    } else {
        version_on_path.clone()
    };

    let config_file = if let Some((_, alt)) = &alternative_config {
        if should_prefer_alternative_exec(&config_on_path, alt) {
            alt.clone()
        } else {
            config_on_path.clone()
        }
    } else {
        config_on_path.clone()
    };

    let version_text = extract_version_text(&version.stdout);
    let config_file_path = if config_file.exit_code == 0 {
        let extracted = extract_config_file_path(&config_file.stdout);
        if extracted.is_empty() {
            default_openclaw_config_file().unwrap_or_default()
        } else {
            extracted
        }
    } else {
        default_openclaw_config_file().unwrap_or_default()
    };
    let display_path = executable_path.unwrap_or_default();

    let has_executable = !display_path.is_empty();
    let has_install_dir = install_dir.is_some();
    let has_config_file = !config_file_path.is_empty();
    let has_version_signal = version.exit_code == 0 || !version_text.is_empty();

    let mut detected_by = Vec::new();
    if has_executable {
        detected_by.push("executable_path");
    }
    if has_install_dir {
        detected_by.push("install_dir");
    }
    if has_config_file {
        detected_by.push("config_file");
    }
    if has_version_signal {
        detected_by.push("version");
    }

    let success = has_executable || has_install_dir || has_config_file || has_version_signal;
    let install_dir_text = install_dir.unwrap_or_default();

    let mut stdout_lines = vec![
        format!("installed: {}", success),
        format!(
            "detected_by: {}",
            if detected_by.is_empty() {
                "(none)".to_string()
            } else {
                detected_by.join(",")
            }
        ),
        format!(
            "version: {}",
            if version_text.is_empty() {
                "(empty)"
            } else {
                version_text.as_str()
            }
        ),
        format!(
            "path: {}",
            if display_path.is_empty() {
                "(empty)"
            } else {
                display_path.as_str()
            }
        ),
        format!(
            "install_dir: {}",
            if install_dir_text.is_empty() {
                "(empty)"
            } else {
                install_dir_text.as_str()
            }
        ),
    ];
    stdout_lines.push(format!(
        "config_file: {}",
        if config_file_path.is_empty() {
            "(empty)"
        } else {
            config_file_path.as_str()
        }
    ));

    let mut stderr_lines = Vec::new();
    if !version_on_path.stderr.is_empty() {
        stderr_lines.push(format!("openclaw --version: {}", version_on_path.stderr));
    }
    if let Some((program, alt)) = &alternative_version {
        if !alt.stderr.is_empty() {
            stderr_lines.push(format!("{program} --version: {}", alt.stderr));
        }
    }
    if !path_probe.stderr.is_empty() {
        stderr_lines.push(format!("command -v openclaw: {}", path_probe.stderr));
    }
    if !config_on_path.stderr.is_empty() {
        stderr_lines.push(format!("openclaw config file: {}", config_on_path.stderr));
    }
    if let Some((program, alt)) = &alternative_config {
        if !alt.stderr.is_empty() {
            stderr_lines.push(format!("{program} config file: {}", alt.stderr));
        }
    }
    CommandResponse {
        success,
        stdout: stdout_lines.join("\n"),
        stderr: stderr_lines.join("\n"),
        exit_code: if success {
            0
        } else {
            version_on_path.exit_code
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

    #[test]
    fn extracts_command_path_from_command_v_output() {
        let raw = "\
openclaw is /opt/homebrew/bin/openclaw
";
        assert_eq!(
            extract_command_path(raw),
            Some("/opt/homebrew/bin/openclaw".to_string())
        );
    }

    #[test]
    fn picks_first_existing_file_path() {
        let base = std::env::temp_dir().join(format!("clawset-test-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create temp dir");

        let missing = base.join("missing-openclaw");
        let existing = base.join("openclaw");
        std::fs::write(&existing, "#!/bin/sh\necho ok\n").expect("create temp file");

        assert_eq!(
            first_existing_file_path(&[missing, existing.clone()]),
            Some(existing.to_string_lossy().to_string())
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn picks_first_existing_dir_path() {
        let base = std::env::temp_dir().join(format!("clawset-test-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let missing = base.join("missing");
        let existing = base.join("exists");
        std::fs::create_dir_all(&existing).expect("create existing dir");

        assert_eq!(
            first_existing_dir_path(&[missing, existing.clone()]),
            Some(existing.to_string_lossy().to_string())
        );

        let _ = std::fs::remove_dir_all(&base);
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
