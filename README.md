# opencode-cursor-oauth

Use Cursor models (Claude, GPT, Gemini, etc.) inside [OpenCode](https://opencode.ai).

## What it does

- **OAuth login** to Cursor via browser
- **Model discovery** — automatically fetches your available Cursor models
- **Local proxy** — runs an OpenAI-compatible endpoint that translates to Cursor's gRPC protocol
- **Auto-refresh** — handles token expiration automatically

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["@playwo/opencode-cursor-oauth"]
}
```

Then authenticate via the OpenCode UI (Settings → Providers → Cursor → Login).

## Requirements

- Cursor account with API access
- OpenCode 1.2+

## License

MIT
