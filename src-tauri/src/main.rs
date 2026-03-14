#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const OPENCLAW_PROGRAM: &str = "openclaw";
const DEFAULT_OPENCLAW_GATEWAY_PORT: u16 = 18789;
const GATEWAY_STATUS_RETRY_DELAYS_MS: [u64; 4] = [300, 500, 800, 800];
const OPENCLAW_COMPATIBILITY_VALUES: [&str; 8] = [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "google-generative-ai",
    "github-copilot",
    "bedrock-converse-stream",
    "ollama",
];
#[derive(Debug, Clone)]
struct ExecOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Clone)]
struct GatewayStatusRetryOutcome {
    last_exec: ExecOutput,
    last_status: Option<Value>,
    recovered: bool,
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
    run_command_with_path(program, args, None)
}

fn run_command_with_path(program: &str, args: &[&str], path_override: Option<&str>) -> ExecOutput {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(path_value) = path_override {
        command.env("PATH", path_value);
    }

    match command.output() {
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
    run_shell_with_path(command, None)
}

fn run_shell_with_path(command: &str, path_override: Option<&str>) -> ExecOutput {
    run_command_with_path("sh", &["-lc", command], path_override)
}

#[derive(Debug, Clone)]
struct OpenclawExecutableResolution {
    path_probe: ExecOutput,
    command_path: Option<String>,
    fallback_path: Option<String>,
    executable_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OpenclawLaunchStrategy {
    Program {
        program: String,
    },
    NodeScript {
        node_path: String,
        script_path: String,
    },
}

#[derive(Debug, Clone)]
struct OpenclawExecutionContext {
    resolution: OpenclawExecutableResolution,
    strategy: OpenclawLaunchStrategy,
    path_override: Option<String>,
}

fn select_openclaw_executable(
    command_path: Option<String>,
    fallback_path: Option<String>,
) -> Option<String> {
    command_path
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fallback_path.filter(|value| !value.trim().is_empty()))
}

fn openclaw_program(executable_path: Option<&str>) -> String {
    executable_path
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(OPENCLAW_PROGRAM)
        .to_string()
}

fn missing_binary_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("no such file or directory")
        || lower.contains("os error 2")
        || lower.contains("not found")
        || lower.contains("cannot find the file")
}

fn should_retry_openclaw_with_fallback(program: &str, exec: &ExecOutput) -> bool {
    program != OPENCLAW_PROGRAM && exec.exit_code == -1 && missing_binary_error(&exec.stderr)
}

fn resolve_openclaw_executable() -> OpenclawExecutableResolution {
    let path_probe = run_shell("command -v openclaw");
    let command_path = extract_command_path(&path_probe.stdout);
    let fallback_path = first_existing_file_path(&known_openclaw_binary_candidates());
    let executable_path = select_openclaw_executable(command_path.clone(), fallback_path.clone());
    OpenclawExecutableResolution {
        path_probe,
        command_path,
        fallback_path,
        executable_path,
    }
}

fn shebang_uses_env_node(line: &str) -> bool {
    let Some(content) = line.trim().strip_prefix("#!") else {
        return false;
    };
    let mut parts = content.split_whitespace();
    let Some(env_path) = parts.next() else {
        return false;
    };
    if env_path != "/usr/bin/env" && env_path != "/bin/env" {
        return false;
    }

    let Some(next) = parts.next() else {
        return false;
    };
    if next == "node" {
        return true;
    }

    next == "-S" && parts.next() == Some("node")
}

fn has_env_node_shebang(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let first_line_end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(bytes.len());
    let first_line = String::from_utf8_lossy(&bytes[..first_line_end]);
    shebang_uses_env_node(first_line.trim_end_matches('\r'))
}

fn detect_node_shebang_script_path(executable_path: &str) -> Option<String> {
    let path = Path::new(executable_path);
    if path.is_file() && has_env_node_shebang(path) {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}

fn parse_node_version_name(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.strip_prefix('v').unwrap_or(value);
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn known_nvm_node_binary_candidates(home: &Path) -> Vec<PathBuf> {
    let versions_dir = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return Vec::new();
    };

    let mut versioned_paths: Vec<(Option<(u64, u64, u64)>, String, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let version_name = path.file_name()?.to_string_lossy().to_string();
            let node_path = path.join("bin").join("node");
            Some((
                parse_node_version_name(version_name.as_str()),
                version_name,
                node_path,
            ))
        })
        .collect();

    versioned_paths.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

    versioned_paths
        .into_iter()
        .map(|(_, _, path)| path)
        .collect()
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    for path in paths {
        let key = path.to_string_lossy().to_string();
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            result.push(path);
        }
    }

    result
}

fn known_node_binary_candidates(script_path: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = script_path {
        if let Some(parent) = path.parent() {
            candidates.push(parent.join("node"));
        }
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".nvm").join("current").join("bin").join("node"));
        candidates.extend(known_nvm_node_binary_candidates(&home));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    candidates.push(PathBuf::from("/opt/homebrew/opt/node/bin/node"));
    candidates.push(PathBuf::from("/usr/local/bin/node"));
    candidates.push(PathBuf::from("/usr/bin/node"));
    candidates.push(PathBuf::from("/bin/node"));

    dedup_paths(candidates)
}

fn resolve_node_for_openclaw_script(script_path: &str) -> Option<String> {
    let node_probe = run_shell("command -v node");
    if let Some(path) = extract_command_path(&node_probe.stdout) {
        if Path::new(path.as_str()).is_file() {
            return Some(path);
        }
    }

    let script = Path::new(script_path);
    first_existing_file_path(&known_node_binary_candidates(Some(script)))
}

fn known_exec_path_candidates(
    executable_path: Option<&str>,
    node_path: Option<&str>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = executable_path {
        if let Some(parent) = Path::new(path).parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    if let Some(path) = node_path {
        if let Some(parent) = Path::new(path).parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".openclaw").join("bin"));
        candidates.push(home.join(".local").join("bin"));
        candidates.push(home.join(".nvm").join("current").join("bin"));
        candidates.extend(
            known_nvm_node_binary_candidates(&home)
                .into_iter()
                .filter_map(|path| path.parent().map(|parent| parent.to_path_buf())),
        );
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin"));
    candidates.push(PathBuf::from("/opt/homebrew/opt/node/bin"));
    candidates.push(PathBuf::from("/usr/local/bin"));
    candidates.push(PathBuf::from("/usr/bin"));
    candidates.push(PathBuf::from("/bin"));
    candidates.push(PathBuf::from("/usr/sbin"));
    candidates.push(PathBuf::from("/sbin"));

    dedup_paths(candidates)
}

fn build_augmented_exec_path(
    executable_path: Option<&str>,
    node_path: Option<&str>,
) -> Option<String> {
    build_path_override_from_candidates(
        known_exec_path_candidates(executable_path, node_path),
        true,
    )
}

fn build_path_override_from_candidates(
    candidates: Vec<PathBuf>,
    require_existing_dirs: bool,
) -> Option<String> {
    let mut ordered_paths = Vec::new();
    let mut seen = HashSet::new();

    for candidate in candidates {
        if require_existing_dirs && !candidate.is_dir() {
            continue;
        }
        let key = candidate.to_string_lossy().to_string();
        if seen.insert(key) {
            ordered_paths.push(candidate);
        }
    }

    if let Some(base_path) = std::env::var_os("PATH") {
        for value in std::env::split_paths(&base_path) {
            let key = value.to_string_lossy().to_string();
            if key.is_empty() {
                continue;
            }
            if seen.insert(key) {
                ordered_paths.push(value);
            }
        }
    }

    if ordered_paths.is_empty() {
        return None;
    }

    std::env::join_paths(ordered_paths)
        .ok()
        .map(|value| value.to_string_lossy().to_string())
}

