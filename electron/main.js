const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = 37645;
const DEFAULT_CONFIG = {
  enabled: true,
  selectedOnly: false,
  discordAppId: "",
  bridgeToken: "",
  selectedPlaylistIds: [],
  playlists: [],
  startup: false
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

function emptyTrack() {
  return { title: "", artist: "", videoId: "", playlistId: "", url: "", thumbnail: "", duration: 0, currentTime: 0, playing: false, source: "" };
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
  app.setLoginItemSettings({ openAtLogin: Boolean(config.startup), args: ["--tray"] });
}

function status() {
  return {
    enabled: config.enabled,
    selectedOnly: config.selectedOnly,
    discordAppId: config.discordAppId,
    playlists: config.playlists,
    selectedPlaylistIds: config.selectedPlaylistIds,
    startup: config.startup,
    extensionConnected: Date.now() - extensionSeenAt < 35000,
    discordConnected,
    discordError,
    track
  };
}

function sendStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("state", status());
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
  const key = shouldShow ? `${config.discordAppId}\n${track.videoId}\n${track.title}\n${track.artist}\n${track.playlistId}` : "";

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

  const activity = {
    type: 2,
    details: track.title.slice(0, 128),
    state: track.artist.slice(0, 128),
    timestamps: track.duration > 0 ? {
      start: Math.floor(Date.now() / 1000 - track.currentTime),
      end: Math.floor(Date.now() / 1000 - track.currentTime + track.duration)
    } : undefined,
    buttons: track.url ? [{ label: "YouTube'da Aç", url: track.url }] : undefined
  };

  sendDiscordActivity(activity);
}

function parseJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Geçersiz JSON")); }
    });
  });
}

function respond(response, code, body) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-TuneCord-Token" });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return request.headers["x-tunecord-token"] === config.bridgeToken;
}

async function bridgeHandler(request, response) {
  if (request.method === "OPTIONS") return respond(response, 204, {});
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (request.method === "GET" && url.pathname === "/api/pair") return respond(response, 200, { token: config.bridgeToken });
  if (!authorized(request)) return respond(response, 401, { error: "Eşleşme gerekli." });
  extensionSeenAt = Date.now();

  try {
    if (request.method === "GET" && url.pathname === "/api/status") return respond(response, 200, status());

    const body = await parseJson(request);

    if (request.method === "POST" && url.pathname === "/api/track") {
      track = { ...emptyTrack(), ...body, playing: Boolean(body.playing), duration: Number(body.duration) || 0, currentTime: Number(body.currentTime) || 0 };
      lastPresenceKey = null;
    } else if (request.method === "POST" && url.pathname === "/api/stop") {
      track = emptyTrack();
      lastPresenceKey = null;
    } else if (request.method === "POST" && url.pathname === "/api/control") {
      if (typeof body.enabled === "boolean") config.enabled = body.enabled;
      if (typeof body.selectedOnly === "boolean") config.selectedOnly = body.selectedOnly;
      saveConfig();
      lastPresenceKey = null;
    } else if (request.method === "POST" && url.pathname === "/api/playlists") {
      const items = Array.isArray(body.items) ? body.items : [];
      config.playlists = items.map(item => ({ id: String(item.id || ""), title: String(item.title || item.id || "") })).filter(item => item.id);
      config.selectedPlaylistIds = config.selectedPlaylistIds.filter(id => config.playlists.some(item => item.id === id));
      saveConfig();
    } else {
      return respond(response, 404, { error: "Bulunamadı." });
    }

    processPresence();
    sendStatus();
    respond(response, 200, status());
  } catch (error) {
    respond(response, 400, { error: error.message });
  }
}

function startBridge() {
  server = http.createServer(bridgeHandler);
  server.listen(PORT, "127.0.0.1");
  server.on("error", () => {});
}

function showWindow() {
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="9" fill="#be185d"/><path d="M10 9h12v4h-4v10.3a4.5 4.5 0 1 1-3-4.24V13h-5z" fill="white"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(traySvg).toString("base64")}`));
  tray.setToolTip("TuneCord");

  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "TuneCord'u aç", click: showWindow },
    { label: "Discord'da göster", type: "checkbox", checked: config.enabled, click: item => {
      config.enabled = item.checked;
      saveConfig();
      lastPresenceKey = null;
      processPresence();
      sendStatus();
    } },
    { type: "separator" },
    { label: "Çıkış", click: () => { app.isQuitting = true; app.quit(); } }
  ]));

  refresh();
  tray.on("click", showWindow);
  setInterval(refresh, 1500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 760,
    minHeight: 590,
    show: false,
    backgroundColor: "#120d11",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#120d11", symbolColor: "#f8f5f7", height: 36 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
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
ipcMain.handle("save", (_, next) => {
  if (typeof next.enabled === "boolean") config.enabled = next.enabled;
  if (typeof next.selectedOnly === "boolean") config.selectedOnly = next.selectedOnly;
  if (typeof next.startup === "boolean") config.startup = next.startup;
  if (typeof next.discordAppId === "string") config.discordAppId = next.discordAppId.replace(/\s/g, "");
  if (Array.isArray(next.selectedPlaylistIds)) config.selectedPlaylistIds = next.selectedPlaylistIds;
  saveConfig();
  closeDiscord();
  discordError = "";
  lastPresenceKey = null;
  processPresence();
  sendStatus();
  return status();
});

ipcMain.handle("reset-pairing", () => {
  config.bridgeToken = crypto.randomBytes(24).toString("hex");
  saveConfig();
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
  setInterval(() => { processPresence(); sendStatus(); }, 5000);
  if (!process.argv.includes("--tray")) showWindow();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (server) server.close();
  closeDiscord();
});
