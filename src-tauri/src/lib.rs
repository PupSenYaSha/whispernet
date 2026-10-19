use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
#[cfg(windows)]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use tauri::{Manager, Url};

const DEFAULT_REMOTE_URL: &str = "https://rightfully-nice-ram.cloudpub.ru";
const DEFAULT_UPDATE_URL: &str = "https://api.github.com/repos/PupSenYaSha/whispernet";
const HEALTH_INTERVAL_SECS: u64 = 15;
const RETRY_INTERVAL_SECS: u64 = 10;
const HEALTH_TIMEOUT_SECS: u64 = 5;

/**
 * How the error page is recognised from the outside.
 *
 * It is the only thing this shell navigates to that is not the app, and it is a local `data:` document — so
 * anything that inspects the page has to be able to tell it apart. `show_error` sets the flag that lets
 * `show_app` navigate back, and this is what tells the watcher not to believe a `false` from a page that
 * cannot read its own settings.
 */
const ERROR_TITLE_PREFIX: &str = "WhisperNet — Ошибка";

const ERROR_HTML: &str = r##"<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhisperNet — Ошибка</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0c0a14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}
  .wrap{text-align:center;animation:fadeUp .8s ease}
  .icon{width:96px;height:96px;margin:0 auto 28px;position:relative}
  .icon svg{width:100%;height:100%}
  .ring{position:absolute;inset:-8px;border:2px solid #8b5cf6;border-radius:50%;opacity:.3;
    animation:pulse 2s ease-in-out infinite}
  .ring2{position:absolute;inset:-18px;border:1.5px solid #8b5cf6;border-radius:50%;opacity:.15;
    animation:pulse 2s ease-in-out infinite .4s}
  h1{font-size:22px;font-weight:600;margin-bottom:10px;color:#c4b5fd}
  p{font-size:15px;color:#94a3b8;line-height:1.6;max-width:360px;margin:0 auto 24px}
  .dot{display:inline-block;width:8px;height:8px;background:#8b5cf6;border-radius:50%;
    margin:0 3px;animation:bounce 1.4s ease-in-out infinite}
  .dot:nth-child(2){animation-delay:.2s}
  .dot:nth-child(3){animation-delay:.4s}
  .retry{font-size:13px;color:#64748b;margin-top:8px}
  @keyframes fadeUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.1);opacity:.1}}
  @keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}}
</style>
</head>
<body>
<div class="wrap">
  <div class="icon">
    <div class="ring"></div>
    <div class="ring2"></div>
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#8b5cf6"/>
          <stop offset="100%" stop-color="#6d28d9"/>
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="28" fill="url(#lg)"/>
      <path d="M30 75L42 40L54 65L66 35L78 65L90 40L90 75" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <circle cx="60" cy="88" r="4" fill="white" opacity="0.6"/>
    </svg>
  </div>
  <h1>Сервер временно недоступен</h1>
  <p>Похоже, произошла ошибка на сервере. Мы уже работаем над исправлением.</p>
  <div class="retry">Повторная попытка через <span id="sec">10</span>с</div>
  <div style="margin-top:20px">
    <span class="dot"></span><span class="dot"></span><span class="dot"></span>
  </div>
</div>
<script>
(function(){
  var item=document.getElementById('sec'),sec=10;
  var t=setInterval(function(){ sec--; if(sec<=0) sec=10; if(item) item.textContent=sec; },1000);
  setTimeout(function(){ clearInterval(t); }, 3600000);
})();
</script>
</body>
</html>"##;

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Deserialize)]
struct PagePayload {
    title: String,
    prot: bool,
}

struct HealthState {
    error_shown: AtomicBool,
}

/// What the user decided about a downloaded update: `None` while nobody has answered yet.
///
/// The updater used to wait three seconds and restart the app by itself, which made every "close" button
/// in the update dialog a lie - it hid an overlay that the desktop side was about to replace with a
/// restart, taking whatever was unsent with it. Waiting here for an actual answer makes the button mean
/// what it says. It has to be shared state rather than a flag in the updater thread because the answer
/// arrives from the webview, on a command, from a different thread entirely.
///
/// `awaiting` is what makes the question mean anything. Without it the mutex alone was pre-armable: a page
/// could call `set_update_consent(true)` during the first seconds after launch - before the updater had even
/// finished its five-second pause - and the answer sat in `decision` for the whole cycle. Minutes later,
/// when the download finished and the updater reached its "apply now?" point, `wait_for_update_consent`
/// found the stale `Some(true)` and returned immediately. Nobody was ever asked, `apply_and_restart` ran, and
/// the app killed itself mid-session along with anything unsent. The flag says the question is on screen,
/// and it is set only once the ready event has actually been dispatched.
#[derive(Default)]
struct UpdateConsent {
    decision: Mutex<Option<bool>>,
    awaiting: AtomicBool,
}

impl UpdateConsent {
    /// Forgets any earlier answer and closes the question, once per update cycle.
    ///
    /// Done at the *start* of a cycle on purpose. Resetting it when the update became ready would race the
    /// user: the ready event is dispatched to the webview, the user can answer before the updater thread is
    /// scheduled again, and a late reset would then erase the answer that had already been given.
    fn reset(&self) {
        self.awaiting.store(false, Ordering::SeqCst);
        if let Ok(mut d) = self.decision.lock() {
            *d = None;
        }
    }

    /// Opens the question. Called once the update is ready and the prompt has been shown.
    fn begin(&self) {
        if let Ok(mut d) = self.decision.lock() {
            *d = None;
        }
        self.awaiting.store(true, Ordering::SeqCst);
    }

    /// Records an answer, but only while a question is actually on screen.
    ///
    /// Returns whether it was taken, so the caller can log the refusal rather than silently dropping it.
    /// Anything arriving outside the window is a page that guessed the command name, or one holding a
    /// reference to a dialog it has already been through - and either way it is not consent.
    fn set(&self, grant: bool) -> bool {
        if !self.awaiting.load(Ordering::SeqCst) {
            return false;
        }
        if let Ok(mut d) = self.decision.lock() {
            *d = Some(grant);
        }
        true
    }

    /// Takes the answer, if there is one. Consuming it is what stops a second read from seeing it.
    fn take(&self) -> Option<bool> {
        self.awaiting.store(false, Ordering::SeqCst);
        self.decision.lock().ok().and_then(|mut d| d.take())
    }
}

/// Records the user's answer to "an update is ready". `grant: true` restarts into it.
#[tauri::command]
fn set_update_consent(app: tauri::AppHandle, consent: tauri::State<'_, UpdateConsent>, grant: bool) {
    if !consent.set(grant) {
        log_msg(&app, "update consent arrived with no question open; ignoring");
    }
}

