use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use tauri::{Manager, Url};

const DEFAULT_REMOTE_URL: &str = "https://rightfully-nice-ram.cloudpub.ru";
const DEFAULT_UPDATE_URL: &str = "https://api.github.com/repos/PupSenYaSha/whispernet";
const HEALTH_INTERVAL_SECS: u64 = 15;
const RETRY_INTERVAL_SECS: u64 = 10;
const HEALTH_TIMEOUT_SECS: u64 = 5;

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

const STATUS_TITLE_PATTERNS: [&str; 4] = ["502", "503", "504", "Bad Gateway"];

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

fn remote_url() -> String {
    std::env::var("WHISPERNET_URL").unwrap_or_else(|_| DEFAULT_REMOTE_URL.to_string())
}

fn update_url() -> String {
    std::env::var("UPDATE_URL").unwrap_or_else(|_| DEFAULT_UPDATE_URL.to_string())
}

fn now_iso() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("{:?}", d))
        .unwrap_or_else(|_| "?".to_string())
}

fn log_msg(app: &tauri::AppHandle, msg: &str) {
    let Some(dir) = app.path().app_local_data_dir().ok() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("update.log"))
    {
        let _ = writeln!(f, "[{}] {}", now_iso(), msg);
    }
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

fn remote_ok() -> bool {
    let target = format!("{}/health", remote_url());
    match ureq::get(&target)
        .timeout(Duration::from_secs(HEALTH_TIMEOUT_SECS))
        .call()
    {
        Ok(res) => res.status() == 200,
        Err(ureq::Error::Status(code, _)) => code < 500,
        Err(_) => false,
    }
}

fn error_url() -> Url {
    let encoded = utf8_percent_encode(ERROR_HTML, NON_ALPHANUMERIC).to_string();
    Url::parse(&format!("data:text/html;charset=utf-8,{}", encoded)).expect("valid data URL")
}

fn show_app(app: &tauri::AppHandle) {
    let url = Url::parse(&remote_url()).expect("valid remote url");
    let receiver = app.clone();
    let fwd = app.clone();
    let _ = receiver.run_on_main_thread(move || {
        if let Some(win) = fwd.get_webview_window("main") {
            let _ = win.navigate(url);
        }
    });
}

fn show_error(app: &tauri::AppHandle) {
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

    loop {
        std::thread::sleep(Duration::from_secs(HEALTH_INTERVAL_SECS));
        let ok = remote_ok();
        let state = app.state::<Arc<HealthState>>();
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
  try { prot = !!localStorage.getItem('wn_screenshot_prot'); } catch(e) {}
  return JSON.stringify({ title: document.title, prot: prot });
})()"##;

