const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 37645;
const EXTENSION_ID = "mfhiohlcbedfhemkommfailjjfkdfobe";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const DEFAULT_CONFIG = {
  enabled: true,
  selectedOnly: false,
  discordAppId: "",
  bridgeToken: "",
  selectedPlaylistIds: [],
  playlists: [],
  startup: false,
  setupComplete: false,
  selectedBrowserId: "",
  selectedBrowserPath: "",
  extensionInstalled: false
};

let mainWindow;
let tray;
let server;
let discord;
let discordReady = false;
let discordConnected = false;
let discordReceiveBuffer = Buffer.alloc(0);
let discordError = "";
let extensionSeenAt = 0;
let config = { ...DEFAULT_CONFIG };
let track = emptyTrack();
let lastPresenceKey = null;
const wsClients = new Set();

function emptyTrack() {
  return {
    title: "",
    artist: "",
    videoId: "",
    playlistId: "",
    url: "",
    thumbnail: "",
    duration: 0,
    currentTime: 0,
    playing: false,
    source: ""
  };
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch (_) {
    config = { ...DEFAULT_CONFIG };
  }
  if (!config.bridgeToken) config.bridgeToken = crypto.randomBytes(24).toString("hex");
  if (!Array.isArray(config.playlists)) config.playlists = [];
  if (!Array.isArray(config.selectedPlaylistIds)) config.selectedPlaylistIds = [];
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(config.startup), args: ["--tray"] });
  } catch (_) {
    // Portable yapılarda başlangıç kaydı desteklenmeyebilir.
  }
}

function browserCandidates() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.PROGRAMFILES || "";
  const pfx86 = process.env["PROGRAMFILES(X86)"] || "";
  const roaming = process.env.APPDATA || "";

  return [
    {
      id: "brave",
      name: "Brave",
      accent: "#fb542b",
      extensionsUrl: "brave://extensions/",
      paths: [
        path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(pfx86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
      ]
    },
    {
      id: "chrome",
      name: "Google Chrome",
      accent: "#4285f4",
      extensionsUrl: "chrome://extensions/",
      paths: [
        path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pfx86, "Google", "Chrome", "Application", "chrome.exe")
      ]
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      accent: "#0aa7b5",
      extensionsUrl: "edge://extensions/",
      paths: [
        path.join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(local, "Microsoft", "Edge", "Application", "msedge.exe")
      ]
    },
    {
      id: "vivaldi",
      name: "Vivaldi",
      accent: "#ef3939",
      extensionsUrl: "vivaldi://extensions/",
      paths: [
        path.join(local, "Vivaldi", "Application", "vivaldi.exe"),
        path.join(pf, "Vivaldi", "Application", "vivaldi.exe"),
        path.join(pfx86, "Vivaldi", "Application", "vivaldi.exe")
      ]
    },
    {
      id: "opera-gx",
      name: "Opera GX",
      accent: "#ff1b6b",
      extensionsUrl: "opera://extensions/",
      paths: [
        path.join(local, "Programs", "Opera GX", "opera.exe"),
        path.join(local, "Programs", "Opera GX", "launcher.exe"),
        path.join(roaming, "Opera Software", "Opera GX Stable", "opera.exe")
      ]
    },
    {
      id: "opera",
      name: "Opera",
      accent: "#ff1b2d",
      extensionsUrl: "opera://extensions/",
      paths: [
        path.join(local, "Programs", "Opera", "opera.exe"),
        path.join(local, "Programs", "Opera", "launcher.exe")
      ]
    },
    {
      id: "chromium",
      name: "Chromium",
      accent: "#62a8e5",
      extensionsUrl: "chrome://extensions/",
      paths: [
        path.join(local, "Chromium", "Application", "chrome.exe"),
        path.join(local, "Chromium", "Application", "chromium.exe"),
        path.join(pf, "Chromium", "Application", "chrome.exe")
      ]
    }
  ];
}

function detectBrowsers() {
  const found = [];
  const seen = new Set();
  for (const browser of browserCandidates()) {
    const executable = browser.paths.find(candidate => candidate && fs.existsSync(candidate));
    if (!executable) continue;
    const key = executable.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      id: browser.id,
      name: browser.name,
      path: executable,
      accent: browser.accent,
      extensionsUrl: browser.extensionsUrl
    });
  }
  return found;
}