/// Waits for the user to accept or decline, then reports what to do.
///
/// Returns `true` only on an explicit yes. A refusal and a timeout are deliberately the same answer: both
/// mean "leave this running", and neither should end in a restart the user did not ask for. Five minutes is
/// long enough to walk away from the dialog and come back to, short enough that a forgotten prompt does not
/// sit waiting for ever.
fn wait_for_update_consent(app: &tauri::AppHandle, consent: &UpdateConsent) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    loop {
        // Read once per pass, and it clears itself: an answer is spent the moment it is seen, so a `true`
        // left sitting in the mutex can never restart the app on a later cycle.
        match consent.take() {
            Some(grant) => return grant,
            None => {}
        }
        if std::time::Instant::now() >= deadline {
            log_msg(app, "Update consent timed out; keeping the current version");
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Where the app itself is loaded from, refusing anything that is not https.
///
/// The whole application is served from here and every request the client makes goes to the same host, so
/// an `http://` override is not one field in cleartext - it is the account's messages, the prekey bundles and
/// the media keys on the wire, and it points the privileged WebView at a page that can then call
/// `set_update_consent` and read the account out of localStorage. It also controls what `/health` is asked,
/// so a host that answers anything at all is enough to convince the shell the server is fine.
///
/// It used to be checked for nothing at all, ten lines below the check that `update_url` gets, and
/// `Url::parse(&remote_url()).expect("valid remote url")` then panicked the process on a malformed value -
/// a typo in an environment variable taking the app down rather than falling back.
fn remote_url() -> String {
    https_only("WHISPERNET_URL", DEFAULT_REMOTE_URL)
}

/// Where release metadata comes from, refusing anything that is not https.
///
/// The check below is a plain digest fetched from the same place as the payload, which catches a corrupted
/// download and a mirror serving something stale — and nothing else. A `http://` override would drop the
/// release metadata, the archive and the digest all onto the wire in the clear, at which point whoever is
/// in the middle simply serves a digest that matches. There is no signature and no pinning here, so https is
/// the only thing standing between the two, and an environment variable is not a safe place to lose it.
fn update_url() -> String {
    https_only("UPDATE_URL", DEFAULT_UPDATE_URL)
}

/// `https` or nothing, falling back to the compiled-in default.
///
/// Shared by both overrides because they have the same exposure and writing the check twice is how one of
/// them ends up without it. Not a scheme parse: `https://` is checked as a prefix so a value like
/// `https://` followed by nothing still reaches `Url::parse` in `show_app`, which reports the problem there
/// instead of here.
fn https_only(var: &str, default: &str) -> String {
    let raw = std::env::var(var).unwrap_or_else(|_| default.to_string());
    if raw.starts_with("https://") {
        return raw;
    }
    if raw != default {
        log_line(&format!("{} is not https; falling back to the default", var));
    }
    default.to_string()
}

/// One line into `update.log`, for the paths that have no `AppHandle` to hand.
fn log_line(msg: &str) {
    let Ok(dir) = dirs_app_local() else { return };
    append_log(&dir, msg);
}

fn dirs_app_local() -> Result<std::path::PathBuf, ()> {
    // Only ever used where an AppHandle is genuinely unavailable, so this goes as close as it can to the
    // place the Tauri path resolver would: %LOCALAPPDATA% on Windows, under this app's own subdirectory
    // rather than the bare directory, where `update.log` was a filename shared with every other program
    // installed for this user. Falling back to the temp directory is worse than doing nothing, because a log
    // in temp is one a different user can read.
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .ok_or(())?;
    Ok(base.join(APP_DIR_NAME))
}

/// The directory Tauri resolves `app_local_data_dir()` to on Windows, by hand.
///
/// Spelled out rather than asked for, because the one caller that has no `AppHandle` is exactly the caller
/// that cannot ask. If this and `identifier` in `tauri.conf.json` ever diverge the two loggers write to
/// different files, which loses nothing but the log.
const APP_DIR_NAME: &str = "ru.cloudpub.whispernet";

/// One line appended to this run's log, in a file opened once with `create_new`.
///
/// `create(true).append(true)` is what this used to do, and it follows a symlink: in a directory the user
/// can write, any process running as the same user could plant a reparse point at `update.log` pointing at
/// `~/.ssh/authorized_keys` or a cron file and have attacker-influenced error strings appended to it. The
/// generated `.bat` below already uses `create_new` for exactly this reason; the log did not. Checking
/// `is_symlink` first would not be enough either - that is a check on the name, then an open of the name, and
/// the gap between them is the whole bug.
///
/// Opened once per run and kept, so the log still accumulates within a session and the fixed name is never
/// opened at all. The price is that each run starts a new file rather than appending to the last one, named
/// `update-<pid>-<nanos>.log`, and the files accumulate; the pid makes it obvious which is which. Two
/// loggers asking for the same directory get the same handle - they are meant to be the same file, and if
/// the paths ever diverge the first one wins.
///
/// Same-user only, and that is the whole of the threat model either way: this stops a predictable, fixed
/// path from being a write primitive, and does nothing about a process already running as the user.
fn append_log(dir: &Path, msg: &str) {
    static LOG: std::sync::OnceLock<Mutex<Option<File>>> = std::sync::OnceLock::new();
    let cell = LOG.get_or_init(|| Mutex::new(None));
    let Ok(mut slot) = cell.lock() else { return };
    if slot.is_none() {
        let _ = fs::create_dir_all(dir);
        // Prune the previous runs' logs first, once per process.
        //
        // A new file is made per run, on purpose, so nothing is ever opened for append behind a link - but
        // nothing ever removed the old ones either, so a launch every day for a year left three hundred
        // and sixty-five files in the app's data directory. Thirty days is enough to read a failed update
        // report from, and the entries are matched by name and age only, so this cannot follow a link out
        // of the directory any more than writing them could not.
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with("update-") || !name.ends_with(".log") {
                    continue;
                }
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|m| SystemTime::now().duration_since(m).map(|d| d.as_secs()))
                    .unwrap_or(Ok(0))
                    .unwrap_or(0)
                    > 30 * 24 * 60 * 60;
                if old {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = dir.join(format!("update-{}-{}.log", std::process::id(), stamp));
        // No `append` on a name that already exists: `create_new` fails instead of following a link.
        *slot = OpenOptions::new()
            .write(true)
            .append(true)
            .create_new(true)
            .open(&path)
            .ok();
    }
    if let Some(f) = slot.as_mut() {
        let _ = writeln!(f, "[{}] {}", now_iso(), msg);
    }
}

fn now_iso() -> String {
    // Not ISO-8601, despite the name, and never was: `{:?}` on a Duration prints "1.234s". It is a log
    // timestamp, so what it needs to be is monotonic and short.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn log_msg(app: &tauri::AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    append_log(&dir, msg);
}

fn evaluate(app: &tauri::AppHandle, js: String) {
    let receiver = app.clone();
    let fwd = app.clone();
    let _ = receiver.run_on_main_thread(move || {
        if let Some(win) = fwd.get_webview_window("main") {
            let _ = win.eval(js);
        }
    });
}

/// Whether the configured host is actually serving the app.
///
/// 2xx and nothing else. `code < 500` used to be good enough, and it accepted 401, 403, 404, 418 and 429 -
/// every one of which is what a captive portal, a WAF or a misconfigured reverse proxy answers with. The
/// effect of calling any of those "healthy" is that the error screen is never shown and the window loads
/// whatever that host serves instead, in the privileged WebView, with the app's origin.
///
/// Redirects are not followed, because a 302 chain ending in somebody else's 200 would satisfy the same
/// check by a longer route. `redirects(0)` makes the 3xx the answer instead of the destination of it.
fn remote_ok() -> bool {
    let target = format!("{}/health", remote_url());
    let agent = ureq::builder().redirects(0).build();
    match agent
        .get(&target)
        .timeout(Duration::from_secs(HEALTH_TIMEOUT_SECS))
        .call()
    {
        Ok(res) => (200..300).contains(&res.status()),
        // A 4xx or 5xx comes back as Err(Status); both mean this is not the app serving us.
        Err(_) => false,
    }
}

fn error_url() -> Url {
    let encoded = utf8_percent_encode(ERROR_HTML, NON_ALPHANUMERIC).to_string();
    Url::parse(&format!("data:text/html;charset=utf-8,{}", encoded)).expect("valid data URL")
}

fn show_app(app: &tauri::AppHandle) {
    // `https_only` above has already refused a non-https override, so what is left that can fail to parse is
    // a syntactically broken https URL - and that used to be an `expect`, which is a panic on a background
    // thread from a value in the environment. An unparseable URL leaves the error page up, which is where
    // the supervisor would have left it anyway.
    let url = match Url::parse(&remote_url()) {
        Ok(u) => u,
        Err(e) => {
            log_msg(app, &format!("remote url does not parse: {}", e));
            return;
        }
    };
    let receiver = app.clone();
    let fwd = app.clone();
    let _ = receiver.run_on_main_thread(move || {
        if let Some(win) = fwd.get_webview_window("main") {
            let _ = win.navigate(url);
        }
    });
}

fn show_error(app: &tauri::AppHandle) {
    // Recorded here as well as in the supervisor, because this is the only thing that navigates the window
    // away from the app and `show_app` is gated on the flag being set. Whoever turns the error page on has
    // to turn it off again, or the window sits on a local `data:` document with nothing in it able to get
    // back - no recovery path at all, since that page cannot poll `/health` itself.
    if let Some(state) = app.try_state::<Arc<HealthState>>() {
        state.error_shown.store(true, Ordering::SeqCst);
    }
    let receiver = app.clone();
    let fwd = app.clone();
    let _ = receiver.run_on_main_thread(move || {
        if let Some(win) = fwd.get_webview_window("main") {
            let _ = win.navigate(error_url());
        }
    });
}

fn supervisor(app: tauri::AppHandle) {
    loop {
        if remote_ok() {
            break;
        }
        show_error(&app);
        std::thread::sleep(Duration::from_secs(RETRY_INTERVAL_SECS));
    }

    show_app(&app);

    let state = app.state::<Arc<HealthState>>();
    loop {
        std::thread::sleep(Duration::from_secs(HEALTH_INTERVAL_SECS));
        let ok = remote_ok();
        if ok {
            if state.error_shown.swap(false, Ordering::SeqCst) {
                show_app(&app);
            }
        } else if !state.error_shown.swap(true, Ordering::SeqCst) {
            show_error(&app);
        }
    }
}

const POLL_JS: &str = r##"(function(){
  if(!window.__wnDesktop) window.__wnDesktop = true;
  var prot = false;
  try {
    // The setting moved into wn_settings when the rest of the preferences were tidied up; the old key
    // is still consulted so a desktop shell talking to an older build still protects the window.
    var raw = localStorage.getItem('wn_settings');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.screenshotProtection === 'boolean') prot = parsed.screenshotProtection;
    }
    if (!prot && localStorage.getItem('wn_screenshot_prot')) prot = true;
  } catch(e) {}
  return JSON.stringify({ title: document.title, prot: prot });
})()"##;

