import { app, BrowserWindow, ipcMain, nativeTheme, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, createWriteStream } from 'fs';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

let mainWindow: BrowserWindow | null = null;
let pendingUpdateDir: string | null = null;
const REMOTE_URL = process.env.WHISPERNET_URL || 'https://rightfully-nice-ram.cloudpub.ru';
let retryTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
const ERROR_HTML = `<!DOCTYPE html>
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
    <svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 9v4m0 4h.01"/>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
  </div>
  <h1>Сервер временно недоступен</h1>
  <p>Похоже, произошла ошибка на сервере. Мы уже работаем над исправлением.</p>
  <div class="retry">Повторная попытка через <span id="sec">10</span>с</div>
  <div style="margin-top:20px">
    <span class="dot"></span><span class="dot"></span><span class="dot"></span>
  </div>
</div>
</body>
</html>`;

function logUpdater(msg: string) {
  try {
    const logFile = join(app.getPath('userData'), 'update.log');
    writeFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
  } catch {}
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers: { 'User-Agent': 'WhisperNet' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location!).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c: any) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers: { 'User-Agent': 'WhisperNet' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location!, dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = createWriteStream(dest);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total && onProgress) onProgress(Math.round((downloaded / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', reject);
  });
}

function removeDirRecursive(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    if (statSync(entryPath).isDirectory()) removeDirRecursive(entryPath);
    else unlinkSync(entryPath);
  }
  rmdirSync(dir);
}

function applyUpdateAndRestart(updateDir: string) {
  const appDir = join(process.execPath, '..');
  const batPath = join(app.getPath('temp'), 'whispernet_update.bat');
  const bat = [
    '@echo off',
    'timeout /t 2 /nobreak > nul',
    `rmdir /s /q "${appDir}\\_old" 2>nul`,
    `mkdir "${appDir}\\_old" 2>nul`,
    `xcopy /s /e /y /q "${appDir}\\*.*" "${appDir}\\_old\\" 2>nul`,
    `xcopy /s /e /y /q "${updateDir}\\*.*" "${appDir}\\" 2>nul`,
    `start "" "${join(appDir, 'WhisperNet.exe')}"`,
    `rmdir /s /q "${appDir}\\_old" 2>nul`,
    `del "%~f0"`,
  ].join('\r\n');
  writeFileSync(batPath, bat);
  execFile('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

async function checkAndUpdate(win: BrowserWindow) {
  logUpdater('Checking...');
  try {
    const baseUrl = process.env.UPDATE_URL || 'https://api.github.com/repos/PupSenYaSha/whispernet';
    const release = await fetchJson(`${baseUrl}/releases/latest`);
    const latest = release.tag_tag?.replace(/^v/, '') || release.tag_name?.replace(/^v/, '');
    const current = app.getVersion();
    logUpdater(`Latest: ${latest}, Current: ${current}`);

    if (!latest || compareVersions(latest, current) <= 0) {
      logUpdater('Up to date');
      return;
    }

    const asset = release.assets?.find((a: any) => a.name?.endsWith('.zip'));
    if (!asset) { logUpdater('No asset'); return; }

    logUpdater(`Update: ${latest}`);
    win.webContents.send('update-available', { version: latest });

    const updateDir = join(app.getPath('userData'), 'update');
    if (!existsSync(updateDir)) mkdirSync(updateDir, { recursive: true });
    const zipPath = join(updateDir, 'update.zip');

    removeDirRecursive(updateDir);
    mkdirSync(updateDir, { recursive: true });

    await downloadFile(asset.browser_download_url, zipPath, (percent) => {
      win.webContents.send('update-progress', { percent });
    });
    logUpdater('Downloaded');

    win.webContents.send('update-progress', { percent: 100, status: 'extracting' });

    const { default: AdmZip } = await import('adm-zip');
    const extractDir = join(updateDir, 'new');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    logUpdater('Extracted');

    win.webContents.send('update-ready', { version: latest, extractDir });
    pendingUpdateDir = extractDir;
  } catch (e: any) {
    logUpdater(`Error: ${e.message}`);
    win.webContents.send('update-error', { message: e.message });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 550,
    title: 'WhisperNet',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#0c0a14',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  const RETRY_INTERVAL = 10000;
  let connected = false;

  function showErrorPage() {
    connected = false;
    mainWindow?.loadURL('data:text/html,' + encodeURIComponent(ERROR_HTML));
    if (countdownTimer) clearInterval(countdownTimer);
    let sec = 10;
    countdownTimer = setInterval(() => {
      sec--;
      if (sec <= 0) sec = 10;
      mainWindow?.webContents.executeJavaScript(
        `document.getElementById('sec')&&(document.getElementById('sec').textContent='${sec}')`
      ).catch(() => {});
    }, 1000);
  }

  async function checkServer(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = https.get(REMOTE_URL + '/health', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (c: any) => data += c);
        res.on('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  let hideCssKey = '';

  function hideContent() {
    mainWindow?.webContents.insertCSS('body{opacity:0!important;transition:none!important}').then((key) => {
      hideCssKey = key;
    }).catch(() => {});
  }

  function showContent() {
    if (hideCssKey) {
      mainWindow?.webContents.removeInsertedCSS(hideCssKey).catch(() => {});
      hideCssKey = '';
    }
    mainWindow?.webContents.executeJavaScript('document.body.style.opacity=""').catch(() => {});
  }

  async function tryConnect() {
    hideContent();
    try {
      await mainWindow?.loadURL(REMOTE_URL);
    } catch {
      showErrorPage();
      if (!retryTimer) retryTimer = setInterval(tryConnect, RETRY_INTERVAL);
    }
  }

  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow?.webContents.getURL() || '';
    if (url.startsWith('data:')) return;
    mainWindow?.webContents.executeJavaScript('document.title').then((title: string) => {
      if (title.includes('502') || title.includes('504') || title.includes('Bad Gateway') || title.includes('503')) {
        showErrorPage();
        if (!retryTimer) retryTimer = setInterval(tryConnect, RETRY_INTERVAL);
      } else {
        connected = true;
        showContent();
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      }
    }).catch(() => {});
  });

  tryConnect();

  const HEALTH_CHECK_INTERVAL = 15000;
  let healthTimer: ReturnType<typeof setInterval> | null = setInterval(async () => {
    if (!connected || !mainWindow) return;
    const ok = await checkServer();
    if (!ok && connected) {
      showErrorPage();
      if (!retryTimer) retryTimer = setInterval(tryConnect, RETRY_INTERVAL);
    }
  }, HEALTH_CHECK_INTERVAL);

  mainWindow.on('closed', () => {
    if (retryTimer) clearInterval(retryTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    if (healthTimer) clearInterval(healthTimer);
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';

  createWindow();

  if (mainWindow) {
    checkAndUpdate(mainWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
});

ipcMain.handle('get-server-port', () => 50025);

ipcMain.handle('set-title', (_event, title: string) => {
  mainWindow?.setTitle(title);
});

ipcMain.handle('apply-update', () => {
  if (!pendingUpdateDir) {
    logUpdater('No pending update');
    return;
  }
  const userData = app.getPath('userData');
  const expectedDir = join(userData, 'update', 'new');
  if (!pendingUpdateDir.startsWith(expectedDir)) {
    logUpdater(`Rejected invalid path: ${pendingUpdateDir}`);
    return;
  }
  applyUpdateAndRestart(pendingUpdateDir);
});