function extensionSourcePath() {
  const packaged = path.join(process.resourcesPath, "extension");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), "extension");
}

function installedExtensionPath() {
  const roaming = process.env.APPDATA || app.getPath("appData");
  return path.join(roaming, "TuneCord", "extension");
}

function copyExtensionFiles() {
  const source = extensionSourcePath();
  const target = installedExtensionPath();
  if (!fs.existsSync(source)) throw new Error("Paket içindeki TuneCord eklentisi bulunamadı.");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function spawnBrowser(browser, url) {
  if (!browser?.path || !fs.existsSync(browser.path)) throw new Error("Seçilen tarayıcı artık bulunamıyor.");
  const args = url ? ["--new-window", url] : [];
  const child = spawn(browser.path, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
}

function prepareBrowserExtension(browserId) {
  const browser = detectBrowsers().find(item => item.id === browserId);
  if (!browser) throw new Error("Seçtiğin Chromium tarayıcı bulunamadı. Yeniden tara.");

  const extensionPath = copyExtensionFiles();
  config.selectedBrowserId = browser.id;
  config.selectedBrowserPath = browser.path;
  config.extensionInstalled = true; // Dosyalar hazır; tarayıcıdaki son Load unpacked adımı kullanıcı onayı ister.
  config.setupComplete = true;
  saveConfig();

  try {
    spawnBrowser(browser, browser.extensionsUrl);
  } catch (_) {
    // İç sayfa açılamasa bile klasör hazırdır ve sihirbaz yolu gösterir.
  }

  return {
    browser,
    extensionPath,
    manual: true,
    extensionsUrl: browser.extensionsUrl
  };
}

function selectedBrowserInfo() {
  const detected = detectBrowsers();
  return detected.find(item => item.id === config.selectedBrowserId) ||
    (config.selectedBrowserPath ? {
      id: config.selectedBrowserId,
      name: config.selectedBrowserId || "Chromium",
      path: config.selectedBrowserPath,
      accent: "#d94683",
      extensionsUrl: "chrome://extensions/"
    } : null);
}

function status() {
  return {
    enabled: config.enabled,
    selectedOnly: config.selectedOnly,
    discordAppId: config.discordAppId,
    playlists: config.playlists,
    selectedPlaylistIds: config.selectedPlaylistIds,
    startup: config.startup,
    setupComplete: config.setupComplete,
    selectedBrowserId: config.selectedBrowserId,
    selectedBrowser: selectedBrowserInfo(),
    extensionInstalled: Boolean(config.extensionInstalled && fs.existsSync(installedExtensionPath())),
    extensionPath: installedExtensionPath(),
    extensionConnected: Date.now() - extensionSeenAt < 35000,
    discordConnected,
    discordError,
    transport: "websocket",
    track
  };
}

function wsFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function wsSend(client, value) {
  if (!client || client.socket.destroyed) return;
  try {
    client.socket.write(wsFrame(JSON.stringify(value)));
  } catch (_) {
    client.socket.destroy();
  }
}

function wsBroadcastState() {
  const snapshot = status();
  for (const client of wsClients) {
    if (client.authenticated) wsSend(client, { type: "state", state: snapshot });
  }
}

function sendStatus() {
  const snapshot = status();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("state", snapshot);
  for (const client of wsClients) {
    if (client.authenticated) wsSend(client, { type: "state", state: snapshot });
  }
}

function wsReply(client, id, ok, value = {}) {
  wsSend(client, { id, ok, ...value });
}

function applyControl(body = {}) {
  const oldAppId = config.discordAppId;
  if (typeof body.enabled === "boolean") config.enabled = body.enabled;
  if (typeof body.selectedOnly === "boolean") config.selectedOnly = body.selectedOnly;
  if (typeof body.startup === "boolean") config.startup = body.startup;
  if (typeof body.discordAppId === "string") config.discordAppId = body.discordAppId.replace(/\s/g, "");
  if (Array.isArray(body.selectedPlaylistIds)) {
    config.selectedPlaylistIds = body.selectedPlaylistIds.map(String);
  }
  saveConfig();
  if (oldAppId !== config.discordAppId) {
    closeDiscord();
    discordError = "";
  }
  lastPresenceKey = null;
  processPresence();
  sendStatus();
  return status();
}

function applyPlaylists(items) {
  config.playlists = (Array.isArray(items) ? items : [])
    .map(item => ({ id: String(item.id || ""), title: String(item.title || item.id || "") }))
    .filter(item => item.id);
  config.selectedPlaylistIds = config.selectedPlaylistIds.filter(id => config.playlists.some(item => item.id === id));
  saveConfig();
  sendStatus();
  return status();
}

function handleWsMessage(client, message) {
  const id = message?.id;
  const type = message?.type;

  if (type === "hello") {
    if (message.extensionId !== EXTENSION_ID) {
      wsReply(client, id, false, { code: "BAD_EXTENSION", error: "Bu WebSocket yalnızca TuneCord eklentisine açıktır." });
      client.socket.end(wsFrame("", 8));
      return;
    }
    if (message.token !== config.bridgeToken) {
      wsReply(client, id, false, { code: "PAIR_REQUIRED", token: config.bridgeToken });
      return;
    }
    client.authenticated = true;
    extensionSeenAt = Date.now();
    wsReply(client, id, true, { state: status() });
    sendStatus();
    return;
  }

  if (!client.authenticated) {
    wsReply(client, id, false, { code: "NOT_AUTHENTICATED", error: "Önce eşleşme gerekli." });
    return;
  }

  extensionSeenAt = Date.now();
  try {
    switch (type) {
      case "getStatus":
        wsReply(client, id, true, { state: status() });
        break;
      case "track":
        track = {
          ...emptyTrack(),
          ...(message.track || {}),
          playing: Boolean(message.track?.playing),
          duration: Number(message.track?.duration) || 0,
          currentTime: Number(message.track?.currentTime) || 0
        };
        lastPresenceKey = null;
        processPresence();
        sendStatus();
        wsReply(client, id, true, { state: status() });
        break;
      case "stop":
        track = emptyTrack();
        lastPresenceKey = null;
        processPresence();
        sendStatus();
        wsReply(client, id, true, { state: status() });
        break;
      case "setControl":
        wsReply(client, id, true, { state: applyControl(message.control || {}) });
        break;
      case "playlists":
        wsReply(client, id, true, { state: applyPlaylists(message.items) });
        break;
      case "ping":
        wsReply(client, id, true, { pong: Date.now() });
        break;
      default:
        wsReply(client, id, false, { error: "Bilinmeyen WebSocket isteği." });
    }
  } catch (error) {
    wsReply(client, id, false, { error: error.message || "WebSocket isteği başarısız." });
  }
}

function consumeWsData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const bigLength = client.buffer.readBigUInt64BE(2);
      if (bigLength > BigInt(4 * 1024 * 1024)) {
        client.socket.destroy();
        return;
      }
      length = Number(bigLength);
      offset = 10;
    }

    if (!masked || length > 4 * 1024 * 1024) {
      client.socket.destroy();
      return;
    }
    if (client.buffer.length < offset + 4 + length) return;

    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

    if (opcode === 8) {
      client.socket.end(wsFrame("", 8));
      return;
    }
    if (opcode === 9) {
      client.socket.write(wsFrame(payload, 10));
      continue;
    }
    if (opcode === 10) continue;

    if (opcode === 1) {
      client.fragments = [payload];
      client.fragmentOpcode = 1;
    } else if (opcode === 0 && client.fragmentOpcode === 1) {
      client.fragments.push(payload);
    } else {
      client.socket.destroy();
      return;
    }

    if (!fin) continue;
    const text = Buffer.concat(client.fragments).toString("utf8");
    client.fragments = [];
    client.fragmentOpcode = 0;
    try {
      handleWsMessage(client, JSON.parse(text));
    } catch (_) {
      wsReply(client, null, false, { error: "Geçersiz WebSocket JSON mesajı." });
    }
  }
}