fn watcher(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<String>();
    // `Some(true)`, not `None`, and it has to agree with what `setup` applied. The common first run is the
    // server being down: the window goes straight to the local error page, which is a `data:` URL whose
    // localStorage read throws, so the poll never produces an answer and `last_prot` staying `None` meant
    // `set_content_protected` was never called at all - a capturable window, on the first launch, exactly
    // when the comment above it claimed the last known answer was being held. There is no previous answer
    // here, so the answer is protected.
    let mut last_prot: Option<bool> = Some(true);
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let app2 = app.clone();
        let tx2 = tx.clone();
        let receiver = app2.clone();
        let _ = receiver.run_on_main_thread(move || {
            if let Some(win) = app2.get_webview_window("main") {
                let _ = win.eval_with_callback(POLL_JS, move |t| {
                    let _ = tx2.send(t);
                });
            }
        });
        while let Ok(raw) = rx.try_recv() {
            let raw = raw.trim().to_string();
            // Every one of these is "no answer", and no answer now means *hold what you had*.
            //
            // The watcher polls every two seconds starting two seconds after launch, and `document.title`
            // is empty until the app sets it. An unparseable payload therefore arrives on every cold start
            // and after every navigation, and `prot` defaulted to false — so the very first poll answered
            // the question "is the page capturable?" with "yes" and switched screenshot protection off for
            // the whole page-load window. `setup` had turned it on a moment earlier, and the window was
            // capturable from launch until the app rendered, in a messenger whose entire value is that the
            // screen is not readable. `eval_with_callback` also hands back an empty string when the script
            // fails, which lands here the same way.
            //
            // An empty title is the other no-answer case, and it had a second effect: the fallback left
            // `title` holding the raw inner JSON, which is not empty, so the window title became the
            // literal string `{"title":"","prot":false}`.
            if raw.is_empty() {
                continue;
            }
            let Ok(inner) = serde_json::from_str::<String>(&raw) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<PagePayload>(&inner) else {
                continue;
            };
            if payload.title.is_empty() {
                continue;
            }
            let title = payload.title;
            let prot = payload.prot;
            if !title.is_empty() {
                // The title is the page's own `document.title`, which the app builds out of the signed-in
                // account's nickname. It used to be pattern-matched against "502", "503", "504" and
                // "Bad Gateway" to notice that a reverse proxy had answered with an error page instead of
                // the app - which let any account brick any other client, permanently, just by registering
                // a nickname containing three digits. `contains` on free text, driven by a stranger.
                //
                // Server health is decided by `remote_ok`, which asks `/health` over HTTP and so cannot be
                // influenced by anything the page says. The title is only ever used to label the window
                // here, and `set_title` is not fed untrusted text straight into the OS title bar without a
                // length bound below, because that is a phishing primitive in an app people type names into.
                let app3 = app.clone();
                let title3 = title.clone();
                let receiver3 = app3.clone();
                let _ = receiver3.run_on_main_thread(move || {
                    if let Some(w) = app3.get_webview_window("main") {
                        // bounded, so a long nickname cannot push the real window controls off the bar
                        let mut label: String = title3.chars().take(120).collect();
                        if label.chars().count() < title3.chars().count() {
                            label.push('…');
                        }
                        let _ = w.set_title(&label);
                    }
                });
            }
            // Deliberately not derived while the error page is up. That page is a `data:` URL, where
            // touching localStorage throws a SecurityError, so the read fails and `prot` comes back false -
            // which switched screenshot protection off for the window and left the local error page, of all
            // things, capturable. The last known answer is held instead, so the setting survives a blip.
            let on_error_page = title.starts_with(ERROR_TITLE_PREFIX);
            if !on_error_page && last_prot != Some(prot) {
                last_prot = Some(prot);
                let app4 = app.clone();
                let receiver4 = app4.clone();
                let _ = receiver4.run_on_main_thread(move || {
                    if let Some(w) = app4.get_webview_window("main") {
                        // Reported rather than dropped. `set_content_protected` is `SetWindowDisplayAffinity`,
                        // which does not exist before Windows 10 2004 - and `tao`'s Windows implementation
                        // discards the error too, so a build on an older OS fails open with nothing said
                        // anywhere. The result is the only signal there is, so it goes to the log.
                        if let Err(e) = w.set_content_protected(prot) {
                            log_msg(&app4, &format!("set_content_protected({}) failed: {}", prot, e));
                        }
                    }
                });
            }
        }
    }
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<i32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<i32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = *pa.get(i).unwrap_or(&0);
        let y = *pb.get(i).unwrap_or(&0);
        if x > y {
            return 1;
        }
        if x < y {
            return -1;
        }
    }
    0
}

