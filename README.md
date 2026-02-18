# HAPI

Run official Claude Code / Codex / Gemini / OpenCode sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/guide/why-hapi.md) for the key differences.

## Features

- **Seamless Handoff** - Work locally, switch to remote when needed, switch back anytime. No context loss, no session restart.
- **Native First** - HAPI wraps your AI agent instead of replacing it. Same terminal, same experience, same muscle memory.
- **AFK Without Stopping** - Step away from your desk? Approve AI requests from your phone with one tap.
- **Your AI, Your Choice** - Claude Code, Codex, Gemini, OpenCode—different models, one unified workflow.
- **Terminal Anywhere** - Run commands from your phone or browser, directly connected to the working machine.
- **Voice Control** - Talk to your AI agent hands-free using the built-in voice assistant.

## Demo

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## Getting Started

```bash
npx @twsxtd/hapi hub --relay     # start hub with E2E encrypted relay
npx @twsxtd/hapi                 # run claude code
```

`hapi server` remains supported as an alias.

The terminal will display a URL and QR code. Scan the QR code with your phone or open the URL to access.

> The relay uses WireGuard + TLS for end-to-end encryption. Your data is encrypted from your device to your machine.

For self-hosted options (Cloudflare Tunnel, Tailscale), see [Installation](docs/guide/installation.md)

## Docs

- [App](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Voice Assistant](docs/guide/voice-assistant.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Local Development

```bash
bun install
bun run dev              # start hub + web (http://localhost:5173)
```

In a separate terminal, run an agent:

```bash
cd cli
bun run src/index.ts                    # claude (default)
bun run src/index.ts codex              # codex
bun run src/index.ts gemini             # gemini
bun run src/index.ts runner start       # background runner (for remote spawn)
```


## Build from source

### Prerequisites

- [Bun](https://bun.sh) installed
- [tunwg](https://github.com/ntnj/tunwg) binary — the relay tunnel tool. Install via Go:

  ```bash
  go install github.com/ntnj/tunwg/tunwg@latest
  ```

  Then copy it to the expected location:

  Windows (PowerShell):
  ```powershell
  Copy-Item "$env:GOPATH\bin\tunwg.exe" hub\tools\tunwg\tunwg-x64-win32.exe
  ```

  Linux x64:
  ```bash
  cp $(go env GOPATH)/bin/tunwg hub/tools/tunwg/tunwg-x64-linux
  ```

  macOS arm64:
  ```bash
  cp $(go env GOPATH)/bin/tunwg hub/tools/tunwg/tunwg-arm64-darwin
  ```

  Or download pre-built binaries from [tunwg releases](https://github.com/tiann/tunwg/releases).

### Build

```bash
bun install
bun run build:web
cd hub && bun run generate:embedded-web-assets && cd ..
cd cli && bun run build:exe:allinone
```

Output: `cli/dist-exe/bun-<platform>/hapi` (or `hapi.exe` on Windows).

### Usage

1. Start hub: `hapi hub` (local) or `hapi hub --relay` (remote access with E2E encryption)
2. Start agent: `hapi` (claude by default)
3. Terminal displays URL and QR code — scan or open to remote control


## Credits

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.
