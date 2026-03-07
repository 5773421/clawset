# clawset-desktop

P0 MVP: Tauri 2 + React + TypeScript + Vite + pnpm desktop panel for OpenClaw.

## Included MVP features

- Overview card
  - OpenClaw installed status
  - version
  - path
  - config file path
- Actions
  - Install
  - Start
  - Stop
  - Restart
  - Refresh Status
  - Open Dashboard
- Gateway Status
  - Parsed JSON key fields
  - Raw output
- Settings form (6 common fields)
  - `update.channel`
  - `update.checkOnStart`
  - `acp.enabled`
  - `acp.defaultAgent`
  - `agents.defaults.thinkingDefault`
  - `agents.defaults.heartbeat.every`
- Loading / success / error feedback for operations

## Commands exposed from Rust

- `detect_openclaw`
- `install_openclaw`
- `gateway_control(action)`
- `gateway_status`
- `get_config_file`
- `get_common_settings`
- `set_common_setting(path, value)`
- `open_dashboard`

All commands return a unified structure containing:

- `success`
- `stdout`
- `stderr`
- `exit_code`
- `message`

`gateway_status` also returns `parsed_json` when stdout can be parsed.

## Run locally

```bash
pnpm install
pnpm tauri dev
```

Build frontend:

```bash
pnpm build
```

## Notes

- This MVP executes `openclaw` commands through Rust `std::process::Command`.
- If Rust toolchain, pnpm packages, or network access is unavailable, build may fail, but project structure and command wiring are complete.