fn json_escape(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  for c in input.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      '<' => out.push_str("\\u003c"),
      '>' => out.push_str("\\u003e"),
      '&' => out.push_str("\\u0026"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out
}

fn push_update(app: &tauri::AppHandle, detail_json: String) {
  let safe = json_escape(&detail_json);
  let js = format!(
    "window.dispatchEvent(new CustomEvent('whispernet-update',{{detail:{}}}))",
    safe
  );
  evaluate(app, js);
}

fn fetch_release(app: &tauri::AppHandle) -> Result<Release, String> {
    let base = update_url();
    let url = format!("{}/releases/latest", base);
    log_msg(app, &format!("GET {}", url));
    let resp = ureq::get(&url)
        .set("User-Agent", "WhisperNet")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("fetch release: {}", e))?
        .into_string()
        .map_err(|e| format!("read release body: {}", e))?;
    serde_json::from_str(&resp).map_err(|e| format!("parse release: {}", e))
}

fn download(app: &tauri::AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", "WhisperNet")
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| format!("download: {}", e))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = File::create(dest).map_err(|e| format!("create file: {}", e))?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done: u64 = 0;
    // Bounded on both the declared length and what actually arrives.
    //
    // Nothing downstream caps this: `MAX_EXTRACT_BYTES` bounds what comes *out* of the archive, and the
    // archive itself is written until the response ends. A release host that has been compromised, or an
    // `UPDATE_URL` pointed somewhere hostile, could stream until the disk was full — and on the machine of
    // the one person who was already convinced to install an update. The declared length is checked first so
    // the common case costs one `Content-Length` and never touches the disk; the running total is checked as
    // well, because the header is the server's claim and this is a server that has already been described as
    // able to misbehave.
    if total > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "update is {} bytes, over the {} byte limit",
            total, MAX_DOWNLOAD_BYTES
        ));
    }
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read stream: {}", e))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > MAX_DOWNLOAD_BYTES {
            let _ = std::fs::remove_file(dest);
            return Err("download exceeded the size limit".to_string());
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("write file: {}", e))?;
        if total > 0 {
            let percent = (done as f64 / total as f64 * 100.0).round() as u64;
            push_update(
                app,
                format!(
                    "{{\"kind\":\"progress\",\"status\":\"downloading\",\"percent\":{}}}",
                    percent
                ),
            );
        }
    }
    Ok(())
}

/// SHA-256 of the whole file, read through an already-open handle.
///
/// Takes the handle rather than a path so that hashing and extracting are the same open file. Hashing by
/// path and then extracting by path means any process running as this user can swap the archive in between,
/// after the signature has already passed - the check verifies one file and the app installs another.
///
/// Leaves the handle at the start, which is where the caller wants it for `ZipArchive`.
fn sha256_handle(file: &mut File) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("rewind: {}", e))?;
    let mut hasher = Sha256::new();
    io::copy(file, &mut hasher).map_err(|e| format!("hash: {}", e))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("rewind: {}", e))?;
    Ok(hex::encode(hasher.finalize()))
}

fn fetch_text(url: &str) -> Result<String, String> {
    ureq::get(url)
        .set("User-Agent", "WhisperNet")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("fetch text: {}", e))?
        .into_string()
        .map_err(|e| format!("read text: {}", e))
}

/// Whether this build accepts an update it cannot check.
///
/// Off by default, and the reason it exists at all is that the check below is a plain digest fetched
/// from the same place as the payload. That catches a corrupted download and a mirror serving something
/// stale. It does not catch whoever controls the release - for that the payload has to be signed, and
/// nothing here holds a key. Turning this on is a statement that you are willing to install a build you
/// cannot verify, so it has to be said out loud rather than assumed.
fn unverified_updates_allowed() -> bool {
    matches!(
        std::env::var("ALLOW_UNVERIFIED_UPDATES").unwrap_or_default().as_str(),
        "1" | "true" | "yes"
    )
}

/// The Ed25519 public half that update signatures are checked against.
///
/// Compiled into the binary, which is the only place it can live: the point is that the answer to "did
/// the person who published this release publish it" cannot itself be changed by whoever can change a
/// release. A key fetched from the same server as the payload would be no check at all.
///
/// The private half is never in this repository. `scripts/generate-update-key.mjs` makes the pair, writes
/// only the private half to a file, and prints the public half for pasting here; the private half goes into
/// the `UPDATE_SIGNING_KEY_BASE64` repository secret so CI can sign with it.
///
/// There is no second key and no recovery path. A key that can no longer sign is a key that can no longer
/// be used, and publishing a replacement is itself a release. Back it up before losing it.
const UPDATE_PUBLIC_KEY: &str = "98dbf093b229b4afd419c6a7ec347a9607c3efc08372163d0aef314117303cb2";

