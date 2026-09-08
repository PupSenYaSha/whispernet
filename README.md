<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

Short usage: `npm start` — installs deps if needed, builds the client, then serves the messenger on port **50025**.

## Features

- **End-to-end encryption** — Signal Protocol (X3DH + Double Ratchet), forward secrecy, break-in recovery
- **E2EE private messages** + a global channel; sealed-sender routing
- **Disappearing messages** — 24h / 7d / 30d auto-delete
- **Media sharing** — images & videos encrypted, in-app lightbox
- **Reactions, editing, deletion, quoted replies**
- **Multi-device** — up to 3 sessions (named devices, list & revoke); a 4th device is rejected
- **Key protection** — private keys encrypted at rest (PBKDF2 600K + AES-256-GCM); encrypted key backup / restore; safety numbers
- **Screenshot protection** toggle
- **Moderation** — admin ban & reports, user blocking, rate limiting
- **RU / EN** localization
- **Cross-platform** — Web (PWA), Desktop (Windows / Linux), Android

## Security

- Server never sees plaintext DMs or long-term keys; encryption happens entirely on the client
- Both client and server are fully open source in this repository

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases) — Windows portable exe, Linux tar.gz, Android APK.

## Hosted instance

| App | URL |
|-----|-----|
| Messenger (Web app) | `https://rightfully-nice-ram.cloudpub.ru/` |

## License

[MIT](LICENSE)