function startBridge() {
  server = http.createServer((request, response) => {
    response.writeHead(426, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "TuneCord bridge WebSocket kullanır." }));
  });

  server.on("upgrade", (request, socket) => {
    let pathname = "";
    try {
      pathname = new URL(request.url, `http://127.0.0.1:${PORT}`).pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    const upgrade = String(request.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));

    const client = {
      socket,
      authenticated: false,
      buffer: Buffer.alloc(0),
      fragments: [],
      fragmentOpcode: 0
    };
    wsClients.add(client);
    socket.on("data", chunk => consumeWsData(client, chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      wsClients.delete(client);
      sendStatus();
    });
  });

  server.listen(PORT, "127.0.0.1");
  server.on("error", error => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge-error", error.message);
    }
  });
}

function mayShowTrack() {
  if (!config.enabled || !track.playing || !track.title) return false;
  return !config.selectedOnly || config.selectedPlaylistIds.includes(track.playlistId);
}

function closeDiscord() {
  const socket = discord;
  discord = undefined;
  discordReady = false;
  discordConnected = false;
  discordReceiveBuffer = Buffer.alloc(0);
  lastPresenceKey = null;
  if (socket && !socket.destroyed) socket.destroy();
}

function discordFrame(op, body) {
  const payload = Buffer.from(JSON.stringify(body ?? {}));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function discordErrorText(payload, fallback = "Discord RPC hatası.") {
  const code = payload?.data?.code ?? payload?.code;
  const message = payload?.data?.message || payload?.message || fallback;
  return code ? `${message} (${code})` : message;
}

function handleDiscordFrame(socket, op, payload) {
  if (discord !== socket) return;
  if (op === 3) {
    if (!socket.destroyed) socket.write(discordFrame(4, payload));
    return;
  }
  if (op === 2) {
    discordError = discordErrorText(payload, "Discord IPC bağlantıyı kapattı.");
    socket.destroy();
    return;
  }
  if (op !== 1) return;
  if (payload?.evt === "READY") {
    discordReady = true;
    discordConnected = true;
    discordError = "";
    lastPresenceKey = null;
    sendStatus();
    processPresence();
    return;
  }
  if (payload?.evt === "ERROR") {
    discordError = discordErrorText(payload);
    sendStatus();
    if (!discordReady) socket.destroy();
  }
}

function consumeDiscordData(socket, chunk) {
  if (discord !== socket) return;
  discordReceiveBuffer = Buffer.concat([discordReceiveBuffer, chunk]);
  while (discordReceiveBuffer.length >= 8) {
    const op = discordReceiveBuffer.readInt32LE(0);
    const length = discordReceiveBuffer.readInt32LE(4);
    if (length < 0 || length > 4 * 1024 * 1024) {
      discordError = "Discord IPC geçersiz bir frame gönderdi.";
      sendStatus();
      socket.destroy();
      return;
    }
    if (discordReceiveBuffer.length < 8 + length) return;
    const payloadBytes = discordReceiveBuffer.subarray(8, 8 + length);
    discordReceiveBuffer = discordReceiveBuffer.subarray(8 + length);
    let payload = {};
    try {
      payload = payloadBytes.length ? JSON.parse(payloadBytes.toString("utf8")) : {};
    } catch (_) {
      discordError = "Discord IPC yanıtı okunamadı.";
      sendStatus();
      socket.destroy();
      return;
    }
    handleDiscordFrame(socket, op, payload);
    if (discord !== socket || socket.destroyed) return;
  }
}

function connectDiscord() {
  if (!config.discordAppId || discord) return;
  let index = 0;
  const tryNext = () => {
    if (discord) return;
    if (index >= 10) {
      discordReady = false;
      discordConnected = false;
      if (!discordError) discordError = "Discord masaüstü IPC bağlantısı bulunamadı.";
      sendStatus();
      return;
    }

    const socket = net.createConnection(`\\\\?\\pipe\\discord-ipc-${index++}`);
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      discord = socket;
      discordReady = false;
      discordConnected = false;
      discordReceiveBuffer = Buffer.alloc(0);
      discordError = "";
      lastPresenceKey = null;
      socket.on("data", chunk => consumeDiscordData(socket, chunk));
      socket.on("close", () => {
        if (discord === socket) {
          discord = undefined;
          discordReady = false;
          discordConnected = false;
          discordReceiveBuffer = Buffer.alloc(0);
          lastPresenceKey = null;
          sendStatus();
        }
      });
      socket.write(discordFrame(0, { v: 1, client_id: config.discordAppId }));
      setTimeout(() => {
        if (discord === socket && !discordReady && !socket.destroyed) {
          discordError = discordError || "Discord READY yanıtı gelmedi.";
          sendStatus();
          socket.destroy();
        }
      }, 5000);
    });
    socket.on("error", error => {
      if (!connected) {
        socket.destroy();
        tryNext();
        return;
      }
      if (discord === socket) {
        discordError = error?.message || "Discord IPC bağlantı hatası.";
        sendStatus();
      }
    });
  };
  tryNext();
}

