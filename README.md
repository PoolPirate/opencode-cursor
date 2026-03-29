# opencode-cursor-oauth

## Disclaimer

> [!NOTE]
> This project is a **fork** of [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor). Upstream may differ in behavior, features, or maintenance; treat this repository as its own line of development.

## What it does

This is an [OpenCode](https://opencode.ai) plugin that lets you use **Cursor cloud models** (Claude, GPT, Gemini, and whatever your Cursor account exposes) from inside OpenCode.

- **OAuth login** to Cursor in the browser
- **Model discovery** — loads the models available to your Cursor account
- **Local OpenAI-compatible proxy** — translates OpenCode’s requests to Cursor’s gRPC API
- **Token refresh** — refreshes access tokens so sessions keep working

There are **no extra runtime requirements** beyond what OpenCode already needs: you do not install Node, Python, or Docker separately for this plugin. Enable it in OpenCode’s config and complete login in the UI.

This package targets the OpenCode `1.3.4+` plugin system and ships a dedicated server plugin entrypoint for modern OpenCode releases.

## Install

Install the plugin package with OpenCode:

```bash
opencode plugin @playwo/opencode-cursor-oauth
```

Or add the package to your OpenCode configuration manually (for example `opencode.json`):

```json
{
  "plugin": ["@playwo/opencode-cursor-oauth"]
}
```

OpenCode `1.3.4+` can discover this package as a server plugin automatically. You need **OpenCode 1.3.4+** and a **Cursor account** with API/model access.

## Connect auth and use it

1. Start OpenCode with the plugin enabled.
2. Open **Settings → Providers → Cursor** (wording may vary slightly by OpenCode version).
3. Choose **Login** (or equivalent) and complete **OAuth** in the browser when prompted.
4. After login, pick a Cursor-backed model from the model list and use OpenCode as usual.

If something fails, check that you are signed into the correct Cursor account and that your plan includes the models you expect.

## Stability and issues

This integration can be **buggy** or break when Cursor or OpenCode change their APIs or UI.

> [!TIP]
> If you hit problems, missing models, or confusing errors, please **[open an issue](https://github.com/PoolPirate/opencode-cursor/issues)** on this repository with steps to reproduce and logs or screenshots when possible.