fn watcher(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<String>();
    let mut last_prot: Option<bool> = None;
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
            let mut title = serde_json::from_str::<String>(&raw)
                .unwrap_or_else(|_| raw.clone());
            let mut prot = false;
            if let Ok(inner) = serde_json::from_str::<String>(&raw) {
                if let Ok(payload) = serde_json::from_str::<PagePayload>(&inner) {
                    if !payload.title.is_empty() {
                        title = payload.title;
                    }
                    prot = payload.prot;
                }
            }
            if !title.is_empty() {
                if STATUS_TITLE_PATTERNS
                    .iter()
                    .any(|p| title.contains(p))
                {
                    show_error(&app);
                }
                let app3 = app.clone();
                let title3 = title.clone();
                let receiver3 = app3.clone();
                let _ = receiver3.run_on_main_thread(move || {
                    if let Some(w) = app3.get_webview_window("main") {
                        let _ = w.set_title(&title3);
                    }
                });
            }
            if last_prot != Some(prot) {
                last_prot = Some(prot);
                let app4 = app.clone();
                let receiver4 = app4.clone();
                let _ = receiver4.run_on_main_thread(move || {
                    if let Some(w) = app4.get_webview_window("main") {
                        let _ = w.set_content_protected(prot);
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
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read stream: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("write file: {}", e))?;
        done += n as u64;
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

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    io::copy(&mut &file, &mut hasher).map_err(|e| format!("hash: {}", e))?;
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

fn verify_update(app: &tauri::AppHandle, release: &Release, zip_path: &Path) -> Result<(), String> {
    let digest_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".sha256"));
    match digest_asset {
        Some(asset) => {
            let text = fetch_text(&asset.browser_download_url)?;
            let captured = regex_capture_hex(&text);
            let expected = captured.unwrap_or_default().to_lowercase();
            if expected.is_empty() {
                log_msg(app, "digest asset unparseable; skipping verification");
                return Ok(());
            }
            let actual = sha256_file(zip_path)?;
            if expected != actual {
                return Err("update integrity check failed (SHA-256 mismatch)".into());
            }
            log_msg(app, &format!("SHA-256 verified: {}", &actual[..12]));
            Ok(())
        }
        None => {
            log_msg(app, "no .sha256 digest asset; skipping verification");
            Ok(())
        }
    }
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

fn extract_update(app: &tauri::AppHandle, zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let _ = app;
    let file = File::open(zip_path).map_err(|e| format!("open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {}", e))?;
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "whispernet.exe".to_string());
    for i in 0..archive.len() {
        let mut zf = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {}: {}", i, e))?;
        let name = zf.name().to_string();
        let unsafe_name = name.contains('\\')
            || name.starts_with('/')
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
        let file_name = if name.ends_with(".exe") {
            exe_name.clone()
        } else {
            name.split('/').last().unwrap_or(&name).to_string()
        };
        if file_name.is_empty() {
            continue;
        }
        let dest = dest_dir.join(&file_name);
        if name.ends_with('/') {
            fs::create_dir_all(&dest).map_err(|e| format!("mkdir: {}", e))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
        let mut out = File::create(&dest).map_err(|e| format!("create {}: {}", e, dest.display()))?;
        io::copy(&mut zf, &mut out).map_err(|e| format!("extract {}: {}", file_name, e))?;
    }
    Ok(())
}

fn apply_and_restart(app: &tauri::AppHandle, update_dir: &Path) {
    let Ok(current) = std::env::current_exe() else {
        log_msg(app, "apply: cannot resolve current exe");
        return;
    };
    let Some(_) = current.parent() else {
        log_msg(app, "apply: cannot resolve app dir");
        return;
    };
    let Some(exe_name) = current.file_name() else {
        log_msg(app, "apply: cannot resolve exe name");
        return;
    };
    let exe_name = exe_name.to_string_lossy().into_owned();
    let payload = update_dir.join(&exe_name);
    if !payload.exists() {
        log_msg(app, "apply: payload not found; skipping");
        return;
    }
    let bat_path = std::env::temp_dir().join("whispernet_update.bat");
    let pid = std::process::id();
    let bat = format!(
        "@echo off\r\ntimeout /t 2 /nobreak > nul\r\ntaskkill /pid {} /f > nul 2>&1\r\ncopy /y \"{}\" \"{}\" > nul\r\nstart \"\" \"{}\"\r\ndel \"%~f0\"\r\n",
        pid,
        payload.display(),
        current.display(),
        current.display()
    );
    if fs::write(&bat_path, bat).is_err() {
        log_msg(app, "apply: cannot write update bat");
        return;
    }
    log_msg(app, "apply: scheduling swap and restart");
    let _ = Command::new("cmd.exe")
        .args(["/c", &bat_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    app.exit(0);
}

fn updater(app: tauri::AppHandle) {
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
    if let Err(e) = verify_update(&app, &release, &zip_path) {
        log_msg(&app, &format!("Error: {}", e));
        push_update(&app, format!("{{\"kind\":\"error\",\"message\":\"{}\"}}", e));
        return;
    }
    push_update(
        &app,
        "{\"kind\":\"progress\",\"status\":\"extracting\",\"percent\":100}".into(),
    );
    let extract_dir = base_dir.join("new");
    if let Err(e) = extract_update(&app, &zip_path, &extract_dir) {
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
    apply_and_restart(&app, &extract_dir);
    log_msg(&app, "Update applied; restarting");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let health_state = Arc::new(HealthState {
        error_shown: AtomicBool::new(false),
    });

    tauri::Builder::default()
        .manage(health_state)
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .expect("main window must exist");

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
                updater(handle3);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running whispernet");
}