/// The signature covers the **32 digest bytes**, not the archive.
///
/// Signing 50 MB on every build is slow and says nothing more: if the bytes on disk hash to the signed
/// digest, they are the bytes that were signed. So the chain is signature -> digest, then digest -> file,
/// and `verify_update` walks it in that order - it checks the download against the published digest *before*
/// asking whether the signature is any good, because a signature over a digest that says nothing about what
/// was downloaded is a statement about nothing.
///
/// `ring` is already in the dependency tree through Tauri, so this costs no new crate and no new build.

/// The signature check itself, with no network, no logging and no Tauri types.
///
/// Split out from `verify_update_signature` because that one is nearly all plumbing - finding the asset,
/// fetching it, logging, deciding what to do about the escape hatch - and none of that is what has to be
/// right. This is the part that has to be right, and it is testable because it takes its inputs as
/// arguments. The key is a parameter rather than the constant above so a test can sign with a key it made
/// itself: without that, every test here would be an assertion that a valid signature is *rejected*, which
/// a verifier that refused everything would also satisfy.
///
/// `digest_hex` is the published SHA-256 of the download, `signature_hex` the contents of the `.sig` asset.
fn check_signature_with(
    public_key_hex: &str,
    digest_hex: &str,
    signature_hex: &str,
) -> Result<(), String> {
    let signature: String = signature_hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if signature.len() != 128 {
        return Err("signature is not 128 hex characters".into());
    }
    let signature_bytes = hex::decode(&signature).map_err(|e| format!("signature is not hex: {}", e))?;

    let digest_bytes = hex::decode(digest_hex).map_err(|e| format!("digest is not hex: {}", e))?;
    if digest_bytes.len() != 32 {
        return Err("digest is not 32 bytes".into());
    }

    let public = hex::decode(public_key_hex).map_err(|e| format!("public key is not hex: {}", e))?;
    if public.len() != 32 {
        return Err("public key is not 32 bytes".into());
    }

    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public)
        .verify(&digest_bytes, &signature_bytes)
        .map_err(|e| format!("signature rejected: {:?}", e))
}

/// The same check against the key compiled into this build.
fn check_signature(digest_hex: &str, signature_hex: &str) -> Result<(), String> {
    check_signature_with(UPDATE_PUBLIC_KEY, digest_hex, signature_hex)
}

fn verify_update_signature(
    app: &tauri::AppHandle,
    release: &Release,
    zip_name: &str,
    digest: &str,
) -> Result<(), String> {
    let expected_name = format!("{}.sig", zip_name);
    let Some(asset) = release.assets.iter().find(|a| a.name == expected_name) else {
        log_msg(app, &format!("no {} published; refusing to install", expected_name));
        if unverified_updates_allowed() {
            log_msg(app, "ALLOW_UNVERIFIED_UPDATES is set; installing anyway");
            return Ok(());
        }
        return Err(format!(
            "update refused: the release publishes no {}, so nothing says who built it",
            expected_name
        ));
    };

    let text = fetch_text(&asset.browser_download_url)?;

    // A verified failure and an unreadable one are the same event as far as the person installing is
    // concerned, and telling them apart would help anyone probing which part they got past.
    let rejected = match check_signature(digest, &text) {
        Ok(()) => {
            log_msg(app, "update signature verified");
            return Ok(());
        }
        Err(e) => e,
    };
    log_msg(app, &format!("signature check failed: {}", rejected));
    if unverified_updates_allowed() {
        log_msg(app, "ALLOW_UNVERIFIED_UPDATES is set; installing anyway");
        return Ok(());
    }
    Err("update refused: the signature is not from this project's signing key. The release may not be \
         yours, or the key has been rotated without a new build."
        .into())
}

/// Checks the downloaded archive against the release, and hands back the open file it checked.
///
/// Returning the handle rather than nothing is the point: the caller installs from *this* file, so the bytes
/// that were hashed and the bytes that are written are the same bytes through the same handle. Opening the
/// path twice - once to hash, once to unpack - leaves a window in which any process running as this user
/// replaces `update.zip`, and the replacement is installed after a signature check that passed on the
/// original. Same-user only; it is not a defence against whoever controls the machine.
fn verify_update(app: &tauri::AppHandle, release: &Release, zip_path: &Path, zip_name: &str) -> Result<File, String> {
    let mut file = File::open(zip_path).map_err(|e| format!("open {}: {}", zip_path.display(), e))?;

    // The digest has to be the one published for this exact file. Matching "any asset ending in
    // .sha256" would accept a digest belonging to a different artefact in the same release.
    let expected_name = format!("{}.sha256", zip_name);
    let digest_asset = release.assets.iter().find(|a| a.name == expected_name);

    let Some(asset) = digest_asset else {
        log_msg(app, &format!("no {} published; refusing to install", expected_name));
        if unverified_updates_allowed() {
            // Said in those words, because it is what happens. These two branches return before
            // `sha256_handle` and before `verify_update_signature` are ever reached, so the archive is
            // unpacked and installed having been checked against *nothing at all* - not even for the
            // damage a truncated or substituted download would do. The escape hatch is documented as being
            // about the signature, and it is not.
            log_msg(app, "ALLOW_UNVERIFIED_UPDATES is set; installing a build that was checked against nothing - not even a digest");
            return Ok(file);
        }
        return Err(format!(
            "update refused: the release publishes no {} to check the download against",
            expected_name
        ));
    };

    let text = fetch_text(&asset.browser_download_url)?;
    let Some(captured) = regex_capture_hex(&text) else {
        log_msg(app, "digest asset unparseable; refusing to install");
        if unverified_updates_allowed() {
            // as above: nothing has been hashed and nothing will be signed-checked
            log_msg(app, "ALLOW_UNVERIFIED_UPDATES is set; installing a build that was checked against nothing - not even a digest");
            return Ok(file);
        }
        return Err("update refused: the published digest could not be read".into());
    };

    let expected = captured.to_lowercase();
    let actual = sha256_handle(&mut file)?;
    if expected != actual {
        log_msg(app, "SHA-256 mismatch; refusing to install");
        return Err("update integrity check failed (SHA-256 mismatch)".into());
    }
    log_msg(app, &format!("SHA-256 verified: {}", &actual[..12]));

    // Only once the file is known to match the published digest does the signature mean anything: it is a
    // statement about those exact bytes. Checking it first would prove who signed a digest that says nothing
    // about what was downloaded.
    verify_update_signature(app, release, zip_name, &expected)?;
    Ok(file)
}

