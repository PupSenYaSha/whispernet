<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Capacitor](https://img.shields.io/badge/Platform-Mobile-green.svg)](#android)
[![PWA](https://img.shields.io/badge/Platform-PWA-orange.svg)](#pwa)

</div>

---

## Features

- **End-to-end encryption** — Signal Protocol (X3DH + Double Ratchet) for forward secrecy and break-in recovery
- **Private & group messaging** — DMs and global chat
- **Media sharing** — images and videos
- **Cross-platform** — Web, Desktop (Electron), Mobile (Android)
- **Session persistence** — auto-login on restart
- **Customizable themes** — 8 accent colors, dark/light modes
- **Russian/English localization**

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | File |
|----------|------|
| Windows | `WhisperNet.1.0.0.exe` (portable) |
| Windows | `WhisperNet-v1.0.0.zip` |
| Android | `WhisperNet.apk` |
| Linux | `whispernet-1.0.0.tar.gz` |

> **Web version** — try the messenger in your browser at [whispernet.app](https://unkindly-literate-wigeon.cloudpub.ru/)

### Windows

Download `WhisperNet.1.0.0.exe` and run. First launch may trigger SmartScreen warning — click "More info" → "Run anyway".

### Android

Download `WhisperNet.apk`, enable "Install from unknown sources" in settings, and install.

### Linux

```bash
tar xzf whispernet-1.0.0.tar.gz
cd whispernet-1.0.0
./WhisperNet
```

## Build from Source

### Quick Start

```bash
npm install
npm start
```

This launches both the messenger server (port 50025) and the landing page (port 3000).

### Client (Web/PWA)

```bash
npm install
npx vite build
```

Output: `dist/client/`

### Android

```bash
npm install
npx vite build
npx cap sync android
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Desktop (Electron)

```bash
npm install
npm run build:client
npm run build:electron
npx electron-builder --win
```

Output: `dist/build/WhisperNet.exe`

## Security

- **Signal Protocol** — X3DH key agreement + Double Ratchet for DM encryption
- **Forward secrecy** — compromise of long-term keys does not compromise past sessions
- **Break-in recovery** — ratchet mechanism restores security after key compromise
- **Pre-key bundles** — asynchronous session establishment without both parties online
- **Server zero-knowledge** — server never sees plaintext DM content or long-term keys

> The app runs via an official developer server. Backend source code is closed, but end-to-end encryption on the client side fully prevents the server from accessing your messages.

## License

[MIT](LICENSE)