function sendDiscordActivity(activity) {
  if (!discord || discord.destroyed || !discordReady) return;
  discord.write(discordFrame(1, {
    cmd: "SET_ACTIVITY",
    nonce: crypto.randomUUID(),
    args: { pid: process.pid, activity }
  }));
}

function processPresence() {
  const shouldShow = mayShowTrack();
  const key = shouldShow
    ? `${config.discordAppId}\n${track.videoId}\n${track.title}\n${track.artist}\n${track.playlistId}`
    : "";

  if (!config.discordAppId) {
    discordError = "";
    closeDiscord();
    return;
  }
  connectDiscord();
  if (!discord || !discordReady || key === lastPresenceKey) return;
  lastPresenceKey = key;

  if (!shouldShow) {
    sendDiscordActivity(null);
    return;
  }

  sendDiscordActivity({
    type: 2,
    details: track.title.slice(0, 128),
    state: track.artist.slice(0, 128),
    timestamps: track.duration > 0 ? {
      start: Math.floor(Date.now() / 1000 - track.currentTime),
      end: Math.floor(Date.now() / 1000 - track.currentTime + track.duration)
    } : undefined,
    buttons: track.url ? [{ label: "YouTube'da Aç", url: track.url }] : undefined
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="10" fill="#d62976"/><path d="M11 9h11v4h-3.5v9.2a4.3 4.3 0 1 1-3-4.1V13H11z" fill="white"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(traySvg).toString("base64")}`));
  tray.setToolTip("TuneCord");

  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "TuneCord'u aç", click: showWindow },
    {
      label: "Discord'da göster",
      type: "checkbox",
      checked: config.enabled,
      click: item => applyControl({ enabled: item.checked })
    },
    { type: "separator" },
    { label: "Çıkış", click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  refresh();
  tray.on("click", showWindow);
  setInterval(refresh, 1500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b090b",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b090b", symbolColor: "#f7f3f6", height: 34 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("close", event => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on("did-finish-load", sendStatus);
}

ipcMain.handle("state", () => status());
ipcMain.handle("scan-browsers", () => detectBrowsers());
ipcMain.handle("install-extension", (_, browserId) => {
  const result = prepareBrowserExtension(String(browserId || ""));
  sendStatus();
  return { ...result, state: status() };
});
ipcMain.handle("launch-browser", () => {
  const browser = selectedBrowserInfo();
  if (!browser) throw new Error("Önce bir Chromium tarayıcı seç.");
  spawnBrowser(browser, "https://www.youtube.com/");
  return { ok: true };
});
ipcMain.handle("skip-setup", () => {
  config.setupComplete = true;
  config.extensionInstalled = false;
  saveConfig();
  sendStatus();
  return status();
});
ipcMain.handle("reset-setup", () => {
  config.setupComplete = false;
  saveConfig();
  sendStatus();
  return status();
});
ipcMain.handle("save", (_, next) => applyControl(next || {}));
ipcMain.handle("reset-pairing", () => {
  config.bridgeToken = crypto.randomBytes(24).toString("hex");
  saveConfig();
  for (const client of wsClients) {
    wsSend(client, { type: "pair-reset" });
    client.socket.end(wsFrame("", 8));
  }
  return { token: config.bridgeToken };
});
ipcMain.handle("window", (_, action) => {
  if (action === "minimize") mainWindow.minimize();
  if (action === "close") mainWindow.hide();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", showWindow);
app.whenReady().then(() => {
  loadConfig();
  createWindow();
  createTray();
  startBridge();
  saveConfig();
  setInterval(() => {
    processPresence();
    sendStatus();
  }, 5000);
  if (!process.argv.includes("--tray") || !config.setupComplete) showWindow();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  for (const client of wsClients) client.socket.destroy();
  wsClients.clear();
  if (server) server.close();
  closeDiscord();
});