fn regex_capture_hex(text: &str) -> Option<String> {
    if let Some(idx) = text.find(|c: char| c.is_ascii_hexdigit()) {
        let start = idx;
        let end = text[start..]
            .find(|c: char| !c.is_ascii_hexdigit())
            .map(|i| start + i)
            .unwrap_or(text.len());
        let slice = &text[start..end];
        if slice.len() == 64 {
            return Some(slice.to_string());
        }
    }
    None
}

/// How much a downloaded update may expand to, and how many entries it may hold.
///
/// There was no ceiling at all: every entry was copied with `io::copy` and no running total, so an archive
/// of a few dozen kilobytes could fill the disk it was being unpacked onto. A zip bomb does not have to
/// survive the SHA-256 check to be a problem, because whoever published the release published the digest
/// with it — the check catches a corrupted transfer, not a hostile one. Generous enough for a Tauri build:
/// the installer and the executable together are well under a hundred megabytes.
const MAX_EXTRACT_BYTES: u64 = 512 * 1024 * 1024;
/// Ceiling on the archive itself, checked while it is downloaded rather than once it is on disk.
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXTRACT_ENTRIES: usize = 64;

fn extract_update(app: &tauri::AppHandle, file: File, dest_dir: &Path) -> Result<(), String> {
    let _ = app;
    // Built from the handle `verify_update` hashed, not from the path it hashed - see its comment.
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {}", e))?;
    if archive.len() > MAX_EXTRACT_ENTRIES {
        return Err(format!(
            "update package holds {} entries, over the limit of {}",
            archive.len(),
            MAX_EXTRACT_ENTRIES
        ));
    }
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "whispernet.exe".to_string());
    let mut written: u64 = 0;
    for i in 0..archive.len() {
        let mut zf = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {}: {}", i, e))?;
        // Windows PowerShell 5.1's `Compress-Archive` writes separators as backslashes, so `sub\a.txt` is a
        // perfectly ordinary archive and used to be rejected outright as "unsafe" - every client refusing
        // the update over a message that reads as tampering. Normalising first is what the checks below
        // need anyway: they are all path-segment based, and a segment is delimited by `/` only. The
        // traversal and drive-letter tests are unchanged and still run on the normalised name, so this
        // widens what is accepted without widening what is written.
        let name = zf.name().replace('\\', "/");
        let unsafe_name = name.starts_with('/')
            || (name.len() > 1 && name.as_bytes()[1] == b':')
            || name
                .split('/')
                .any(|s| s == ".." || s == "." || s.contains(':'))
            || zf
                .unix_mode()
                .map(|m| (m & 0o170000) == 0o120000)
                .unwrap_or(false);
        if unsafe_name {
            return Err(format!("unsafe entry in update package: {}", name));
        }
        // Reserved DOS device names, which the checks above cannot see.
        //
        // `NUL`, `CON`, `COM1`, `LPT1` and their numbered forms contain no separator, no dot and no colon,
        // so every test above passes - and on Windows `File::create("NUL")` opens the device rather than a
        // file. A write then goes nowhere the archive names, and a read comes back empty, which is a quieter
        // outcome than a refusal but not one that should be reachable at all. Only a signed archive gets
        // this far, so this is about not trusting one source's idea of what is a safe name.
        if name
            .split('/')
            .next_back()
            .map(|s| {
                let base = s.split('.').next().unwrap_or("").to_ascii_uppercase();
                base == "NUL"
                    || base == "CON"
                    || base == "PRN"
                    || base == "AUX"
                    || (base.len() == 4
                        && (base.starts_with("COM") || base.starts_with("LPT"))
                        && base[3..].parse::<u32>().map(|n| (1..=9).contains(&n)).unwrap_or(false))
            })
            .unwrap_or(false)
        {
            return Err(format!("reserved device name in update package: {}", name));
        }
        let file_name = if name.ends_with(".exe") {
            exe_name.clone()
        } else {
            name.split('/').last().unwrap_or(&name).to_string()
        };
        if file_name.is_empty() {
            continue;
        }
        // counted before anything is written, from the size the archive declares, so an entry that lies
        // about it is refused rather than started
        let declared = zf.size();
        if written.saturating_add(declared) > MAX_EXTRACT_BYTES {
            return Err(format!(
                "update package expands past the {} MiB limit; refusing",
                MAX_EXTRACT_BYTES / 1024 / 1024
            ));
        }
        let dest = dest_dir.join(&file_name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
        let mut out = File::create(&dest).map_err(|e| format!("create {}: {}", e, dest.display()))?;
        // and counted again from what actually arrived, because the declared size is not a bound
        let copied = io::copy(&mut zf, &mut out).map_err(|e| format!("extract {}: {}", file_name, e))?;
        written = written.saturating_add(copied);
        if written > MAX_EXTRACT_BYTES {
            return Err("update package expanded past its declared size; refusing".into());
        }
    }
    Ok(())
}