fn build_install_shell_path() -> Option<String> {
    build_path_override_from_candidates(known_exec_path_candidates(None, None), false)
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn choose_openclaw_launch_strategy(
    program: String,
    node_script_path: Option<String>,
    node_path: Option<String>,
) -> OpenclawLaunchStrategy {
    match (node_script_path, node_path) {
        (Some(script_path), Some(node_path)) => OpenclawLaunchStrategy::NodeScript {
            node_path,
            script_path,
        },
        _ => OpenclawLaunchStrategy::Program { program },
    }
}

fn resolve_openclaw_execution_context() -> OpenclawExecutionContext {
    let resolution = resolve_openclaw_executable();
    let program = openclaw_program(resolution.executable_path.as_deref());
    let node_script_path = resolution
        .executable_path
        .as_deref()
        .and_then(detect_node_shebang_script_path);
    let node_path = node_script_path
        .as_deref()
        .and_then(resolve_node_for_openclaw_script);

    let strategy = choose_openclaw_launch_strategy(program, node_script_path, node_path.clone());
    let path_override =
        build_augmented_exec_path(resolution.executable_path.as_deref(), node_path.as_deref());

    OpenclawExecutionContext {
        resolution,
        strategy,
        path_override,
    }
}

fn run_openclaw_command_with_context(
    context: &OpenclawExecutionContext,
    args: &[&str],
) -> ExecOutput {
    match &context.strategy {
        OpenclawLaunchStrategy::NodeScript {
            node_path,
            script_path,
        } => {
            let mut node_args = Vec::with_capacity(args.len() + 1);
            node_args.push(script_path.as_str());
            node_args.extend_from_slice(args);
            run_command_with_path(
                node_path.as_str(),
                &node_args,
                context.path_override.as_deref(),
            )
        }
        OpenclawLaunchStrategy::Program { program } => {
            let exec =
                run_command_with_path(program.as_str(), args, context.path_override.as_deref());
            if should_retry_openclaw_with_fallback(program.as_str(), &exec) {
                run_command_with_path(OPENCLAW_PROGRAM, args, context.path_override.as_deref())
            } else {
                exec
            }
        }
    }
}

fn run_openclaw_command(args: &[&str]) -> ExecOutput {
    let context = resolve_openclaw_execution_context();
    run_openclaw_command_with_context(&context, args)
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

fn first_non_empty_cli_line(text: &str) -> Option<String> {
    clean_non_empty_lines(text).into_iter().next()
}

fn is_warning_only_cli_line(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }

    lower.starts_with("warning:")
        || lower.starts_with("warn:")
        || lower.contains("running in non-interactive mode because stdin is not a tty")
}

fn is_non_actionable_cli_line(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }

    is_warning_only_cli_line(trimmed)
        || trimmed.starts_with("==>")
        || lower.starts_with("usage:")
        || lower.starts_with("options:")
        || lower.starts_with("🦞 openclaw")
        || lower == "stdout:"
        || lower == "stderr:"
        || lower == "exit_code:"
        || lower.ends_with(" stdout:")
        || lower.ends_with(" stderr:")
        || lower.ends_with(" exit_code:")
}

fn first_actionable_cli_line(text: &str) -> Option<String> {
    let lines = clean_non_empty_lines(text);
    lines
        .iter()
        .find(|line| !is_non_actionable_cli_line(line))
        .cloned()
        .or_else(|| {
            lines
                .into_iter()
                .find(|line| !is_warning_only_cli_line(line))
        })
}

fn pick_actionable_cli_error_line(texts: &[&str]) -> Option<String> {
    texts
        .iter()
        .find_map(|text| first_actionable_cli_line(text))
        .or_else(|| texts.iter().find_map(|text| first_non_empty_cli_line(text)))
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn parse_port_value(value: &Value) -> Option<u16> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|value| u16::try_from(value).ok()),
        Value::String(text) => text.trim().parse::<u16>().ok(),
        _ => None,
    }
}

fn parse_boolish_signal(value: Option<&Value>, truthy: &[&str], falsy: &[&str]) -> Option<bool> {
    let value = value?;
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => number.as_i64().map(|raw| raw > 0),
        Value::String(text) => {
            let normalized = text.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                None
            } else if truthy.iter().any(|token| normalized == *token) {
                Some(true)
            } else if falsy.iter().any(|token| normalized == *token) {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn gateway_service_loaded(status: &Value) -> bool {
    parse_boolish_signal(
        value_at_path(status, &["service", "loaded"]),
        &["loaded", "running", "active", "ready", "ok"],
        &["not loaded", "stopped", "inactive", "failed", "error"],
    ) == Some(true)
        || parse_boolish_signal(
            value_at_path(status, &["service", "runtime", "status"]),
            &["running", "active", "ready", "ok", "loaded"],
            &["stopped", "inactive", "failed", "error", "not loaded"],
        ) == Some(true)
        || parse_boolish_signal(
            value_at_path(status, &["service", "runtime", "state"]),
            &["running", "active", "ready", "ok", "loaded"],
            &["stopped", "inactive", "failed", "error", "not loaded"],
        ) == Some(true)
}

fn gateway_local_ready(status: &Value) -> bool {
    value_at_path(status, &["gateway", "probeUrl"])
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || parse_boolish_signal(
            value_at_path(status, &["port", "status"]),
            &[
                "busy",
                "running",
                "active",
                "ready",
                "up",
                "ok",
                "listening",
            ],
            &["free", "stopped", "failed", "down", "offline", "error"],
        ) == Some(true)
        || value_at_path(status, &["port", "listeners"])
            .and_then(Value::as_array)
            .is_some_and(|listeners| !listeners.is_empty())
}

fn gateway_rpc_ready(status: &Value) -> bool {
    parse_boolish_signal(
        value_at_path(status, &["rpc", "ok"]),
        &["true", "connected", "ready", "available", "ok"],
        &[
            "false",
            "not connected",
            "disconnected",
            "failed",
            "timeout",
            "error",
        ],
    ) == Some(true)
        || parse_boolish_signal(
            value_at_path(status, &["rpc", "status"]),
            &["connected", "ready", "available", "ok"],
            &[
                "not connected",
                "disconnected",
                "failed",
                "timeout",
                "error",
            ],
        ) == Some(true)
}

fn gateway_status_is_ready(status: &Value) -> bool {
    gateway_service_loaded(status) && gateway_local_ready(status) && gateway_rpc_ready(status)
}

fn gateway_status_needs_rpc_recovery(status: &Value) -> bool {
    gateway_service_loaded(status) && gateway_local_ready(status) && !gateway_rpc_ready(status)
}

fn text_looks_like_transient_gateway_reload(text: &str) -> bool {
    let lower = strip_ansi_sequences(text).to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }

    [
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
        "broken pipe",
        "rpc disconnected",
    ]
    .iter()
    .any(|token| lower.contains(token))
}

fn command_output_looks_like_transient_gateway_reload(exec: &ExecOutput) -> bool {
    text_looks_like_transient_gateway_reload(&exec.stdout)
        || text_looks_like_transient_gateway_reload(&exec.stderr)
}

fn should_retry_gateway_status_snapshot(exec: &ExecOutput, status: Option<&Value>) -> bool {
    status.is_some_and(gateway_status_needs_rpc_recovery)
        || command_output_looks_like_transient_gateway_reload(exec)
}

fn retry_gateway_status_until_ready(
    stdout_sections: &mut Vec<String>,
    stderr_sections: &mut Vec<String>,
) -> GatewayStatusRetryOutcome {
    append_output_section(
        stderr_sections,
        "gateway retry",
        "Transient gateway reload suspected; polling gateway status for recovery.",
    );

    let mut last_exec = ExecOutput {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: -1,
    };
    let mut last_status = None;
    let mut recovered = false;

    for (attempt, delay_ms) in GATEWAY_STATUS_RETRY_DELAYS_MS.iter().enumerate() {
        std::thread::sleep(std::time::Duration::from_millis(*delay_ms));

        let exec = run_openclaw_command(&["gateway", "status", "--json"]);
        let status = parse_json_stdout(&exec);
        append_exec_output(
            stdout_sections,
            stderr_sections,
            &format!("gateway status retry {}", attempt + 1),
            &exec,
        );

        recovered = status.as_ref().is_some_and(gateway_status_is_ready);
        last_exec = exec;
        last_status = status;
        if recovered {
            break;
        }
    }

    GatewayStatusRetryOutcome {
        last_exec,
        last_status,
        recovered,
    }
}

fn configured_gateway_port(config: &Value) -> Option<u16> {
    [
        &["gateway", "port"][..],
        &["gateway", "local", "port"],
        &["gateway", "listen", "port"],
        &["gateway", "server", "port"],
        &["port"],
    ]
    .iter()
    .find_map(|path| value_at_path(config, path).and_then(parse_port_value))
}

fn status_gateway_port(status: &Value) -> Option<u16> {
    [
        &["gateway", "port"][..],
        &["port", "port"],
        &["service", "command", "environment", "OPENCLAW_GATEWAY_PORT"],
    ]
    .iter()
    .find_map(|path| value_at_path(status, path).and_then(parse_port_value))
}

fn launch_gateway_port(initial_status: Option<&Value>) -> u16 {
    initial_status
        .and_then(status_gateway_port)
        .or_else(|| {
            read_openclaw_config_value()
                .ok()
                .and_then(|config| configured_gateway_port(&config))
        })
        .unwrap_or(DEFAULT_OPENCLAW_GATEWAY_PORT)
}

fn append_output_section(sections: &mut Vec<String>, label: &str, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }

    sections.push(format!("{label}:\n{trimmed}"));
}

