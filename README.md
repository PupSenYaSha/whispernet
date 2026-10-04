<div align="center">

# WhisperNet

**Minimalist messenger with end-to-end encryption**

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

Short usage: `npm start` — installs deps if needed, builds the client, then serves the messenger on port **50025**.

## Features

- **End-to-end encryption** — X3DH + Double Ratchet for direct messages, forward secrecy, break-in
  recovery, and **a separate sealed body per device**, so a message reaches a phone and a laptop without
  either of them sharing key material with the other
- **E2EE private messages** + a global channel
- **Disappearing messages** — 24h / 7d / 30d auto-delete
- **Media sharing** — images & videos encrypted, streamed a chunk at a time, in-app lightbox
- **Typing indicators** and **read receipts**, neither of which the server stores
- **Reactions, editing, deletion, quoted replies**, forward, jump-to-quoted
- **Grouped emoji picker** — a quick strip for one tap, or the full set behind it
- **Profiles & avatars** — click any avatar to open a profile: avatar, nickname, online status,
  registration date, safety number; own photo upload (auto-cropped, WebP)
- **Contact verification** — compare a safety number in person and mark the contact verified; the mark
  clears itself if their identity key ever changes
- **Chat list** — unread counts, unread-only filter, per-chat pins, per-chat draft memory
- **Multi-device** — up to 3 sessions (named devices, list & revoke); a 4th device is rejected. Every
  device has its own ratchet identity, so compromising one device does not open the others
- **Key protection** — private keys encrypted at rest (PBKDF2 600K + AES-256-GCM); encrypted key backup /
  restore; safety numbers; **change password without losing keys**
- **Passcode lock** — optional, with auto-lock, independent of the account password
- **Message search** (server-side full-text over the public channel)
- **Screenshot protection** toggle, including native window protection on the desktop shell
- **Abuse limits** — login lockout and per-address connection caps
- **Moderation** — admin ban & reports (grouped by user, with profile links), user blocking, rate limiting
- **RU / EN** localization
- **Cross-platform** — Web (PWA), Desktop (Windows / Linux, Tauri v2), Android

## Security

- The server never sees the plaintext of a private message, a private attachment, or any long-term key.
  Encryption happens entirely on the client.
- Both client and server are fully open source in this repository.

### What the server can see

Encryption is not the same as anonymity, and it is worth being precise about which is which. On this
architecture a single server brokers every connection, so the operator can observe:

- **Who is connected when.** Sockets are authenticated, and the server necessarily knows which account
  each open connection belongs to.
- **Who talks to whom, and when.** A direct message row records both participants. Its arrival, its time
  and its size are visible.
- **The global channel in full.** `#general` is not end-to-end encrypted. It is a public room. Attachments
  posted there are not encrypted either — there is nobody to encrypt them to.
- **Attachments, encrypted.** A private attachment is encrypted to the two participants before it leaves
  the device. The media host stores ciphertext.
- **Metadata about devices and addresses.** Addresses are recorded only as a daily-rotating HMAC
  pseudonym in the security log, and a browser user agent is reduced to a coarse label such as
  "Chrome on Windows" before it is stored. Neither can be reversed or correlated across days.
- **Prekey material and public keys.** These are not secrets by design; a server that cannot see them
  cannot route a first message to an offline recipient.
- **Typing and read receipts, transiently.** A "still typing" or "read up to here" frame is relayed to
  the other end and forgotten. Nothing is written down: a durable record of who was in which conversation,
  and how far each had been read, is social graph data this server tries not to hold.

### What is *not* claimed

- **Sealed sender is not implemented.** Earlier versions of this project advertised it, with a Settings
  toggle and a table of who may do what with an anonymous message. It was removed, along with the schema
  it needed, because a message whose author is hidden cannot be edited or deleted by the person who wrote
  it — and that was judged a worse trade than the operator knowing who is in a conversation. There is no
  toggle, because there is no feature behind it.
