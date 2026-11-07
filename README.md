<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

`npm start` — installs deps if needed, builds the client, then serves the messenger on port **50025**.

## Features

- **End-to-end encryption** — X3DH + Double Ratchet for direct messages, forward secrecy, per-device sealed bodies
- **E2EE private messages** + a public `#general` channel (not E2EE — do not send secrets there)
- **Groups** — E2EE with one symmetric AES-256 key per group; key rotates when a member joins or leaves
- **Disappearing messages** — 24h / 7d / 30d auto-delete
- **Media sharing** — encrypted images & videos, streamed in chunks, up to 1 GB
- **Typing indicators & read receipts** — optional, can be switched off in Settings
- **Reactions, editing, deletion, quoted replies**, forward, jump-to-quoted
- **Profiles & avatars** — click any avatar for nickname, online status, registration date, safety number
- **Contact verification** — safety number comparison + QR scanner; clears itself if their identity key changes
- **Voice & video calls** — WebRTC peer-to-peer, signalling over the encrypted websocket
- **Multi-device** — up to 3 sessions; each device has its own ratchet identity
- **Key protection** — PBKDF2 600K + AES-256-GCM at rest; encrypted key backup / restore; change password without losing keys
- **Passcode lock** — optional screen lock, independent of the account password
- **Screenshot protection** — blocks screen capture, right-click and text selection
- **Abuse limits** — PoW registration, login lockout, per-address connection and rate caps
- **Moderation** — admin ban & reports, user blocking
- **RU / EN** localization

## Security

All encryption happens entirely on the client. The server never sees plaintext of private messages, attachments, or long-term keys.

### What the server can see

A single server brokers every connection, so the operator necessarily observes:

- **Who is connected when** — sockets are authenticated
- **Who talks to whom, and when** — direct channels record both participants; message size is padded to fixed buckets; sender attribution on stored DM rows is stripped after 24 hours
- **The global channel `#general` in full** — plaintext room, not E2EE
- **Metadata about devices and addresses** — daily-rotating HMAC pseudonyms, coarse user-agent labels

### How messages travel

Private messages use Signal Protocol (X3DH + Double Ratchet) with a separate sealed body per device. Groups use one symmetric AES-256 key per group, one sealed body per message, rotated when members join or leave.

## Password

The password never reaches the server. It is the key every piece of local key material is sealed under. Losing it means losing local history — that's why the encrypted key backup exists.

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | Asset |
|---|---|
| Windows | `WhisperNet_1.0.0_x64-portable.zip` — plain executable, used by the in-app updater |
| Linux | `WhisperNet_1.0.0_amd64.deb` |
| Android | `WhisperNet.apk` |

Every asset is published with a `.sha256` beside it. The Windows portable archive is signed with the key compiled into the binary, and the in-app updater verifies the Ed25519 signature before installing.

## Configuration

Everything has a working default; nothing is required.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `50025` | Port the messenger listens on |
| `HOST` | `127.0.0.1` | Interface to bind |
| `DATA_DIR` | `./data` | SQLite database, avatars and uploads |
| `ADMIN_KEY` | *(unset)* | Extra admin credential |
| `TRUST_PROXY` | `0` | Set to `1` behind a tunnel so `req.ip` is the real client |
| `MEDIA_BASE_URL` | `https://img.n1ko.dev` | Upstream used for media uploads and the proxy |
| `MEDIA_STORAGE` | `remote` | `local` keeps uploads in `DATA_DIR/media` instead of forwarding them |
| `POW_BITS` | `20` | Leading zero bits a registration proof must have |
| `MAX_AUTH_ATTEMPTS` | `300` | Coarse per-address auth backstop |
| `MAX_AUTH_ATTEMPTS_PER_ADDRESS` | `120` | Per-address sign-in budget |
| `MAX_REGISTRATIONS_PER_IP` | `40` | Accounts one address may create per day |
| `MAX_ACCOUNTS_PER_DEVICE` | `6` | Accounts one device may create per day |

## License

[MIT](LICENSE)