fn append_exec_output(
    stdout_sections: &mut Vec<String>,
    stderr_sections: &mut Vec<String>,
    label: &str,
    exec: &ExecOutput,
) {
    append_output_section(stdout_sections, &format!("{label} stdout"), &exec.stdout);
    append_output_section(stderr_sections, &format!("{label} stderr"), &exec.stderr);
    if exec.exit_code != 0 {
        stderr_sections.push(format!("{label} exit_code: {}", exec.exit_code));
    }
}

fn parse_json_stdout(exec: &ExecOutput) -> Option<Value> {
    serde_json::from_str::<Value>(&exec.stdout).ok()
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

fn openclaw_config_path() -> Result<PathBuf, String> {
    home_dir()
        .map(|home| home.join(".openclaw").join("openclaw.json"))
        .ok_or_else(|| "HOME directory is not available".to_string())
}

fn read_openclaw_config_value_from_path(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Err(format!(
            "config file {} does not exist",
            config_path.to_string_lossy()
        ));
    }

    if !config_path.is_file() {
        return Err(format!(
            "config path {} is not a file",
            config_path.to_string_lossy()
        ));
    }

    let content = std::fs::read_to_string(config_path).map_err(|err| {
        format!(
            "failed to read config file {}: {err}",
            config_path.to_string_lossy()
        )
    })?;

    if content.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    let parsed: Value = serde_json::from_str(&content).map_err(|err| {
        format!(
            "failed to parse config file {} as JSON: {err}",
            config_path.to_string_lossy()
        )
    })?;

    if !parsed.is_object() {
        return Err(format!(
            "config file {} root must be a JSON object",
            config_path.to_string_lossy()
        ));
    }

    Ok(parsed)
}

fn ensure_openclaw_config_file() -> Result<PathBuf, String> {
    let config_path = openclaw_config_path()?;

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create config dir {}: {err}", parent.display()))?;
    }

    if !config_path.exists() {
        std::fs::write(&config_path, "{}\n").map_err(|err| {
            format!(
                "failed to initialize config file {}: {err}",
                config_path.display()
            )
        })?;
    }

    Ok(config_path)
}

fn read_openclaw_config_value() -> Result<Value, String> {
    let config_path = openclaw_config_path()?;
    read_openclaw_config_value_from_path(&config_path)
}

fn write_openclaw_config_value(config: &Value) -> Result<(), String> {
    if !config.is_object() {
        return Err("config root must be a JSON object".to_string());
    }

    let config_path = ensure_openclaw_config_file()?;
    let mut serialized = serde_json::to_string_pretty(config)
        .map_err(|err| format!("failed to serialize config JSON: {err}"))?;
    serialized.push('\n');

    std::fs::write(&config_path, serialized).map_err(|err| {
        format!(
            "failed to write config file {}: {err}",
            config_path.display()
        )
    })
}

fn openclaw_cli_available(context: &OpenclawExecutionContext) -> bool {
    let has_executable = context
        .resolution
        .executable_path
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());
    let version = run_openclaw_command_with_context(context, &["--version"]);
    let version_text = extract_version_text(&version.stdout);
    let has_version_signal = version.exit_code == 0 || !version_text.is_empty();
    has_executable || has_version_signal
}

fn ensure_openclaw_cli_available() -> Result<(), String> {
    let context = resolve_openclaw_execution_context();
    if openclaw_cli_available(&context) {
        Ok(())
    } else {
        Err("OpenClaw CLI is not installed or not available".to_string())
    }
}

fn normalize_openclaw_provider_api_value(api: &str) -> String {
    let trimmed = api.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let normalized = trimmed.to_ascii_lowercase();
    match normalized.as_str() {
        "openai" | "azure-openai" => "openai-completions".to_string(),
        "anthropic" => "anthropic-messages".to_string(),
        "google" => "google-generative-ai".to_string(),
        _ if OPENCLAW_COMPATIBILITY_VALUES.contains(&normalized.as_str()) => normalized,
        _ => trimmed.to_string(),
    }
}

fn openclaw_provider_models_value(default_model: &str, api: Option<&str>) -> Value {
    let model_id = default_model.trim();
    if model_id.is_empty() {
        return Value::Array(Vec::new());
    }

    let mut model = Map::new();
    model.insert("id".to_string(), Value::String(model_id.to_string()));
    model.insert("name".to_string(), Value::String(model_id.to_string()));

    if let Some(api_value) = api.map(str::trim).filter(|value| !value.is_empty()) {
        model.insert("api".to_string(), Value::String(api_value.to_string()));
    }

    Value::Array(vec![Value::Object(model)])
}

fn openclaw_model_reference(provider_name: &str, model_id: &str) -> Result<String, String> {
    let provider_name = provider_name.trim();
    if provider_name.is_empty() {
        return Err("provider_name cannot be empty".to_string());
    }

    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("default_model cannot be empty".to_string());
    }

    Ok(format!("{provider_name}/{model_id}"))
}

fn extract_openclaw_model_id(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Object(object) => ["id", "default_model", "name"].iter().find_map(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        }),
        _ => None,
    }
}

fn configured_openclaw_model_references(config: &Value) -> Result<Vec<String>, String> {
    let Some(root) = config.as_object() else {
        return Err("config root must be a JSON object".to_string());
    };
    let Some(models_value) = root.get("models") else {
        return Ok(Vec::new());
    };
    let Some(models) = models_value.as_object() else {
        return Err("models must be a JSON object".to_string());
    };
    let Some(providers_value) = models.get("providers") else {
        return Ok(Vec::new());
    };
    let Some(providers) = providers_value.as_object() else {
        return Err("models.providers must be a JSON object".to_string());
    };

    let mut model_references = Vec::new();
    let mut seen = HashSet::new();

    for (provider_name, provider_value) in providers {
        let Some(provider) = provider_value.as_object() else {
            continue;
        };
        let Some(provider_models_value) = provider.get("models") else {
            continue;
        };

        let model_ids: Vec<String> = match provider_models_value {
            Value::Array(items) => items.iter().filter_map(extract_openclaw_model_id).collect(),
            _ => extract_openclaw_model_id(provider_models_value)
                .into_iter()
                .collect(),
        };

        for model_id in model_ids {
            let model_reference = openclaw_model_reference(provider_name, &model_id)?;
            if seen.insert(model_reference.clone()) {
                model_references.push(model_reference);
            }
        }
    }

    Ok(model_references)
}

fn current_openclaw_primary_model_reference(config: &Value) -> Result<Option<String>, String> {
    let Some(root) = config.as_object() else {
        return Err("config root must be a JSON object".to_string());
    };
    let Some(agents_value) = root.get("agents") else {
        return Ok(None);
    };
    let Some(agents) = agents_value.as_object() else {
        return Err("agents must be a JSON object".to_string());
    };
    let Some(defaults_value) = agents.get("defaults") else {
        return Ok(None);
    };
    let Some(defaults) = defaults_value.as_object() else {
        return Err("agents.defaults must be a JSON object".to_string());
    };
    let Some(model_value) = defaults.get("model") else {
        return Ok(None);
    };

    let model_reference = match model_value {
        Value::String(raw) => Some(raw.as_str()),
        Value::Object(object) => object.get("primary").and_then(Value::as_str),
        _ => None,
    }
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned);

    Ok(model_reference)
}