- **The ratchet is the only body a message travels in.** There is a stateless RSA envelope in the code,
  and it is used in exactly one situation: a peer who has published no prekey bundle at all, so no
  ratchet session can be built. It is no longer attached to every message as a matter of course. That
  used to be how the sender's other devices could read what it sent, and it was the single largest
  weakness here — one long-lived key per account, present on every message, so seizing the server opened
  the entire history regardless of what the ratchet had achieved.
- **Attachments are covered by the same property.** A private attachment's key is folded into the sealed
  message body, not sent beside it. It used to travel in the payload wrapped to a long-lived key per
  participant, which meant the server held, next to every message, a key that never rotated and opened
  every attachment ever sent in every private chat — so the words were on the ratchet and the photo was
  not. A public-channel attachment is a deliberate exception: a room with no members has nobody to
  encrypt to, and uses one channel key that the server hands to signed-in clients.
- **Not independently audited.** The protocol code follows the Signal specification, but no external
  party has reviewed it. Treat this as unaudited software.
- **A malicious server can still misbehave.** It cannot read message contents, but it can drop messages,
  refuse to deliver them, or serve modified client code to a client that has not been verified.
- **Public keys are trusted on first use.** A server that hands out a key you did not expect is believed,
  because the server is also the only thing that can introduce you to somebody. Safety numbers let you
  compare keys with the other person by hand, which catches a substitution only if somebody actually
  looks. Comparing the number and marking the contact verified is remembered on that device, and the mark
  clears itself if the peer's account identity key later changes; it is a local record, not an attestation
  from anybody else.
- **No forward secrecy for the global channel**, and no anonymity guarantees for any channel.

### Honest limits of the ratchet

The header of a ratchet message — which chain it belongs to and where on that chain it sits — is bound
into the AEAD's associated data, along with a transcript hash of the handshake. A body therefore cannot
be moved to a different message number, a different ratchet key, or a different conversation. Decryption
is transactional: a body that does not authenticate leaves the session exactly where it was, so a server
cannot destroy a conversation by replaying or forging one.

What a server *can* still do is withhold messages, and it can observe the metadata above.

### Multi-device

Each device has its own identity key and its own signed prekey, and a message to somebody is sealed
separately for each of their devices. Nothing is shared between a phone and a laptop, so compromising one
does not open the other — a session is filed against two *devices*, not against two people, and
`tests/integration/dm-multidevice.test.ts` asserts that a body sealed for one device will not open on
another.

A sender's own other devices get a copy too, sealed the same way. That is what makes a conversation
readable on a second screen, and it is why there is no long-lived key in the path: there is no shared
secret for a seized server to use, because each copy is under a ratchet of its own.

Two things follow from this that are worth stating rather than leaving to be discovered:

- **A device can be missed.** A device that has been offline long enough for its signed prekey to age out
  cannot be sealed for, and its bundle is not served to senders. The message goes to the other devices
  and the sender is told, in the conversation header, that it did not reach all of them.
- **Devices do not share a safety number.** A safety number is derived from an account-level identity
  key, which is identical on every device the account owns — a number that differed per screen could not
  be read aloud and compared. When one *device* is replaced, the account key does not change and the
  numbers still match; the conversation says a device was replaced instead of claiming the person
  changed.

### The account password

The password never reaches the server. It is the key that every piece of local key material is sealed
under — sessions, prekeys, and the cached copy of this account's own outgoing messages are all AES-GCM
boxes under a PBKDF2 key derived from it. Changing it therefore rewrites those stores rather than
updating a field; the re-wrap is done under the old password first and the switch happens last, so an
interruption leaves the device readable with the password it was already readable with. The tests in
`tests/unit/password-change.test.ts` pin that down, including the case that matters most: messages already
in flight when the change happens still arrive, in order, afterwards.

