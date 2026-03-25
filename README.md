# @playwo/opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## Install in OpenCode

Add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@playwo/opencode-cursor-oauth"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

The `cursor` provider stub is required because OpenCode drops providers that do
not already exist in its bundled provider catalog.

OpenCode installs npm plugins automatically at startup, so users do not need to
clone this repository.

## Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models; if discovery fails, the plugin disables the Cursor provider for that load and shows a visible error toast instead of crashing OpenCode.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/Connect protocol.
4. Native tool routing — rejects Cursor's built-in filesystem/shell tools and
   exposes OpenCode's tool surface via Cursor MCP instead.

Cursor agent streaming uses Cursor's `RunSSE` + `BidiAppend` transport, so the
plugin runs entirely inside OpenCode without a Node sidecar.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                              RunSSE stream + BidiAppend writes
                                              |
                                Cursor Connect/SSE transport
                                              |
                                     api2.cursor.sh gRPC
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model tries native tools (readArgs, shellArgs, etc.)
3. Proxy rejects each with typed error (ReadRejected, ShellRejected, etc.)
4. Model falls back to MCP tool -> mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk, pauses the Cursor stream
6. OpenCode executes tool, sends result in follow-up request
7. Proxy resumes the Cursor stream with mcpResult and continues streaming
```

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Publish

GitHub Actions publishes this package with `.github/workflows/publish-npm.yml`.

- branch pushes publish a `dev` build as `0.0.0-dev.<sha>`
- versioned releases publish `latest` using the `package.json` version and upload the packed `.tgz` to the GitHub release

Repository secrets required:

- `NPM_TOKEN` for npm publish access

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- Active [Cursor](https://cursor.com) subscription
