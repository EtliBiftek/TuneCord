const BRIDGE = "ws://127.0.0.1:37645/ws";
let socket = null;
let connectPromise = null;
let currentTabId = null;
let requestSeq = 0;
let handshakeSeq = 0;
const pending = new Map();

function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function rejectPending(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

async function storedToken() {
  const data = await chrome.storage.local.get("bridgeToken");
  return data.bridgeToken || "";
}

function emitBridgeState(state) {
  chrome.runtime.sendMessage({ type: "bridgeState", state }).catch(() => {});
}

function closeSocket() {
  const old = socket;
  socket = null;
  connectPromise = null;
  if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
    try { old.close(); } catch (_) {}
  }
}

async function ensureSocket(forcePair = false) {
  if (forcePair) {
    await chrome.storage.local.remove("bridgeToken");
    closeSocket();
  }
  if (socket?.readyState === WebSocket.OPEN && socket.__authenticated) return socket;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    let token = await storedToken();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE);
      socket = ws;
      const handshakeId = `hello-${Date.now()}-${++handshakeSeq}`;
      let settled = false;
      const finishResolve = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const finishReject = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (!ws.__authenticated) {
          try { ws.close(); } catch (_) {}
          finishReject(new Error("TuneCord WebSocket bağlantısı zaman aşımına uğradı."));
        }
      }, 6000);

      const sendHello = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ id: handshakeId, type: "hello", token, extensionId: chrome.runtime.id }));
      };

      ws.onopen = sendHello;
      ws.onmessage = async event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        if (message.id === handshakeId) {
          if (!message.ok && message.code === "PAIR_REQUIRED" && message.token) {
            token = message.token;
            await chrome.storage.local.set({ bridgeToken: token });
            sendHello();
            return;
          }
          if (!message.ok) {
            finishReject(new Error(message.error || "TuneCord eşleşmesi başarısız."));
            try { ws.close(); } catch (_) {}
            return;
          }
          ws.__authenticated = true;
          if (message.state) emitBridgeState(message.state);
          badge("", null);
          finishResolve(ws);
          return;
        }

        if (message.type === "state" && message.state) {
          emitBridgeState(message.state);
          return;
        }
        if (message.type === "pair-reset") {
          await chrome.storage.local.remove("bridgeToken");
          return;
        }

        if (message.id && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.ok === false) entry.reject(new Error(message.error || "TuneCord isteği başarısız."));
          else entry.resolve(message);
        }
      };

      ws.onerror = () => {
        badge("!", "#d92d69");
      };

      ws.onclose = () => {
        if (socket === ws) socket = null;
        rejectPending(new Error("TuneCord WebSocket bağlantısı kapandı."));
        badge("!", "#d92d69");
        if (!ws.__authenticated) finishReject(new Error("TuneCord WebSocket bağlantısı kurulamadı."));
      };
    });
  })();

  try {
    const connected = await connectPromise;
    connectPromise = null;
    return connected;
  } catch (error) {
    connectPromise = null;
    throw error;
  }
}

async function bridgeRequest(type, payload = {}, forcePair = false) {
  const ws = await ensureSocket(forcePair);
  const id = `${Date.now()}-${++requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("TuneCord isteği zaman aşımına uğradı."));
    }, 6000);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, type, ...payload }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function getStatus(forcePair = false) {
  const reply = await bridgeRequest("getStatus", {}, forcePair);
  return reply.state || {};
}

async function sendTrack(track, tabId) {
  if (track.playing) {
    currentTabId = tabId;
    await chrome.storage.session.set({ currentTabId: tabId });
    await bridgeRequest("track", { track });
    badge("ON", "#32c67a");
    return;
  }

  if (currentTabId === null) {
    const session = await chrome.storage.session.get("currentTabId");
    currentTabId = session.currentTabId ?? null;
  }
  if (currentTabId !== tabId) return;
  currentTabId = null;
  await chrome.storage.session.remove("currentTabId");
  await bridgeRequest("stop");
  badge("", null);
}

function extractAssignedJson(html) {
  const markers = ["var ytInitialData =", "window[\"ytInitialData\"] =", "ytInitialData ="];
  let start = -1;
  for (const marker of markers) {
    const markerAt = html.indexOf(marker);
    if (markerAt >= 0) {
      start = html.indexOf("{", markerAt + marker.length);
      if (start >= 0) break;
    }
  }
  if (start < 0) throw new Error("YouTube playlist verisi bulunamadı; hesabının açık olduğundan emin ol.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error("YouTube playlist verisi tamamlanmamış geldi.");
}

function rendererText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.runs)) return value.runs.map(run => run.text || "").join("");
  return "";
}

function collectSessionPlaylists(root) {
  const found = new Map();
  const seen = new Set();
  const visit = node => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    for (const key of ["playlistRenderer", "gridPlaylistRenderer", "compactPlaylistRenderer"]) {
      const renderer = node[key];
      const id = renderer?.playlistId;
      const title = rendererText(renderer?.title);
      if (id && title) found.set(id, title);
    }

    const lockup = node.lockupViewModel;
    if (lockup?.contentId) {
      const title = rendererText(lockup.metadata?.lockupMetadataViewModel?.title);
      const looksLikePlaylist = lockup.contentType?.includes("PLAYLIST") || lockup.contentImage?.collectionThumbnailViewModel;
      if (title && looksLikePlaylist) found.set(lockup.contentId, title);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return [...found].map(([id, title]) => ({ id, title }));
}

async function fetchPlaylistsFromSession() {
  const response = await fetch("https://www.youtube.com/feed/playlists", {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`YouTube ${response.status} hatası verdi.`);
  const items = collectSessionPlaylists(extractAssignedJson(await response.text()));
  if (!items.length) throw new Error("Playlist bulunamadı. YouTube hesabına giriş yapıp tekrar dene.");

  await bridgeRequest("playlists", { items });
  await chrome.storage.local.set({ sessionConnected: true, lastPlaylistSync: Date.now() });
  return items;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "track":
        await sendTrack(message.track, sender.tab?.id ?? -1);
        return { ok: true };
      case "getStatus":
        return getStatus(false);
      case "setControl": {
        const reply = await bridgeRequest("setControl", { control: message.control || {} });
        return reply.state || {};
      }
      case "pair":
        return getStatus(true);
      case "syncSessionPlaylists":
        return { ok: true, items: await fetchPlaylistsFromSession() };
      case "bridgeState":
        return { ok: true };
      case "playlistState": {
        const local = await chrome.storage.local.get(["sessionConnected", "lastPlaylistSync"]);
        return { ...local, extensionId: chrome.runtime.id, transport: "websocket" };
      }
      default:
        throw new Error("Bilinmeyen istek.");
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (currentTabId === null) {
    const session = await chrome.storage.session.get("currentTabId");
    currentTabId = session.currentTabId ?? null;
  }
  if (tabId !== currentTabId) return;
  currentTabId = null;
  await chrome.storage.session.remove("currentTabId");
  try {
    await bridgeRequest("stop");
  } catch (_) {}
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  try { await ensureSocket(false); } catch (_) {}
});

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN && socket.__authenticated) {
    bridgeRequest("ping").catch(() => {});
  }
}, 20000);

ensureSocket(false).catch(() => {});