Two passcodes are easy to confuse, so they are worth separating. The **account password** is a crypto key
and cannot be recovered or reset — losing it means losing the local history, which is why the encrypted
key backup exists. The **app passcode** in Settings is only a lock on the screen: it is a salted hash, it
is not used for anything cryptographic, and forgetting it is a matter of clearing it in settings.

## Download

Pre-built binaries on [Releases](https://github.com/PupSenYaSha/whispernet/releases):

| Platform | Asset |
|---|---|
| Windows | `WhisperNet_1.0.0_x64-setup.exe` — NSIS installer |
| Windows | `WhisperNet_1.0.0_x64-portable.zip` — plain executable, used by the in-app updater |
| Linux | `WhisperNet_1.0.0_amd64.deb` |
| Android | `WhisperNet.apk` |

The Windows build is **unsigned**. CI builds it with certificate auto-discovery switched off, so the
installer carries no Authenticode signature and Windows SmartScreen will warn on first run — which is the
same warning an unsigned build has always given, but it is stated here rather than implied away. Signing
it needs a code-signing certificate and the CI secret to hold it.

Android release builds need the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets; without them the workflow refuses to publish
rather than shipping a debug-signed APK. That refusal is deliberate and it fails the whole run, so an
Android build is all-or-nothing: no keystore means no APK, not a debug one.

### The in-app updater

The desktop shell checks the GitHub releases API, downloads the portable zip, and **refuses to install
anything it cannot check against a published digest**. A missing or unreadable `.sha256` for the exact file
being downloaded is a hard failure, not a warning.

The digest is fetched from the same place as the payload, so it catches a corrupted or stale download but
does **not** prove who published the build — that needs a signature, and no key is pinned in this
repository. `ALLOW_UNVERIFIED_UPDATES=1` will accept an unverifiable release; it is off by default and has
to be set deliberately.

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
| `ADMIN_KEY` | *(unset)* | Extra admin credential; without it admin rights follow the `admin` nickname, which cannot be registered |
| `PUBLIC_HOST` | *(request `Host`)* | Host baked into the Content-Security-Policy |
| `TRUST_PROXY` | `0` | Set to `1` behind a tunnel so `req.ip` is the real client. Without it, forwarding headers are honoured only from loopback |
| `MEDIA_BASE_URL` | `https://img.n1ko.dev` | Upstream used for media uploads and the proxy |
| `MEDIA_STORAGE` | `remote` | `local` keeps uploads in `DATA_DIR/media` instead of forwarding them |
| `TLS_KEY` / `TLS_CERT` | *(unset)* | Serve HTTPS/WSS directly instead of behind a proxy |
| `MAX_CONNECTIONS` | `10000` | Hard ceiling on open sockets |
| `MAX_UPLOAD_SIZE` | `1073741824` | Ceiling on one attachment, in bytes |
| `MAX_REGISTRATIONS_PER_IP` | `20` | Accounts one address may create per day; `0` lifts it |
| `MAX_AUTH_ATTEMPTS` | `300` | Coarse per-address auth backstop, counted before anybody has proved who they are |
| `ALLOW_UNVERIFIED_UPDATES` | *(unset)* | Desktop only; see above |

`npm start` also serves `site/` on `:3000` when that directory is present. It is not tracked in
git, so a fresh clone simply has no marketing site — the messenger on `:50025` is unaffected.

## Tests

```
npm run typecheck   # client, server and test projects
npm run lint
npm test            # unit and integration, against a real server on a real socket
```

The integration tests exercise the actual client crypto against the actual server over a real websocket,
because the failures worth catching in a messenger are almost never in the cipher — they are in how two
sides disagree about which body a message carries.

250 tests at the time of writing. Four of the bugs fixed in the current release were found by writing
tests rather than by reading code, which is the argument for them existing at all: a password check that
passed for any string, a ratchet session restarted by the second message in a conversation, an edit
routed to every device of a conversation, and an attachment key sitting in the payload beside the message
it opened.

What the tests do not cover is the React layer that calls them. Nothing here has run the app.

## License

[MIT](LICENSE)