fn ensure_openclaw_primary_model_reference(
    config: &mut Value,
    model_reference: &str,
) -> Result<bool, String> {
    let model_reference = model_reference.trim();
    if model_reference.is_empty() {
        return Err("model reference cannot be empty".to_string());
    }

    let Some(root) = config.as_object_mut() else {
        return Err("config root must be a JSON object".to_string());
    };

    let agents_value = root
        .entry("agents".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(agents) = agents_value.as_object_mut() else {
        return Err("agents must be a JSON object".to_string());
    };

    let defaults_value = agents
        .entry("defaults".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(defaults) = defaults_value.as_object_mut() else {
        return Err("agents.defaults must be a JSON object".to_string());
    };

    let mut changed = false;
    match defaults.get_mut("model") {
        Some(Value::Object(model)) => {
            let current_primary = model
                .get("primary")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if current_primary != model_reference {
                model.insert(
                    "primary".to_string(),
                    Value::String(model_reference.to_string()),
                );
                changed = true;
            }
        }
        Some(model_value) => {
            // Migrate legacy/non-object shapes to the current `{ primary: ... }` form.
            *model_value = serde_json::json!({ "primary": model_reference });
            changed = true;
        }
        None => {
            defaults.insert(
                "model".to_string(),
                serde_json::json!({ "primary": model_reference }),
            );
            changed = true;
        }
    }

    let models_value = defaults
        .entry("models".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(models) = models_value.as_object_mut() else {
        return Err("agents.defaults.models must be a JSON object".to_string());
    };
    if !models.contains_key(model_reference) {
        models.insert(model_reference.to_string(), Value::Object(Map::new()));
        changed = true;
    }

    Ok(changed)
}

fn ensure_openclaw_gateway_local_mode(config: &mut Value) -> Result<bool, String> {
    let Some(root) = config.as_object_mut() else {
        return Err("config root must be a JSON object".to_string());
    };

    let gateway_value = root
        .entry("gateway".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(gateway) = gateway_value.as_object_mut() else {
        return Err("gateway must be a JSON object".to_string());
    };

    let current_mode = gateway
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if current_mode == "local" {
        return Ok(false);
    }

    gateway.insert("mode".to_string(), Value::String("local".to_string()));
    Ok(true)
}

fn ensure_saved_provider_default_model_selection_in_config(
    config: &mut Value,
    provider_name: &str,
    default_model: &str,
) -> Result<(String, bool), String> {
    let model_reference = openclaw_model_reference(provider_name, default_model)?;
    let model_changed = ensure_openclaw_primary_model_reference(config, &model_reference)?;
    let gateway_changed = ensure_openclaw_gateway_local_mode(config)?;
    let changed = model_changed || gateway_changed;
    Ok((model_reference, changed))
}

fn persist_saved_provider_default_model_selection(
    provider_name: &str,
    default_model: &str,
) -> Result<(), String> {
    let mut config = read_openclaw_config_value()?;
    let (_, changed) = ensure_saved_provider_default_model_selection_in_config(
        &mut config,
        provider_name,
        default_model,
    )?;
    if changed {
        write_openclaw_config_value(&config)?;
    }

    Ok(())
}

fn missing_default_model_selection_error() -> String {
    let config_path = openclaw_config_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "~/.openclaw/openclaw.json".to_string());

    format!(
        "No default model is configured yet. Missing agents.defaults.model.primary in {config_path}. Save the AI service again to finish setup."
    )
}

fn ensure_launch_default_model_selection_in_config(
    config: &mut Value,
) -> Result<Option<String>, String> {
    if current_openclaw_primary_model_reference(config)?.is_some() {
        return Ok(None);
    }

    let configured_models = configured_openclaw_model_references(config)?;
    if configured_models.len() != 1 {
        return Err(missing_default_model_selection_error());
    }

    let model_reference = configured_models[0].clone();
    ensure_openclaw_primary_model_reference(config, &model_reference)?;
    Ok(Some(model_reference))
}

fn ensure_launch_default_model_selection() -> Result<Option<String>, String> {
    let mut config = read_openclaw_config_value()?;
    let recovered_model = ensure_launch_default_model_selection_in_config(&mut config)?;
    if recovered_model.is_some() {
        write_openclaw_config_value(&config)?;
    }

    Ok(recovered_model)
}

fn migrate_openclaw_provider_models_values(config: &mut Value) -> Result<bool, String> {
    let Some(root) = config.as_object_mut() else {
        return Err("config root must be a JSON object".to_string());
    };
    let Some(models_value) = root.get_mut("models") else {
        return Ok(false);
    };
    let Some(models) = models_value.as_object_mut() else {
        return Err("models must be a JSON object".to_string());
    };
    let Some(providers_value) = models.get_mut("providers") else {
        return Ok(false);
    };
    let Some(providers) = providers_value.as_object_mut() else {
        return Err("models.providers must be a JSON object".to_string());
    };

    let mut changed = false;
    for provider in providers.values_mut() {
        let Some(provider_object) = provider.as_object_mut() else {
            continue;
        };

        let provider_api = provider_object
            .get("api")
            .and_then(Value::as_str)
            .map(str::to_string);

        let Some(models_value) = provider_object.get_mut("models") else {
            continue;
        };

        let replacement = match models_value {
            Value::Array(_) => None,
            Value::Object(models_object) => Some(
                models_object
                    .get("default_model")
                    .and_then(Value::as_str)
                    .map(|default_model| {
                        openclaw_provider_models_value(default_model, provider_api.as_deref())
                    })
                    .unwrap_or_else(|| Value::Array(vec![Value::Object(models_object.clone())])),
            ),
            Value::String(default_model) => Some(openclaw_provider_models_value(
                default_model,
                provider_api.as_deref(),
            )),
            _ => None,
        };

        if let Some(next_models_value) = replacement {
            *models_value = next_models_value;
            changed = true;
        }
    }

    Ok(changed)
}

fn migrate_openclaw_provider_compatibility_values(config: &mut Value) -> Result<bool, String> {
    let api_changed = migrate_openclaw_provider_api_values(config)?;
    let models_changed = migrate_openclaw_provider_models_values(config)?;
    Ok(api_changed || models_changed)
}

fn migrate_openclaw_config_file_for_cli() -> Result<bool, String> {
    let config_path = match openclaw_config_path() {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };

    if !config_path.exists() {
        return Ok(false);
    }

    let mut config = read_openclaw_config_value_from_path(&config_path)?;
    let changed = migrate_openclaw_provider_compatibility_values(&mut config)?;
    if changed {
        write_openclaw_config_value(&config)?;
    }

    Ok(changed)
}

fn migrate_openclaw_provider_api_values(config: &mut Value) -> Result<bool, String> {
    let Some(root) = config.as_object_mut() else {
        return Err("config root must be a JSON object".to_string());
    };
    let Some(models_value) = root.get_mut("models") else {
        return Ok(false);
    };
    let Some(models) = models_value.as_object_mut() else {
        return Err("models must be a JSON object".to_string());
    };
    let Some(providers_value) = models.get_mut("providers") else {
        return Ok(false);
    };
    let Some(providers) = providers_value.as_object_mut() else {
        return Err("models.providers must be a JSON object".to_string());
    };

    let mut changed = false;
    for provider in providers.values_mut() {
        let Some(provider_object) = provider.as_object_mut() else {
            continue;
        };
        let Some(api_value) = provider_object.get_mut("api") else {
            continue;
        };
        let Some(current_api) = api_value.as_str() else {
            continue;
        };

        let normalized_api = normalize_openclaw_provider_api_value(current_api);
        if normalized_api != current_api {
            *api_value = Value::String(normalized_api);
            changed = true;
        }
    }

    Ok(changed)
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

#[cfg(target_os = "macos")]
fn openclaw_install_prefix() -> Result<String, String> {
    home_dir()
        .map(|home| home.join(".openclaw").to_string_lossy().to_string())
        .ok_or_else(|| "HOME directory is not available".to_string())
}

#[cfg(target_os = "macos")]
fn install_openclaw_shell_command() -> Result<String, String> {
    let prefix = shell_quote(openclaw_install_prefix()?.as_str());
    Ok(format!(
        "export OPENCLAW_PREFIX={prefix}; \
export OPENCLAW_NO_ONBOARD=1; \
export OPENCLAW_NPM_LOGLEVEL=warn; \
export SHARP_IGNORE_GLOBAL_LIBVIPS=1; \
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix \"$OPENCLAW_PREFIX\" --no-onboard"
    ))
}

#[cfg(not(target_os = "macos"))]
fn install_openclaw_shell_command() -> Result<String, String> {
    Ok(
        "export OPENCLAW_NO_ONBOARD=1; \
export OPENCLAW_NPM_LOGLEVEL=warn; \
export SHARP_IGNORE_GLOBAL_LIBVIPS=1; \
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard --no-prompt"
            .to_string(),
    )
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
    let context = resolve_openclaw_execution_context();
    let resolution = &context.resolution;
    let install_dir = first_existing_dir_path(&known_openclaw_install_dirs());
    let program = openclaw_program(resolution.executable_path.as_deref());

    let version = run_openclaw_command_with_context(&context, &["--version"]);
    let config_file = run_openclaw_command_with_context(&context, &["config", "file"]);

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
    let display_path = resolution.executable_path.clone().unwrap_or_default();

    let has_executable = !display_path.is_empty();
    let has_version_signal = version.exit_code == 0 || !version_text.is_empty();

    let mut detected_by = Vec::new();
    if has_executable {
        detected_by.push("executable_path");
    }
    if has_version_signal {
        detected_by.push("version");
    }

    let success = has_executable || has_version_signal;
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
    if !resolution.path_probe.stderr.is_empty() {
        stderr_lines.push(format!(
            "command -v openclaw: {}",
            resolution.path_probe.stderr
        ));
    }
    if !version.stderr.is_empty() {
        stderr_lines.push(format!("{program} --version: {}", version.stderr));
    }
    if !config_file.stderr.is_empty() {
        stderr_lines.push(format!("{program} config file: {}", config_file.stderr));
    }
    if let Some(path) = &resolution.command_path {
        if !path.is_empty() && path != &display_path {
            stderr_lines.push(format!("command_path: {path}"));
        }
    }
    if let Some(path) = &resolution.fallback_path {
        if !path.is_empty() && path != &display_path {
            stderr_lines.push(format!("fallback_path: {path}"));
        }
    }
    match &context.strategy {
        OpenclawLaunchStrategy::Program {
            program: resolved_program,
        } => {
            if resolved_program != &program {
                stderr_lines.push(format!("execution_program: {resolved_program}"));
            }
        }
        OpenclawLaunchStrategy::NodeScript {
            node_path,
            script_path: _,
        } => {
            stderr_lines.push("execution_mode: node_script".to_string());
            stderr_lines.push(format!("resolved_node: {node_path}"));
        }
    }

    CommandResponse {
        success,
        stdout: stdout_lines.join("\n"),
        stderr: stderr_lines.join("\n"),
        exit_code: if success { 0 } else { version.exit_code },
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
    let command = match install_openclaw_shell_command() {
        Ok(command) => command,
        Err(error) => return CommandResponse::failure("OpenClaw install failed", error),
    };
    let install_path = build_install_shell_path();
    let exec = run_shell_with_path(command.as_str(), install_path.as_deref());
    let mut response = CommandResponse::from_exec(exec, "Install command finished");
    if response.success {
        #[cfg(target_os = "macos")]
        {
            response.message = "OpenClaw install completed under ~/.openclaw".to_string();
        }
        #[cfg(not(target_os = "macos"))]
        {
            response.message = "OpenClaw install completed".to_string();
        }
    } else {
        response.message = "OpenClaw install failed".to_string();
    }
    response
}

#[tauri::command]
fn gateway_status() -> CommandResponse {
    if let Err(error) = migrate_openclaw_config_file_for_cli() {
        return CommandResponse::failure("Failed to fetch gateway status", error);
    }

    let mut stdout_sections = Vec::new();
    let mut stderr_sections = Vec::new();

    let exec = run_openclaw_command(&["gateway", "status", "--json"]);
    let mut parsed_json = parse_json_stdout(&exec);
    append_exec_output(
        &mut stdout_sections,
        &mut stderr_sections,
        "gateway status",
        &exec,
    );

    let mut effective_exec = exec.clone();
    let mut recovered = false;
    if should_retry_gateway_status_snapshot(&exec, parsed_json.as_ref()) {
        let outcome = retry_gateway_status_until_ready(&mut stdout_sections, &mut stderr_sections);
        if outcome.last_status.is_some() {
            parsed_json = outcome.last_status.clone();
        }
        if outcome.recovered || outcome.last_exec.exit_code == 0 {
            effective_exec = outcome.last_exec.clone();
        }
        recovered = outcome.recovered;
    }

    let mut response = CommandResponse {
        success: recovered || effective_exec.exit_code == 0,
        stdout: stdout_sections.join("\n\n"),
        stderr: stderr_sections.join("\n\n"),
        exit_code: if recovered {
            0
        } else {
            effective_exec.exit_code
        },
        message: if recovered {
            "Gateway status recovered after a transient gateway reconnect".to_string()
        } else if effective_exec.exit_code == 0 {
            "Gateway status fetched".to_string()
        } else {
            "Failed to fetch gateway status".to_string()
        },
        parsed_json,
    };
    if response.success && response.parsed_json.is_none() {
        response.message = "Gateway status fetched but stdout is not valid JSON".to_string();
    }
    response
}

#[tauri::command]
fn open_dashboard() -> CommandResponse {
    let dashboard_exec = run_openclaw_command(&["dashboard", "--no-open"]);
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

#[tauri::command]
fn read_openclaw_providers() -> CommandResponse {
    match read_openclaw_config_value() {
        Ok(mut config) => {
            let migration_warning =
                match migrate_openclaw_provider_compatibility_values(&mut config) {
                    Ok(true) => write_openclaw_config_value(&config)
                        .err()
                        .map(|error| format!("Failed to persist compatibility migration: {error}")),
                    Ok(false) => None,
                    Err(error) => {
                        return CommandResponse::failure("Failed to read OpenClaw providers", error)
                    }
                };

            let Some(root) = config.as_object() else {
                return CommandResponse::failure(
                    "Failed to read OpenClaw providers",
                    "config root must be a JSON object",
                );
            };

            let providers = match root.get("models").and_then(|value| value.as_object()) {
                Some(models) => match models.get("providers") {
                    Some(value) if value.is_object() => value.clone(),
                    Some(_) => {
                        return CommandResponse::failure(
                            "Failed to read OpenClaw providers",
                            "models.providers must be a JSON object",
                        )
                    }
                    None => Value::Object(Map::new()),
                },
                None => Value::Object(Map::new()),
            };

            let stdout = serde_json::to_string_pretty(&providers).unwrap_or_default();
            CommandResponse {
                success: true,
                stdout,
                stderr: migration_warning.unwrap_or_default(),
                exit_code: 0,
                message: "OpenClaw providers loaded".to_string(),
                parsed_json: Some(providers),
            }
        }
        Err(error) => CommandResponse::failure("Failed to read OpenClaw providers", error),
    }
}

#[tauri::command]
fn write_openclaw_provider(
    provider_name: String,
    base_url: String,
    api_key: String,
    api: String,
    default_model: String,
) -> CommandResponse {
    if let Err(error) = ensure_openclaw_cli_available() {
        return CommandResponse::failure("Failed to write OpenClaw provider", error);
    }

    let provider_name = provider_name.trim().to_string();
    let api = normalize_openclaw_provider_api_value(&api);
    if provider_name.is_empty() {
        return CommandResponse::failure(
            "Failed to write OpenClaw provider",
            "provider_name cannot be empty",
        );
    }

    let provider_path = format!("models.providers.{provider_name}");
    let default_model = default_model.trim().to_string();
    let provider = serde_json::json!({
        "baseUrl": base_url,
        "apiKey": api_key,
        "api": api,
        "models": [{
            "id": default_model,
            "name": default_model,
            "api": api,
        }],
    });
    let provider_json = match serde_json::to_string(&provider) {
        Ok(value) => value,
        Err(error) => {
            return CommandResponse::failure(
                "Failed to write OpenClaw provider",
                format!("failed to serialize provider JSON: {error}"),
            )
        }
    };

    let set_exec = run_openclaw_command(&[
        "config",
        "set",
        provider_path.as_str(),
        provider_json.as_str(),
        "--strict-json",
    ]);
    if set_exec.exit_code != 0 {
        let error_detail = match (set_exec.stderr.trim(), set_exec.stdout.trim()) {
            ("", "") => format!(
                "openclaw config set failed with exit code {}",
                set_exec.exit_code
            ),
            ("", stdout) => stdout.to_string(),
            (stderr, "") => stderr.to_string(),
            (stderr, stdout) => format!("{stderr}\n{stdout}"),
        };

        return CommandResponse {
            success: false,
            stdout: set_exec.stdout,
            stderr: error_detail,
            exit_code: set_exec.exit_code,
            message: "Failed to write OpenClaw provider".to_string(),
            parsed_json: None,
        };
    }

    let get_exec = run_openclaw_command(&["config", "get", provider_path.as_str()]);
    if get_exec.exit_code != 0 {
        let error_detail = match (get_exec.stderr.trim(), get_exec.stdout.trim()) {
            ("", "") => format!(
                "openclaw config get failed with exit code {}",
                get_exec.exit_code
            ),
            ("", stdout) => stdout.to_string(),
            (stderr, "") => stderr.to_string(),
            (stderr, stdout) => format!("{stderr}\n{stdout}"),
        };

        return CommandResponse {
            success: false,
            stdout: get_exec.stdout,
            stderr: error_detail,
            exit_code: get_exec.exit_code,
            message: "Failed to write OpenClaw provider".to_string(),
            parsed_json: None,
        };
    }

    let provider_snapshot = match serde_json::from_str::<Value>(&get_exec.stdout) {
        Ok(value) => value,
        Err(error) => {
            return CommandResponse {
                success: false,
                stdout: get_exec.stdout,
                stderr: format!("failed to parse validated provider JSON: {error}"),
                exit_code: get_exec.exit_code,
                message: "Failed to write OpenClaw provider".to_string(),
                parsed_json: None,
            }
        }
    };

    if let Err(error) =
        persist_saved_provider_default_model_selection(&provider_name, &default_model)
    {
        return CommandResponse::failure("Failed to write OpenClaw provider", error);
    }

    CommandResponse {
        success: true,
        stdout: get_exec.stdout,
        stderr: String::new(),
        exit_code: 0,
        message: format!("Provider '{}' saved", provider_name),
        parsed_json: Some(provider_snapshot),
    }
}

fn do_launch_openclaw() -> CommandResponse {
    if let Err(error) = migrate_openclaw_config_file_for_cli() {
        return CommandResponse::failure("OpenClaw launch failed", error);
    }

    let mut stdout_sections = Vec::new();
    let mut stderr_sections = Vec::new();

    match ensure_launch_default_model_selection() {
        Ok(Some(model_reference)) => append_output_section(
            &mut stdout_sections,
            "config preflight",
            format!("Recovered missing agents.defaults.model.primary with {model_reference}.")
                .as_str(),
        ),
        Ok(None) => {}
        Err(error) => return CommandResponse::failure("OpenClaw launch failed", error),
    }

    let validate_exec = run_openclaw_command(&["config", "validate"]);
    append_exec_output(
        &mut stdout_sections,
        &mut stderr_sections,
        "config validate",
        &validate_exec,
    );
    if validate_exec.exit_code != 0 {
        let message = pick_actionable_cli_error_line(&[
            &validate_exec.stderr,
            &validate_exec.stdout,
            "OpenClaw config validation failed",
        ])
        .unwrap_or_else(|| "OpenClaw config validation failed".to_string());
        return CommandResponse {
            success: false,
            stdout: stdout_sections.join("\n\n"),
            stderr: stderr_sections.join("\n\n"),
            exit_code: validate_exec.exit_code,
            message,
            parsed_json: None,
        };
    }

    let initial_status_exec = run_openclaw_command(&["gateway", "status", "--json"]);
    let initial_status_json = parse_json_stdout(&initial_status_exec);
    append_exec_output(
        &mut stdout_sections,
        &mut stderr_sections,
        "gateway status (initial)",
        &initial_status_exec,
    );

    if let Some(status) = initial_status_json.clone() {
        if gateway_status_is_ready(&status) {
            return CommandResponse {
                success: true,
                stdout: stdout_sections.join("\n\n"),
                stderr: stderr_sections.join("\n\n"),
                exit_code: 0,
                message: "OpenClaw launch checks are already ready".to_string(),
                parsed_json: Some(status),
            };
        }
    }

    let mut install_exec = None;

    if !initial_status_json
        .as_ref()
        .is_some_and(gateway_service_loaded)
    {
        let gateway_port = launch_gateway_port(initial_status_json.as_ref());
        let gateway_port_arg = gateway_port.to_string();
        let exec = run_openclaw_command(&[
            "gateway",
            "install",
            "--json",
            "--runtime",
            "node",
            "--port",
            gateway_port_arg.as_str(),
        ]);
        append_exec_output(
            &mut stdout_sections,
            &mut stderr_sections,
            "gateway install",
            &exec,
        );
        install_exec = Some(exec);
    }

    let start_exec = run_openclaw_command(&["gateway", "start", "--json"]);
    append_exec_output(
        &mut stdout_sections,
        &mut stderr_sections,
        "gateway start",
        &start_exec,
    );

    let final_status_exec = run_openclaw_command(&["gateway", "status", "--json"]);
    let mut final_status_json = parse_json_stdout(&final_status_exec);
    append_exec_output(
        &mut stdout_sections,
        &mut stderr_sections,
        "gateway status (final)",
        &final_status_exec,
    );

    let mut success = final_status_json
        .as_ref()
        .is_some_and(gateway_status_is_ready);
    let should_retry_gateway_status = !success
        && (initial_status_json
            .as_ref()
            .is_some_and(gateway_status_needs_rpc_recovery)
            || final_status_json
                .as_ref()
                .is_some_and(gateway_status_needs_rpc_recovery)
            || command_output_looks_like_transient_gateway_reload(&initial_status_exec)
            || command_output_looks_like_transient_gateway_reload(&start_exec)
            || command_output_looks_like_transient_gateway_reload(&final_status_exec)
            || install_exec
                .as_ref()
                .is_some_and(command_output_looks_like_transient_gateway_reload));

    let mut retry_outcome = None;
    if should_retry_gateway_status {
        let outcome = retry_gateway_status_until_ready(&mut stdout_sections, &mut stderr_sections);
        success = outcome.recovered;
        if outcome.last_status.is_some() {
            final_status_json = outcome.last_status.clone();
        }
        retry_outcome = Some(outcome);
    }

    let exit_code = if success {
        0
    } else if retry_outcome
        .as_ref()
        .is_some_and(|outcome| outcome.last_exec.exit_code != 0)
    {
        retry_outcome
            .as_ref()
            .map(|outcome| outcome.last_exec.exit_code)
            .unwrap_or(1)
    } else if final_status_exec.exit_code != 0 {
        final_status_exec.exit_code
    } else if start_exec.exit_code != 0 {
        start_exec.exit_code
    } else {
        1
    };
    let message = if success {
        if retry_outcome
            .as_ref()
            .is_some_and(|outcome| outcome.recovered)
        {
            "OpenClaw startup checks recovered after a transient gateway reconnect".to_string()
        } else {
            "OpenClaw startup checks are ready".to_string()
        }
    } else {
        pick_actionable_cli_error_line(&[
            retry_outcome
                .as_ref()
                .map(|outcome| outcome.last_exec.stderr.as_str())
                .unwrap_or(""),
            retry_outcome
                .as_ref()
                .map(|outcome| outcome.last_exec.stdout.as_str())
                .unwrap_or(""),
            install_exec
                .as_ref()
                .map(|exec| exec.stderr.as_str())
                .unwrap_or(""),
            install_exec
                .as_ref()
                .map(|exec| exec.stdout.as_str())
                .unwrap_or(""),
            &final_status_exec.stderr,
            &final_status_exec.stdout,
            &start_exec.stderr,
            &start_exec.stdout,
            &initial_status_exec.stderr,
            &initial_status_exec.stdout,
        ])
        .unwrap_or_else(|| "OpenClaw launch failed".to_string())
    };

    CommandResponse {
        success,
        stdout: stdout_sections.join("\n\n"),
        stderr: stderr_sections.join("\n\n"),
        exit_code,
        message,
        parsed_json: final_status_json,
    }
}

#[tauri::command]
fn launch_openclaw() -> CommandResponse {
    do_launch_openclaw()
}

#[tauri::command]
fn stop_openclaw() -> CommandResponse {
    let exec = run_openclaw_command(&["gateway", "stop", "--json"]);
    let success = exec.exit_code == 0;
    let message = if success {
        "OpenClaw gateway stopped".to_string()
    } else {
        pick_actionable_cli_error_line(&[&exec.stderr, &exec.stdout])
            .unwrap_or_else(|| "Failed to stop OpenClaw gateway".to_string())
    };
    CommandResponse {
        success,
        stdout: exec.stdout,
        stderr: exec.stderr,
        exit_code: exec.exit_code,
        message,
        parsed_json: None,
    }
}

#[tauri::command]
fn restart_openclaw() -> CommandResponse {
    run_openclaw_command(&["gateway", "stop", "--json"]);
    do_launch_openclaw()
}

fn openclaw_backups_dir() -> Result<PathBuf, String> {
    let dir = home_dir()
        .ok_or_else(|| "HOME directory is not available".to_string())?
        .join(".openclaw")
        .join("backups");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create backups directory: {err}"))?;
    Ok(dir)
}

fn prune_old_backups(dir: &PathBuf, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(".tar.gz")
        })
        .filter_map(|e| {
            let path = e.path();
            let modified = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((modified, path))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
fn backup_openclaw() -> CommandResponse {
    let backups_dir = match openclaw_backups_dir() {
        Ok(dir) => dir,
        Err(err) => return CommandResponse::failure("Failed to create backup", err),
    };
    let exec = run_openclaw_command(&[
        "backup",
        "create",
        "--output",
        backups_dir.to_string_lossy().as_ref(),
        "--json",
    ]);
    let success = exec.exit_code == 0;
    if success {
        prune_old_backups(&backups_dir, 10);
    }
    let message = if success {
        "Backup created successfully".to_string()
    } else {
        pick_actionable_cli_error_line(&[&exec.stderr, &exec.stdout])
            .unwrap_or_else(|| "Failed to create backup".to_string())
    };
    CommandResponse {
        success,
        stdout: exec.stdout,
        stderr: exec.stderr,
        exit_code: exec.exit_code,
        message,
        parsed_json: None,
    }
}

#[tauri::command]
fn list_backups() -> CommandResponse {
    let backups_dir = match openclaw_backups_dir() {
        Ok(dir) => dir,
        Err(err) => return CommandResponse::failure("Failed to list backups", err),
    };
    let Ok(entries) = std::fs::read_dir(&backups_dir) else {
        return CommandResponse {
            success: true,
            stdout: "[]".to_string(),
            stderr: String::new(),
            exit_code: 0,
            message: "No backups found".to_string(),
            parsed_json: Some(Value::Array(vec![])),
        };
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tar.gz"))
        .filter_map(|e| {
            let path = e.path();
            let meta = e.metadata().ok()?;
            let modified = meta.modified().ok()?;
            Some((modified, path, meta.len()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let entries_json: Vec<Value> = files
        .into_iter()
        .map(|(modified, path, size)| {
            let modified_secs = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let filename = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            serde_json::json!({
                "path": path.to_string_lossy(),
                "filename": filename,
                "size_bytes": size,
                "modified_secs": modified_secs,
            })
        })
        .collect();
    let parsed = Value::Array(entries_json.clone());
    let stdout = serde_json::to_string_pretty(&parsed).unwrap_or_default();
    CommandResponse {
        success: true,
        stdout,
        stderr: String::new(),
        exit_code: 0,
        message: format!("{} backup(s) found", entries_json.len()),
        parsed_json: Some(parsed),
    }
}

#[tauri::command]
fn restore_backup(archive_path: String) -> CommandResponse {
    let archive = PathBuf::from(&archive_path);
    if !archive.is_file() {
        return CommandResponse::failure(
            "Failed to restore backup",
            format!("archive not found: {archive_path}"),
        );
    }
    let config_path = match openclaw_config_path() {
        Ok(p) => p,
        Err(err) => return CommandResponse::failure("Failed to restore backup", err),
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tmp_dir = std::env::temp_dir().join(format!("oc_restore_{timestamp}"));
    if let Err(err) = std::fs::create_dir_all(&tmp_dir) {
        return CommandResponse::failure(
            "Failed to restore backup",
            format!("could not create temp dir: {err}"),
        );
    }
    let extract = run_shell(&format!(
        "tar -xzf {} -C {}",
        archive.to_string_lossy(),
        tmp_dir.to_string_lossy(),
    ));
    if extract.exit_code != 0 {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return CommandResponse::failure(
            "Failed to restore backup",
            format!("tar extract failed: {}", extract.stderr),
        );
    }
    let restored_config = find_file_recursive(&tmp_dir, "openclaw.json");
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let Some(restored_config) = restored_config else {
        return CommandResponse::failure(
            "Failed to restore backup",
            "openclaw.json not found in backup archive",
        );
    };
    if let Err(err) = std::fs::copy(&restored_config, &config_path) {
        return CommandResponse::failure(
            "Failed to restore backup",
            format!("could not copy config: {err}"),
        );
    }
    CommandResponse {
        success: true,
        stdout: format!("Config restored from {}", archive.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        stderr: String::new(),
        exit_code: 0,
        message: "Config restored. Restart OpenClaw to apply changes.".to_string(),
        parsed_json: None,
    }
}

fn find_file_recursive(dir: &PathBuf, filename: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().map(|n| n == filename).unwrap_or(false) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, filename) {
                return Some(found);
            }
        }
    }
    None
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
    fn picks_first_non_empty_cli_line() {
        let raw = "\n\nfirst useful line\nsecond line";
        assert_eq!(
            first_non_empty_cli_line(raw),
            Some("first useful line".to_string())
        );
    }

    #[test]
    fn picks_actionable_cli_line_after_warning_only_prefix() {
        let raw = "warning: Running in non-interactive mode because stdin is not a TTY.\nError: config file is invalid";
        assert_eq!(
            first_actionable_cli_line(raw),
            Some("Error: config file is invalid".to_string())
        );
    }

    #[test]
    fn ignores_homebrew_stage_lines_when_picking_actionable_cli_line() {
        let raw = "==> Checking for `sudo` access (which may request your password)...\nError: Homebrew is not installed";
        assert_eq!(
            first_actionable_cli_line(raw),
            Some("Error: Homebrew is not installed".to_string())
        );
    }

    #[test]
    fn gateway_status_readiness_requires_rpc() {
        let status = serde_json::json!({
            "service": {
                "loaded": true,
                "runtime": {
                    "status": "running",
                    "state": "active"
                }
            },
            "gateway": {
                "probeUrl": "ws://127.0.0.1:18789"
            },
            "port": {
                "status": "busy",
                "listeners": [{ "pid": 1 }]
            },
            "rpc": {
                "ok": false
            }
        });

        assert!(gateway_service_loaded(&status));
        assert!(gateway_local_ready(&status));
        assert!(!gateway_rpc_ready(&status));
        assert!(!gateway_status_is_ready(&status));
        assert!(gateway_status_needs_rpc_recovery(&status));
    }

    #[test]
    fn gateway_status_snapshot_retries_when_only_rpc_is_pending() {
        let status = serde_json::json!({
            "service": {
                "loaded": true,
                "runtime": {
                    "status": "running",
                    "state": "active"
                }
            },
            "gateway": {
                "probeUrl": "ws://127.0.0.1:18789"
            },
            "port": {
                "status": "busy",
                "listeners": [{ "pid": 1 }]
            },
            "rpc": {
                "ok": false
            }
        });
        let exec = ExecOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        };

        assert!(should_retry_gateway_status_snapshot(&exec, Some(&status)));
    }

    #[test]
    fn gateway_status_snapshot_retries_on_transient_gateway_close_output() {
        let exec = ExecOutput {
            stdout: String::new(),
            stderr: "gateway closed (1006 abnormal closure (no close frame)): no close reason"
                .to_string(),
            exit_code: 1,
        };

        assert!(should_retry_gateway_status_snapshot(&exec, None));
    }

    #[test]
    fn detects_transient_gateway_reload_output() {
        let raw = "\
Config overwrite: ~/.openclaw/openclaw.json
gateway closed (1006 abnormal closure (no close frame)): no close reason";
        assert!(text_looks_like_transient_gateway_reload(raw));
    }

    #[test]
    fn ignores_non_transient_gateway_output() {
        let raw = "Error: OpenClaw config validation failed";
        assert!(!text_looks_like_transient_gateway_reload(raw));
    }

    #[test]
    fn configured_gateway_port_prefers_known_paths() {
        let config = serde_json::json!({
            "gateway": {
                "port": 18888
            }
        });

        assert_eq!(configured_gateway_port(&config), Some(18888));
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
    fn select_openclaw_executable_prefers_command_path() {
        assert_eq!(
            select_openclaw_executable(
                Some("/usr/local/bin/openclaw".to_string()),
                Some("/opt/homebrew/bin/openclaw".to_string())
            ),
            Some("/usr/local/bin/openclaw".to_string())
        );
    }

    #[test]
    fn select_openclaw_executable_falls_back_to_known_path() {
        assert_eq!(
            select_openclaw_executable(None, Some("/opt/homebrew/bin/openclaw".to_string())),
            Some("/opt/homebrew/bin/openclaw".to_string())
        );
    }

    #[test]
    fn openclaw_program_uses_bare_command_when_path_missing() {
        assert_eq!(openclaw_program(None), OPENCLAW_PROGRAM.to_string());
    }

    #[test]
    fn retries_with_bare_openclaw_when_preferred_binary_is_missing() {
        let exec = ExecOutput {
            stdout: String::new(),
            stderr: "No such file or directory (os error 2)".to_string(),
            exit_code: -1,
        };
        assert!(should_retry_openclaw_with_fallback(
            "/opt/homebrew/bin/openclaw",
            &exec
        ));
        assert!(!should_retry_openclaw_with_fallback(
            OPENCLAW_PROGRAM,
            &exec
        ));
    }

    #[test]
    fn does_not_retry_with_bare_openclaw_for_non_spawn_errors() {
        let exec = ExecOutput {
            stdout: String::new(),
            stderr: "gateway returned non-zero".to_string(),
            exit_code: 1,
        };
        assert!(!should_retry_openclaw_with_fallback(
            "/opt/homebrew/bin/openclaw",
            &exec
        ));
    }

    #[test]
    fn install_shell_path_seeds_common_gui_paths() {
        let path = build_install_shell_path().expect("install shell path");
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
        if let Some(home) = home_dir() {
            let openclaw_bin = home.join(".openclaw").join("bin");
            let local_bin = home.join(".local").join("bin");
            let nvm_bin = home.join(".nvm").join("current").join("bin");
            assert!(path.contains(openclaw_bin.to_string_lossy().as_ref()));
            assert!(path.contains(local_bin.to_string_lossy().as_ref()));
            assert!(path.contains(nvm_bin.to_string_lossy().as_ref()));
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_install_command_uses_local_prefix_installer() {
        let command = install_openclaw_shell_command().expect("macOS install command");
        assert!(command.contains("install-cli.sh"));
        assert!(command.contains("--json"));
        assert!(command.contains("--no-onboard"));
        assert!(command.contains("--prefix \"$OPENCLAW_PREFIX\""));
        assert!(command.contains("OPENCLAW_PREFIX="));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn linux_install_command_keeps_install_sh_flow() {
        let command = install_openclaw_shell_command().expect("Linux install command");
        assert!(command.contains("install.sh"));
        assert!(command.contains("--no-onboard"));
        assert!(command.contains("--no-prompt"));
        assert!(!command.contains("install-cli.sh"));
    }

    #[test]
    fn detects_env_node_shebang() {
        assert!(shebang_uses_env_node("#!/usr/bin/env node"));
        assert!(shebang_uses_env_node(
            "#!/usr/bin/env -S node --trace-warnings"
        ));
        assert!(!shebang_uses_env_node("#!/bin/bash"));
    }

    #[test]
    fn chooses_node_script_launch_when_node_is_resolved() {
        let strategy = choose_openclaw_launch_strategy(
            "/opt/homebrew/bin/openclaw".to_string(),
            Some("/opt/homebrew/bin/openclaw".to_string()),
            Some("/opt/homebrew/bin/node".to_string()),
        );
        assert_eq!(
            strategy,
            OpenclawLaunchStrategy::NodeScript {
                node_path: "/opt/homebrew/bin/node".to_string(),
                script_path: "/opt/homebrew/bin/openclaw".to_string(),
            }
        );
    }

    #[test]
    fn falls_back_to_program_launch_when_node_missing_for_script() {
        let base =
            std::env::temp_dir().join(format!("clawset-test-node-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create temp dir");

        let script = base.join("openclaw");
        std::fs::write(&script, "#!/usr/bin/env node\nconsole.log('ok')\n").expect("create script");

        let script_path = detect_node_shebang_script_path(script.to_string_lossy().as_ref());
        assert_eq!(
            script_path,
            Some(script.to_string_lossy().to_string()),
            "test script should be recognized as env node script"
        );

        let strategy = choose_openclaw_launch_strategy(
            script.to_string_lossy().to_string(),
            script_path,
            None,
        );
        assert_eq!(
            strategy,
            OpenclawLaunchStrategy::Program {
                program: script.to_string_lossy().to_string(),
            }
        );

        let _ = std::fs::remove_dir_all(&base);
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

    #[test]
    fn reading_missing_config_has_no_side_effect() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "clawset-test-read-missing-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create temp dir");

        let config_path = base.join("openclaw.json");
        assert!(!config_path.exists());

        let result = read_openclaw_config_value_from_path(&config_path);
        assert!(result.is_err());
        assert!(
            !config_path.exists(),
            "read should not create missing config file"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn reading_empty_config_file_returns_empty_object() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "clawset-test-read-empty-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create temp dir");

        let config_path = base.join("openclaw.json");
        std::fs::write(&config_path, "\n").expect("write empty config");
        let value = read_openclaw_config_value_from_path(&config_path).expect("read empty config");
        assert_eq!(value, Value::Object(Map::new()));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn normalizes_legacy_provider_api_values() {
        assert_eq!(
            normalize_openclaw_provider_api_value("openai"),
            "openai-completions"
        );
        assert_eq!(
            normalize_openclaw_provider_api_value("anthropic"),
            "anthropic-messages"
        );
        assert_eq!(
            normalize_openclaw_provider_api_value("google"),
            "google-generative-ai"
        );
        assert_eq!(
            normalize_openclaw_provider_api_value("azure-openai"),
            "openai-completions"
        );
    }

    #[test]
    fn migrates_legacy_provider_api_values_in_config() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "custom": {
                        "api": "openai"
                    },
                    "anthropic": {
                        "api": "anthropic"
                    },
                    "google": {
                        "api": "google"
                    },
                    "azure": {
                        "api": "azure-openai"
                    },
                    "already_valid": {
                        "api": "ollama"
                    }
                }
            }
        });

        let changed = migrate_openclaw_provider_api_values(&mut config).expect("migrate config");
        assert!(changed);
        assert_eq!(
            config["models"]["providers"]["custom"]["api"],
            Value::String("openai-completions".to_string())
        );
        assert_eq!(
            config["models"]["providers"]["anthropic"]["api"],
            Value::String("anthropic-messages".to_string())
        );
        assert_eq!(
            config["models"]["providers"]["google"]["api"],
            Value::String("google-generative-ai".to_string())
        );
        assert_eq!(
            config["models"]["providers"]["azure"]["api"],
            Value::String("openai-completions".to_string())
        );
        assert_eq!(
            config["models"]["providers"]["already_valid"]["api"],
            Value::String("ollama".to_string())
        );
    }

    #[test]
    fn migrates_legacy_provider_models_object_to_array() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "custom": {
                        "api": "openai-completions",
                        "models": {
                            "default_model": "gpt-4o-mini"
                        }
                    }
                }
            }
        });

        let changed = migrate_openclaw_provider_models_values(&mut config).expect("migrate config");
        assert!(changed);
        assert_eq!(
            config["models"]["providers"]["custom"]["models"],
            serde_json::json!([
                {
                    "id": "gpt-4o-mini",
                    "name": "gpt-4o-mini",
                    "api": "openai-completions"
                }
            ])
        );
    }

    #[test]
    fn compatibility_migration_updates_api_and_models_together() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "custom": {
                        "api": "openai",
                        "models": {
                            "default_model": "gpt-4o-mini"
                        }
                    }
                }
            }
        });

        let changed =
            migrate_openclaw_provider_compatibility_values(&mut config).expect("migrate config");
        assert!(changed);
        assert_eq!(
            config["models"]["providers"]["custom"]["api"],
            Value::String("openai-completions".to_string())
        );
        assert_eq!(
            config["models"]["providers"]["custom"]["models"],
            serde_json::json!([
                {
                    "id": "gpt-4o-mini",
                    "name": "gpt-4o-mini",
                    "api": "openai-completions"
                }
            ])
        );
    }

    #[test]
    fn saved_provider_write_also_sets_default_model_selection() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "openai": {
                        "models": [
                            { "id": "gpt-4o-mini", "name": "gpt-4o-mini" }
                        ]
                    }
                }
            }
        });

        let (model_reference, changed) = ensure_saved_provider_default_model_selection_in_config(
            &mut config,
            "openai",
            "gpt-4o-mini",
        )
        .expect("set default model");

        assert!(changed);
        assert_eq!(model_reference, "openai/gpt-4o-mini");
        assert_eq!(
            config["agents"]["defaults"]["model"]["primary"],
            Value::String("openai/gpt-4o-mini".to_string())
        );
        assert_eq!(
            config["agents"]["defaults"]["models"]["openai/gpt-4o-mini"],
            Value::Object(Map::new())
        );
        assert_eq!(
            config["gateway"]["mode"],
            Value::String("local".to_string())
        );
    }

    #[test]
    fn saved_provider_write_preserves_existing_local_gateway_mode_without_extra_change() {
        let mut config = serde_json::json!({
            "gateway": {
                "mode": "local"
            },
            "agents": {
                "defaults": {
                    "model": {
                        "primary": "openai/gpt-4o-mini"
                    },
                    "models": {
                        "openai/gpt-4o-mini": {}
                    }
                }
            }
        });

        let (model_reference, changed) = ensure_saved_provider_default_model_selection_in_config(
            &mut config,
            "openai",
            "gpt-4o-mini",
        )
        .expect("preserve gateway mode");

        assert_eq!(model_reference, "openai/gpt-4o-mini");
        assert!(!changed);
        assert_eq!(
            config["gateway"]["mode"],
            Value::String("local".to_string())
        );
    }

    #[test]
    fn launch_preflight_recovers_single_configured_model_reference() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "openai": {
                        "models": [
                            { "id": "gpt-4o-mini", "name": "gpt-4o-mini" }
                        ]
                    }
                }
            }
        });

        let recovered = ensure_launch_default_model_selection_in_config(&mut config)
            .expect("recover default model");

        assert_eq!(recovered.as_deref(), Some("openai/gpt-4o-mini"));
        assert_eq!(
            config["agents"]["defaults"]["model"]["primary"],
            Value::String("openai/gpt-4o-mini".to_string())
        );
    }

    #[test]
    fn launch_preflight_errors_when_default_model_is_missing_and_ambiguous() {
        let mut config = serde_json::json!({
            "models": {
                "providers": {
                    "openai": {
                        "models": [
                            { "id": "gpt-4o-mini", "name": "gpt-4o-mini" }
                        ]
                    },
                    "anthropic": {
                        "models": [
                            { "id": "claude-3-7-sonnet", "name": "claude-3-7-sonnet" }
                        ]
                    }
                }
            }
        });

        let error = ensure_launch_default_model_selection_in_config(&mut config)
            .expect_err("missing default model should fail");

        assert!(error.contains("agents.defaults.model.primary"));
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_openclaw,
            install_openclaw,
            gateway_status,
            open_dashboard,
            read_openclaw_providers,
            write_openclaw_provider,
            launch_openclaw,
            stop_openclaw,
            restart_openclaw,
            backup_openclaw,
            list_backups,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