/// Swaps the running executable for the downloaded one and starts it again, via a generated `.bat`.
///
/// Windows only, and the `#[cfg]` is load-bearing rather than tidy: CI ships a `.deb` from the same source,
/// so on Linux this used to write a `.bat`, fail to spawn `cmd.exe`, log, and return - after the user had
/// already pressed "apply now". The consent was given, the update was downloaded and verified, and nothing
/// happened at all, with the only trace being one line in a log nobody reads. Now the other platforms say so
/// out loud instead.
#[cfg(windows)]
fn apply_and_restart(app: &tauri::AppHandle, update_dir: &Path) {
    let Ok(current) = std::env::current_exe() else {
        log_msg(app, "apply: cannot resolve current exe");
        return;
    };
    let Some(exe_name) = current.file_name() else {
        log_msg(app, "apply: cannot resolve exe name");
        return;
    };
    let payload = update_dir.join(exe_name);
    if !payload.exists() {
        log_msg(app, "apply: payload not found; skipping");
        return;
    }
    // Written inside the app's own data directory, not the shared temp one, and created exclusively.
    //
    // It used to be `%TEMP%\whispernet_update.bat` with a fixed name and `fs::write`, which is a text file
    // any process running as the same user can predict. `fs::write` follows a symlink, so a reparse point
    // planted at that path first would have had its target truncated and overwritten with a script this
    // shell then executes - content the attacker chose, running as the user. The name is not guessable
    // enough and the directory is not shared, and `create_new` means the file is this one's or nothing.
    let dir = match app.path().app_local_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log_msg(app, &format!("apply: no app data dir: {}", e));
            return;
        }
    };
    if fs::create_dir_all(&dir).is_err() {
        log_msg(app, "apply: cannot create app data dir");
        return;
    }
    let unique = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let bat_path = dir.join(format!("update-{}-{}.bat", std::process::id(), unique));
    let pid = std::process::id();
    // A `"` inside either path closes the quoted argument early and everything after it is parsed as more
    // of the command line, so it is removed rather than escaped - `cmd.exe` has no escape for it inside
    // quotes, and Windows filenames cannot contain one anyway, so this never touches a path that exists.
    let payload_arg = payload.display().to_string().replace('"', "");
    let current_arg = current.display().to_string().replace('"', "");
    // copy to a temporary name and then move, rather than copying over the executable in place.
    //
    // `copy /y` opens the destination and writes into it, so anything that interrupts it - the machine
    // being shut down, the process being killed, a full disk - leaves a truncated `whispernet.exe` where the
    // only copy used to be. The old binary was already deleted by the `taskkill` line above, so the result is
    // an app that cannot be started and cannot be reinstalled over, and the only way out is a manual
    // reinstall. `move` within one directory is a rename, which either happens or does not.
    let staging = format!("{}.new", current_arg);
    let bat = format!(
        "@echo off\r\ntimeout /t 2 /nobreak > nul\r\ntaskkill /pid {} /f > nul 2>&1\r\n\
         copy /y \"{}\" \"{}\" > nul\r\n\
         if errorlevel 1 goto :failed\r\n\
         move /y \"{}\" \"{}\" > nul\r\n\
         if errorlevel 1 goto :failed\r\n\
         start \"\" \"{}\"\r\n\
         del \"%~f0\"\r\nexit /b 0\r\n\
         :failed\r\n\
         del \"{}\" > nul 2>&1\r\n\
         start \"\" \"{}\"\r\n\
         del \"%~f0\"\r\n",
        pid,
        payload_arg,
        staging,
        staging,
        current_arg,
        current_arg,
        staging,
        current_arg,
    );
    if let Err(e) = write_file_new(&bat_path, bat.as_bytes()) {
        log_msg(app, &format!("apply: cannot write update script: {}", e));
        return;
    }
    log_msg(app, "apply: scheduling swap and restart");
    // Reported rather than dropped. Every command in the script redirects to `nul`, so a failed copy or a
    // failed taskkill restarts the *old* binary and tells nobody; this at least puts the launch in the log.
    if let Err(e) = Command::new("cmd.exe")
        .args(["/c", &bat_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        log_msg(app, &format!("apply: cannot launch update script: {}", e));
        return;
    }
    app.exit(0);
}

#[cfg(not(windows))]
fn apply_and_restart(app: &tauri::AppHandle, _update_dir: &Path) {
    log_msg(app, "apply: not supported on this platform; install the new package manually");
    push_update(
        app,
        "{\"kind\":\"error\",\"message\":\"in-app updates are Windows-only; install the downloaded \
         package to update\"}"
            .into(),
    );
}

