<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

Short usage: `npm start` — installs deps if needed, builds the client, then serves the messenger on port **50025**.

## Features

- **End-to-end encryption** — Signal Protocol (X3DH + Double Ratchet), forward secrecy, break-in recovery
- **E2EE private messages** + a global channel
- **Sealed sender** (on by default) — the server does not learn who sent a private message; the recipient opens it alone. History, reactions and disappearing messages all still work. Turn it off if you would rather the operator be able to help with a conversation
- **Disappearing messages** — 24h / 7d / 30d auto-delete
- **Media sharing** — images & videos encrypted, in-app lightbox
- **Reactions, editing, deletion, quoted replies**
- **Profiles & avatars** — click any avatar to open a profile: avatar, nickname, online status, registration date, safety number; own photo upload (auto-cropped, WebP)
- **Multi-device** — up to 3 sessions (named devices, list & revoke); a 4th device is rejected
- **Key protection** — private keys encrypted at rest (PBKDF2 600K + AES-256-GCM); encrypted key backup / restore; safety numbers
- **Screenshot protection** toggle
- **Abuse limits** — login lockout and per-address connection caps
- **Moderation** — admin ban & reports (grouped by user, with profile links), user blocking, rate limiting
- **RU / EN** localization
- **Cross-platform** — Web (PWA), Desktop (Windows / Linux, Tauri v2), Android

## Security

- Server never sees plaintext DMs or long-term keys; encryption happens entirely on the client
- Both client and server are fully open source in this repository

### What the server can still see

Encryption is not the same as anonymity, and it is worth being precise about which is which. On this
architecture a single server brokers every connection, so the operator can observe:

- **Who is connected when.** Sockets are authenticated, and the server necessarily knows which
  account each open connection belongs to.
- **Who talks to whom, and when.** By default the sender half of that pair is removed: the server
  knows a message arrived for an account, and not who wrote it. Turning off sealed sender in Settings
  restores the sender. Either way the arrival, its time and its size are visible.
- **The global channel in full.** `#general` is not end-to-end encrypted. It is a public room.
- **Metadata about devices and addresses.** Addresses are recorded only as a daily-rotating HMAC
  pseudonym in the security log, and a browser user agent is reduced to a coarse label such as
  "Chrome on Windows" before it is stored. Neither can be reversed or correlated across days.
- **Prekey material and public keys.** These are not secrets by design; a server that cannot see
  them cannot route a first message to an offline recipient.

### Sealed sender (on by default)

The server does not learn who sent a private message. Each message is sealed to the recipient's
identity key with a single-use X25519 key and stored addressed to that recipient, who is the only
account that can open it.

The recipient is still known, and that is not a compromise of the feature — the sender is writing to
somebody, and that somebody has to be able to receive it. What never reaches the server is *who wrote
it*. So a sealed message is an ordinary message row with a placeholder in place of the sender, and
everything the app already did with messages keeps working: history and paging, reactions, disappearing
messages, and corrections.

Turn it off in Settings → Privacy if you would rather the operator be able to help with a
conversation — that is the whole trade, and there is no version of it where both are true.

**Who may do what with an anonymous message**

| | sender | recipient | anyone else |
|---|---|---|---|
| read | no | yes | no |
| edit | no | yes | no |
| delete | no | yes | no |
| react | no | yes | no |
| report | — | yes, to the sender's real account | no |

The sender cannot edit or delete its own anonymous message. That is not an oversight: proving authorship
is exactly what sealed sender withholds, so accepting the claim would defeat the feature. A recipient's
correction is therefore kept in their own client and relayed to their other devices, never written back
into the ciphertext the server holds.

The cost, stated plainly:

- **The server cannot attribute an anonymous message to anyone.** Not for moderation, not for banning,
  not for blocking, not for a report. It can refuse to relay it, rate-limit it, and delete it on
  expiry, and that is the whole of its authority over these.
- **It is still observable as traffic.** That a message arrived for this account, roughly when, and how
  large it is, remains visible. A passive observer correlating a fresh address with an arriving message
  is not defeated by this.
- **Sends are metered.** An anonymous send costs one signed single-use token from the sender's daily
  balance, which is what stops spam from becoming free.
- **The recipient's correction is device-local.** A device that was offline when a sealed message was
  edited sees the original text; there is no server copy of the new text to replay.

### Honest limits

- **Not independently audited.** The protocol code follows the Signal specification, but no external
  party has reviewed it. Treat this as unaudited software.
- **A malicious server can still misbehave.** It cannot read message contents, but it can drop
  messages, refuse to deliver them, or serve modified client code to a client that has not been
  verified.
- **Public keys are trusted on first use.** A server that hands out a key you did not expect is
  believed, because the server is also the only thing that can introduce you to somebody. Safety
  numbers let you compare keys with the other person by hand, which catches a substitution only if
  somebody actually looks. There is no published, independently witnessed log of what the server has
  handed out, so a substitution that happens the first time you talk to someone is not detectable by
  the app.
- **No forward secrecy for the global channel**, and no anonymity guarantees for any channel.

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | Asset |
|---|---|
| Windows | `WhisperNet_1.0.0_x64-setup.exe` — NSIS installer |
| Windows | `WhisperNet_1.0.0_x64-portable.zip` — plain executable, used by the in-app updater |
| Linux | `WhisperNet_1.0.0_amd64.deb` |
| Android | `WhisperNet.apk` |

The Windows build is signed with the release key on CI. Android release builds need the
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` secrets; without them the workflow refuses to publish rather than shipping a
debug-signed APK.

## Hosted instance

| App | URL |
|-----|-----|
| Messenger (Web app) | `https://rightfully-nice-ram.cloudpub.ru/` |

## Configuration

Everything has a working default; nothing is required.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `50025` | Port the messenger listens on |
| `HOST` | `127.0.0.1` | Interface to bind |
| `DATA_DIR` | `./data` | SQLite database, avatars and uploads |
| `ADMIN_KEY` | *(unset)* | Extra admin credential; without it admin rights follow the `admin` nickname |
| `PUBLIC_HOST` | *(request `Host`)* | Host baked into the Content-Security-Policy |
| `TRUST_PROXY` | `0` | Set to `1` behind a tunnel so `req.ip` is the real client |
| `MEDIA_BASE_URL` | `https://img.n1ko.dev` | Upstream used for media uploads and the proxy |
| `MEDIA_STORAGE` | `remote` | `local` keeps uploads in `DATA_DIR/media` instead of forwarding them |
| `TLS_KEY` / `TLS_CERT` | *(unset)* | Serve HTTPS/WSS directly instead of behind a proxy |
| `MAX_CONNECTIONS` | `10000` | Hard ceiling on open sockets |
| `SEALED_TTL_MS` | `604800000` | How long an anonymous message lives before it expires, when the sender asked for no TTL |
| `WHISPERNET_URL` | `https://rightfully-nice-ram.cloudpub.ru` | Server the Android shell loads (Capacitor) |
| `SITE_PORT` | `3000` | Port for the marketing site, if `site/` exists |

`npm start` also serves `site/` on `:3000` when that directory is present. It is not tracked in
git, so a fresh clone simply has no marketing site — the messenger on `:50025` is unaffected.

## License

[MIT](LICENSE)
