const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = 37645;
const VERSION = app.getVersion();
const NATIVE_HOST = "com.tunecord.bridge";
const CHROMIUM_EXTENSION_ID = "mfhiohlcbedfhemkommfailjjfkdfobe";
const FIREFOX_EXTENSION_ID = "tunecord@etlibiftek.local";
let mainWindow = null;
let pollTimer = null;
let helperReady = false;

function backend(method, route, payload, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      path: route,
      method,
      timeout,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => raw += chunk);
      response.on("end", () => {
        let value = {};
        try { value = raw ? JSON.parse(raw) : {}; } catch (_) {}
        if (response.statusCode >= 400) reject(new Error(value.error || `TuneCord backend HTTP ${response.statusCode}`));
        else resolve(value);
      });
    });
    request.on("timeout", () => request.destroy(new Error("TuneCord native backend zaman aşımına uğradı.")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function packagedResource(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, name);
  return path.join(app.getAppPath(), name);
}

function tuneCordDataDir() {
  return path.join(process.env.APPDATA || process.env.LOCALAPPDATA || app.getPath("appData"), "TuneCord");
}

function localBinDir() {
  return path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "TuneCord", "bin");
}

async function currentBackend() {
  try { return await backend("GET", "/api/state", undefined, 500); } catch (_) { return null; }
}

async function waitForBackend(ms = 7000, child = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const state = await currentBackend();
    if (state?.backend === "native") return state;
    if (child && child.exitCode !== null) {
      throw new Error(`TuneCord native arka plan servisi erken kapandı (kod ${child.exitCode}).`);
    }
    await sleep(80);
  }
  throw new Error("TuneCord native arka plan servisi başlatılamadı.");
}

function replaceHelperBinary(source, target) {
  const temp = `${target}.new`;
  try { fs.rmSync(temp, { force: true }); } catch (_) {}
  fs.copyFileSync(source, temp);
  try { fs.rmSync(target, { force: true }); } catch (_) {}
  fs.renameSync(temp, target);
}

function addRegistryNativeHost(key, manifestPath) {
  const result = spawnSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
    windowsHide: true,
    encoding: "utf8"
  });
  return !result.error && result.status === 0;
}

function registerNativeMessaging(nativeHostPath) {
  const dir = path.join(tuneCordDataDir(), "native-messaging");
  fs.mkdirSync(dir, { recursive: true });

  const chromiumManifestPath = path.join(dir, `${NATIVE_HOST}.chromium.json`);
  const firefoxManifestPath = path.join(dir, `${NATIVE_HOST}.firefox.json`);
  fs.writeFileSync(chromiumManifestPath, JSON.stringify({
    name: NATIVE_HOST,
    description: "TuneCord browser bridge",
    path: nativeHostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]
  }, null, 2));
  fs.writeFileSync(firefoxManifestPath, JSON.stringify({
    name: NATIVE_HOST,
    description: "TuneCord browser bridge",
    path: nativeHostPath,
    type: "stdio",
    allowed_extensions: [FIREFOX_EXTENSION_ID]
  }, null, 2));

  const chromiumKeys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST}`,
    `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${NATIVE_HOST}`,
    `HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts\\${NATIVE_HOST}`
  ];
  for (const key of chromiumKeys) addRegistryNativeHost(key, chromiumManifestPath);
  addRegistryNativeHost(`HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST}`, firefoxManifestPath);
}

async function ensureHelper() {
  fs.mkdirSync(localBinDir(), { recursive: true });
  const bundledHelper = packagedResource("tunecord-helper.exe");
  const bundledNativeHost = packagedResource("tunecord-native-host.exe");
  const bundledIcon = packagedResource("tunecord-icon.ico");
  const helperPath = path.join(localBinDir(), `tunecord-helper-${VERSION}.exe`);
  const nativeHostPath = path.join(localBinDir(), `tunecord-native-host-${VERSION}.exe`);
  const iconPath = path.join(localBinDir(), "tunecord.ico");
  if (!fs.existsSync(bundledHelper)) throw new Error("TuneCord native helper pakette bulunamadı.");
  if (!fs.existsSync(bundledNativeHost)) throw new Error("TuneCord native messaging bridge pakette bulunamadı.");
  if (fs.existsSync(bundledIcon)) { try { fs.copyFileSync(bundledIcon, iconPath); } catch (_) {} }

  // Tarayıcı localhost/WebSocket kısıtlamalarından etkilenmesin diye extension
  // trafiğini Chrome/Firefox'un resmi Native Messaging API'sinden geçiriyoruz.
  replaceHelperBinary(bundledNativeHost, nativeHostPath);
  registerNativeMessaging(nativeHostPath);

  let state = await currentBackend();
  if (state?.backend === "native" && state.helperVersion !== VERSION) {
    try { await backend("POST", "/api/shutdown", {}); } catch (_) {}
    for (let i = 0; i < 50 && await currentBackend(); i++) await sleep(80);
    state = await currentBackend();
  }
  if (state && state.backend !== "native") {
    throw new Error("Eski TuneCord arka planı hâlâ çalışıyor. Eski TuneCord'u tray'den tamamen kapatıp yeni sürümü tekrar aç.");
  }

  if (!state) {
    replaceHelperBinary(bundledHelper, helperPath);
    const launcher = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const child = spawn(helperPath, ["--background", "--app-exe", launcher], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    state = await waitForBackend(7000, child);
  }

  helperReady = true;
  const launcher = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  await backend("POST", "/api/register", { appExePath: launcher });
  return state;
}

function sendState() {
  if (!helperReady || !mainWindow || mainWindow.isDestroyed()) return;
  backend("GET", "/api/state", undefined, 800)
    .then(state => mainWindow?.webContents.send("state", state))
    .catch(error => mainWindow?.webContents.send("bridge-error", error.message));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b090f",
    icon: path.join(__dirname, "assets", "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b090f", symbolColor: "#f7f3f6", height: 34 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.on("did-finish-load", sendState);
  pollTimer = setInterval(sendState, 750);
}

ipcMain.handle("state", () => backend("GET", "/api/state"));
ipcMain.handle("save", (_, value) => backend("POST", "/api/control", value || {}));
ipcMain.handle("reset-pairing", () => backend("POST", "/api/reset-pairing", {}));
ipcMain.handle("scan-browsers", () => backend("GET", "/api/scan-browsers"));
ipcMain.handle("install-extension", (_, browserId) => backend("POST", "/api/install-extension", {
  browserId: String(browserId || ""),
  resourceRoot: app.isPackaged ? process.resourcesPath : app.getAppPath()
}));
ipcMain.handle("launch-browser", () => backend("POST", "/api/launch-browser", {}));
ipcMain.handle("skip-setup", () => backend("POST", "/api/skip-setup", {}));
ipcMain.handle("reset-setup", () => backend("POST", "/api/reset-setup", {}));
ipcMain.handle("window", (_, action) => {
  if (!mainWindow) return;
  if (action === "minimize") mainWindow.minimize();
  if (action === "close") mainWindow.close();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId("com.tunecord.desktop");
    try {
      await ensureHelper();
      if (process.argv.includes("--tray")) { app.quit(); return; }
      createWindow();
    } catch (error) {
      createWindow();
      mainWindow.webContents.once("did-finish-load", () => mainWindow.webContents.send("bridge-error", error.message));
    }
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (pollTimer) clearInterval(pollTimer); });
