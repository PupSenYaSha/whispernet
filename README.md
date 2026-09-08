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
- **Private and global messaging** — E2EE DMs (sealed-sender routing) and a global channel
- **Media sharing** — images and videos, encrypted, with an in-app fullscreen viewer (lightbox)
- **Reactions** — emoji reactions persisted on the server and restored after reload
- **Replies** — quoted replies with accent-colored reply chip above the message
- **Cross-platform** — Web (PWA), Desktop (Electron), Mobile (Android)
- **Multi-device sessions** — up to 3 devices per account, human-readable device names (e.g. "Chrome · Windows 10/11"), list & revoke in Settings; a 4th new device is rejected instead of kicking an existing session
- **Customizable themes** — 8 accent colors, dark/light modes, font size
- **Russian/English localization** — language names shown in their own script (Русский)

## Security

- **Signal Protocol** — X3DH key agreement + Double Ratchet for DM encryption
- **Forward secrecy** — compromise of long-term keys does not compromise past sessions
- **Break-in recovery** — ratchet mechanism restores security after key compromise
- **Pre-key bundles** — asynchronous session establishment without both parties online
- **Sealed-sender routing** — DMs can be routed by recipient public key so a network observer cannot see the recipient
- **Server zero-knowledge** — server never sees plaintext DM content or long-term keys
- **Keys encrypted at rest** — PBKDF2 (600K iterations) + AES-256-GCM, password-derived encryption of all stored private keys
- **Key backup/export** — download encrypted JSON backup of your keys, restore on any device with password
- **Multi-device key setup** — new device requires explicit key import or conscious new key generation with warning; optional shared-account key backup (server sees only ciphertext)
- **Session management** — view and revoke connected devices from settings
- **Screenshot protection** — optional toggle to block screen capture, right-click, and text selection (best-effort; OS-level capture cannot be fully blocked in a browser)
- **Safety numbers** — verify contact identity by comparing keys (both users' keys combined)
- **Media SSRF guard** — media proxy refuses internal/foreign hosts

> Both client and server source code are fully open in this repository. End-to-end encryption ensures the server never sees plaintext DM content or long-term keys.

## Moderation & Privacy

- **Contact blocking** — block/unblock any user from the chat header; a blocked user cannot DM you and their messages are rejected server-side
- **Reporting** — report users from a message with a reason (scam / harassment / inappropriate / custom); reports store up to 100 chars of the message text and the channel (General chat / DM)
- **Admin moderation panel (in-app)** — for accounts whose nickname is in `data/admins.json` (seeded with `admin` by default):
  - `Admin key` — ops endpoint access is guarded by `ADMIN_KEY` env var on the server
  - Ban by nickname or from a report; a successful ban force-disconnects all devices and **deletes the related reports**
  - "Blocked users" list with unblock per entry
- **Rate limiting** — auth attempts, message sending, connections, and uploads are rate-limited per IP

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | File |
|----------|------|
| Windows | `WhisperNet.1.0.0.exe` (portable) |
| Windows | `WhisperNet-v1.0.0.zip` |
| Android | `WhisperNet.apk` |
| Linux | `whispernet-1.0.0.tar.gz` |

> **Web version** — try the messenger in your browser at the hosted instances below.

## Hosted instances

| App | URL |
|-----|-----|
| Messenger (Web app + WS server) | `https://rightfully-nice-ram.cloudpub.ru/` |
| Marketing site | `https://unkindly-literate-wigeon.cloudpub.ru/` |

## Quick Start (one command)

```bash
npm start
```

That single command does everything needed to run the app on a fresh machine:

1. **prestart** — installs any missing npm dependencies automatically
2. builds the client bundle (`vite build`)
3. starts the **messenger** (WebSocket + static app) on port **50025**
4. starts the **marketing site** on port **3000**

Open `http://localhost:50025` to use the messenger and `http://localhost:3000` for the site.

> Set `WN_SKIP_PREPARE=1` to skip the dependency check.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | One-command run: install deps if needed → build client → start messenger (:50025) + site (:3000) |
| `npm run start:site` | Site-only mode (just the landing page on :3000) |
| `npm run dev` | Vite dev server |
| `npm run build:client` | Production client build → `dist/client/` |
| `npm test` | Run all vitest suites (server security + real E2E over a live WebSocket server) |
| `npm run build:electron` | Compile the Electron main process (TypeScript) |

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `50025` | Messenger HTTP/WS port |
| `SITE_PORT` | `3000` | Marketing site port |
| `ADMIN_KEY` | — | Key required for admin bans / reports on the wire |
| `MEDIA_BASE_URL` | `https://img.n1ko.dev` | Media host for photo/video uploads |
| `WN_DATA_DIR` | `./data` | Where server state (users, keys, reports, bans…) is stored |
| `WN_SKIP_PREPARE` | — | `1` skips the prestart dependency check |

## Client (Web/PWA)

```bash
npm install
npm run build:client
```

Output: `dist/client/`

## Android

```bash
npm install
npm run build:client
npx cap sync android
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

## Desktop (Electron)

```bash
npm install
npm run build:client
npm run build:electron
npx electron-builder --win
```

Output: `dist/build/WhisperNet.exe`

## Tests

```bash
npm test
```

Runs both suites:

- `tests/server-security.test.ts` — static checks on server source
- `tests/e2e-real.test.ts` — boots a real server on an ephemeral port and exercises: E2EE DMs, multi-device fan-out, sealed sender, media E2EE, reactions (incl. persistence across reconnect), quotes, blocking, reporting, moderation (ban → report cleanup), and the 3-device session cap

## Deployment (cloudpub)

On a freshly created cloudpub instance, inside the repo dir:

```bash
git pull --ff-only
bash deploy.sh
```

`deploy.sh` installs dependencies, rebuilds the client, restarts the server via `npm start`, and health-checks `:PORT`. Point the reverse proxy in the cloudpub panel to:

- **messenger** → `http://127.0.0.1:50025`
- **site** → `http://127.0.0.1:3000`

## License

[MIT](LICENSE)