/// `fs::write`, but refusing to touch anything that already exists.
///
/// Windows-only for the same reason the `.bat` writer is: this exists for the generated update script and
/// has no other caller. `append_log` opens its own handle with `create_new` inline rather than through here,
/// because it needs to keep writing to the same file afterwards.
#[cfg(windows)]
fn write_file_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn updater(app: tauri::AppHandle, consent: Arc<UpdateConsent>) {
    // Once per cycle, before anything can answer: a "yes" belonging to last week's update must not restart
    // this week's on its own.
    consent.reset();
    std::thread::sleep(Duration::from_secs(5));
    log_msg(&app, "Checking...");
    let release = match fetch_release(&app) {
        Ok(r) => r,
        Err(e) => {
            log_msg(&app, &format!("Error: {}", e));
            push_update(
                &app,
                format!("{{\"kind\":\"error\",\"message\":\"{}\"}}", e),
            );
            return;
        }
    };
    let latest = release.tag_name.trim_start_matches('v').to_string();
    let current = app.package_info().version.to_string();
    log_msg(&app, &format!("Latest: {}, Current: {}", latest, current));
    if compare_versions(&latest, &current) <= 0 {
        log_msg(&app, "Up to date");
        return;
    }
    let Some(asset) = release.assets.iter().find(|a| a.name.ends_with(".zip")) else {
        log_msg(&app, "No zip asset");
        return;
    };
    let zip_name = asset.name.clone();
    log_msg(&app, &format!("Update: {}", latest));
    push_update(
        &app,
        format!("{{\"kind\":\"available\",\"version\":\"{}\"}}", latest),
    );

    let base_dir = match app.path().app_local_data_dir() {
        Ok(d) => d.join("update"),
        Err(_) => {
            push_update(&app, "{\"kind\":\"error\",\"message\":\"no data dir\"}".into());
            return;
        }
    };
    if base_dir.exists() {
        let _ = fs::remove_dir_all(&base_dir);
    }
    if fs::create_dir_all(&base_dir).is_err() {
        push_update(&app, "{\"kind\":\"error\",\"message\":\"mkdir failed\"}".into());
        return;
    }
    let zip_path = base_dir.join("update.zip");
    if let Err(e) = download(&app, &asset.browser_download_url, &zip_path) {
        log_msg(&app, &format!("Error: {}", e));
        push_update(&app, format!("{{\"kind\":\"error\",\"message\":\"{}\"}}", e));
        return;
    }
    log_msg(&app, "Downloaded");
    // One handle: opened here, hashed by `verify_update`, and installed from by `extract_update`.
    let checked = match verify_update(&app, &release, &zip_path, &zip_name) {
        Ok(f) => f,
        Err(e) => {
            log_msg(&app, &format!("Error: {}", e));
            push_update(&app, format!("{{\"kind\":\"error\",\"message\":\"{}\"}}", e));
            return;
        }
    };
    push_update(
        &app,
        "{\"kind\":\"progress\",\"status\":\"extracting\",\"percent\":100}".into(),
    );
    let extract_dir = base_dir.join("new");
    if let Err(e) = extract_update(&app, checked, &extract_dir) {
        log_msg(&app, &format!("Error: {}", e));
        push_update(&app, format!("{{\"kind\":\"error\",\"message\":\"{}\"}}", e));
        return;
    }
    log_msg(&app, "Extracted");
    push_update(
        &app,
        format!("{{\"kind\":\"ready\",\"version\":\"{}\"}}", latest),
    );
    std::thread::sleep(Duration::from_secs(3));
    // Ask before restarting. Everything above is preparation; this is the only step the user can lose
    // unsent messages to, so it is the only step that needs their agreement. The question opens here, after
    // the prompt is on screen - opening it earlier is exactly the pre-arming this guards against.
    consent.begin();
    if !wait_for_update_consent(&app, &consent) {
        log_msg(&app, "Update declined; staying on the current version");
        push_update(
            &app,
            "{\"kind\":\"cancelled\",\"version\":\"\"}".into(),
        );
        return;
    }
    apply_and_restart(&app, &extract_dir);
    log_msg(&app, "Update applied; restarting");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let health_state = Arc::new(HealthState {
        error_shown: AtomicBool::new(false),
    });
    let update_consent = Arc::new(UpdateConsent::default());

    tauri::Builder::default()
        .manage(health_state)
        .manage(update_consent.clone())
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .expect("main window must exist");

            // Protected before the window is ever shown, and before any page has had the chance to say
            // otherwise. `watcher` reads the preference every two seconds, so leaving this to it means the
            // window is on screen and capturable for the first two seconds of every launch - and forever, if
            // the first page to load is the local error page. Fails closed, then relaxed if the account's
            // settings say so.
            if let Err(e) = window.set_content_protected(true) {
                log_msg(app.handle(), &format!("set_content_protected(true) failed: {}", e));
            }

            let _ = window.maximize();
            let _ = window.show();

            let handle = app.handle().clone();
            let handle2 = app.handle().clone();
            let handle3 = app.handle().clone();
            std::thread::spawn(move || {
                watcher(handle2);
            });
            std::thread::spawn(move || {
                supervisor(handle);
            });
            std::thread::spawn(move || {
                updater(handle3, update_consent);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_update_consent])
        .run(tauri::generate_context!())
.expect("error while running whispernet");
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    /// A key pair made for one test, and a signature over `DIGEST` with its private half.
    ///
    /// Generated here rather than read from disk, so no test can be satisfied by pointing itself at the
    /// project's real signing key, and nothing produced here is a signature that means anything outside the
    /// test.
    ///
    /// The public half is taken from the tail of the PKCS#8 encoding, which for Ed25519 ends with the 32 raw
    /// public bytes - `Ed25519KeyPair` exposes no accessor for them, and deriving the key from the seed by
    /// hand in a test would be a second implementation of exactly the arithmetic under test.
    fn key_pair_and_signature() -> (String, String) {
let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .expect("the system can generate an Ed25519 key");
        let der = pkcs8.as_ref();
        let public = hex::encode(&der[der.len() - 32..]);
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8.as_ref())
            .expect("a freshly generated key is well formed");
        let signature = pair.sign(&hex::decode(DIGEST).unwrap());
        (public, hex::encode(signature.as_ref()))
    }

    /// A second, unrelated key pair, for the "signed by somebody else" case.
    fn foreign_signature() -> String {
let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8.as_ref()).unwrap();
        hex::encode(pair.sign(&hex::decode(DIGEST).unwrap()).as_ref())
    }

    #[test]
    fn accepts_a_real_signature() {
        // The direction that matters most, and the one rejection-only tests cannot cover: a verifier that
        // refused everything would pass every other test in this file and leave the app permanently unable to
        // update. That failure looks exactly like an attack succeeding, and is discovered by users.
        let (public, signature) = key_pair_and_signature();
        assert!(check_signature_with(&public, DIGEST, &signature).is_ok());
    }

    #[test]
    fn refuses_a_signature_from_another_key() {
        let (public, _) = key_pair_and_signature();
        assert!(check_signature_with(&public, DIGEST, &foreign_signature()).is_err());
    }

    #[test]
    fn refuses_a_signature_over_a_different_digest() {
let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let der = pkcs8.as_ref();
        let public = hex::encode(&der[der.len() - 32..]);
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8.as_ref()).unwrap();
        // Signed correctly, by the right key, over something else entirely.
        let other = hex::encode(pair.sign(&Sha256::digest(b"a different download")).as_ref());
        assert!(check_signature_with(&public, DIGEST, &other).is_err());
    }

    #[test]
    fn reads_a_signature_a_release_tool_wrapped_across_lines() {
        // A `.sig` that arrives with newlines in it must still be accepted, or every honest release is refused
        // for a formatting difference that looks identical to tampering.
        let (public, signature) = key_pair_and_signature();
        let wrapped = format!("{}\n{}\n", &signature[..64], &signature[64..]);
        assert!(check_signature_with(&public, DIGEST, &wrapped).is_ok());
    }

    #[test]
    fn refuses_a_signature_of_the_wrong_length() {
        let (_, signature) = key_pair_and_signature();
        assert!(check_signature(DIGEST, "").is_err());
        assert!(check_signature(DIGEST, &signature[..126]).is_err());
        assert!(check_signature(DIGEST, &format!("{}00", signature)).is_err());
    }

    #[test]
    fn refuses_a_signature_that_is_not_hex() {
        assert!(check_signature(DIGEST, &"zz".repeat(64)).is_err());
    }

    #[test]
    fn refuses_a_digest_of_the_wrong_size() {
        let (_, signature) = key_pair_and_signature();
        assert!(check_signature("abcd", &signature).is_err());
        assert!(check_signature(&"ab".repeat(33), &signature).is_err());
    }

    #[test]
    fn refuses_a_well_formed_signature_that_is_not_from_the_built_in_key() {
        // The case the whole feature exists for. Before it, the only check was a digest fetched from the same
        // place as the payload and editable by whoever can edit a release - so 64 zero bytes of a plausible
        // length was enough to get an update installed.
        assert!(check_signature(DIGEST, &"00".repeat(64)).is_err());
    }

#[test]
    fn accepts_a_signature_made_by_the_projects_own_signer() {
        // The end-to-end one: a digest and signature produced by `scripts/sign-update.mjs` with this
        // project's actual signing key, checked by the verifier that ships in the binary.
        //
        // Every other test in this file signs with a key it invented, which proves the verifier works and
        // proves nothing about the two halves agreeing. This one is the only thing that catches the signer
        // and the verifier drifting - a different PKCS#8 prefix in one and the other, hex on one side and
        // base64 on the other, the digest signed instead of the archive - and that failure mode is silent:
        // every release would be refused, and it would read to a user exactly like an attack succeeding.
        let digest = "636c0047a424b34d6f8a4d4a3190e5887ab57aca4441d2a9d89f73fc6c25cf0e";
        let signature = "22dcd821bc9eb1ba2d5e96c4a898002e0067718bb0484c8514bc1a179ecacdcc2\
                         c15052b0c41176532254f5a35af6112a9175a69ff8f8e5bf30fc2be7500240a";
        assert!(
            check_signature(digest, signature).is_ok(),
            "the project's own signer produced something this verifier will not accept; every update would \
             be refused"
        );
    }

    #[test]
    fn the_built_in_public_key_is_a_real_one() {
        // A truncated or mistyped constant would make every update permanently uninstallable, and the only
        // symptom would be an error nobody holding a release could explain.
        let key = hex::decode(UPDATE_PUBLIC_KEY).expect("the built-in key is not hex");
        assert_eq!(key.len(), 32, "an Ed25519 public key is 32 bytes");
        assert_eq!(UPDATE_PUBLIC_KEY.len(), 64);
        assert!(UPDATE_PUBLIC_KEY.chars().all(|c| c.is_ascii_hexdigit()));
    }
}

