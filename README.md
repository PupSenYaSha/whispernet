<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

`npm start` — installs deps if needed, builds the client, then serves the messenger on port **50025**.

## Features

- **End-to-end encryption** — X3DH + Double Ratchet for direct messages; per-device sealed bodies
- **Groups** — E2EE with one symmetric key per group; key rotates when members join or leave
- **#general chat** — public plaintext channel (do not send secrets there)
- **Disappearing messages** — 24h / 7d / 30d auto-delete
- **Media sharing** — encrypted images & videos, streamed in chunks, up to 1 GB
- **Typing indicators & read receipts** — optional, optional in Settings
- **Reactions, editing, deletion, quoted replies**, forward, jump-to-quoted
- **Profiles & avatars** — nickname, online status, registration date, safety number
- **Contact verification** — safety number compare + QR scanner
- **Voice & video calls** — WebRTC peer-to-peer, signalling over encrypted websocket
- **Multi-device** — up to 3 sessions; each device has its own ratchet identity
- **Key protection** — PBKDF2 600K + AES-256-GCM at rest; encrypted key backup / restore; change password without losing keys
- **App lock** — optional passcode, independent of account password
- **Screenshot protection** — blocks screen capture, right-click and text selection
- **Abuse limits** — PoW registration, login lockout, per-address caps
- **Moderation** — admin ban & reports, user blocking
- **RU / EN** localization

## Security

All encryption happens entirely on the client. The server never sees plaintext messages, attachments, or long-term keys.

### What the server can see

A single server brokers every connection, so it knows:

- Who is connected and when
- Who talks to whom and when (DM channel is a pair of account ids)
- `#general` channel in full (it is plaintext)
- Daily-rotating HMAC pseudonyms of addresses and coarse user-agent labels

## Password

The password never reaches the server. It is the key every piece of local key material is sealed under. Losing it means losing local history — that's why the encrypted key backup exists.

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | Asset |
|---|---|
| Windows | `WhisperNet_1.0.0_x64-portable.zip` — plain executable |
| Linux | `WhisperNet_1.0.0_amd64.deb` |
| Android | `WhisperNet.apk` |

Every asset is published with a `.sha256`. The Windows portable zip is signed with an Ed25519 key compiled into the binary, and the in-app updater verifies the signature before installing.

## License

[MIT](LICENSE)