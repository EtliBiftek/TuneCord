const BRIDGE = "http://127.0.0.1:37645";
let currentTabId = null;

async function pairBridge(force = false) {
  const stored = await chrome.storage.local.get("bridgeToken");
  if (stored.bridgeToken && !force) return stored.bridgeToken;

  const response = await fetch(`${BRIDGE}/api/pair`, { cache: "no-store" });
  if (!response.ok) throw new Error("TuneCord uygulaması eşleşmeye izin vermedi.");
  const data = await response.json();
  if (!data.token) throw new Error("Eşleşme anahtarı alınamadı.");
  await chrome.storage.local.set({ bridgeToken: data.token });
  return data.token;
}

async function bridgeFetch(path, options = {}, retry = true) {
  const token = await pairBridge(false);
  const headers = new Headers(options.headers || {});
  headers.set("X-TuneCord-Token", token);
  if (options.body) headers.set("Content-Type", "application/json; charset=utf-8");

  try {
    const response = await fetch(`${BRIDGE}${path}`, {
      ...options,
      headers,
      cache: "no-store"
    });
    if (response.status === 401 && retry) {
      await pairBridge(true);
      return bridgeFetch(path, options, false);
    }
    if (!response.ok) throw new Error(`Uygulama ${response.status} hatası verdi.`);
    return response.json();
  } catch (error) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d92d69" });
    throw error;
  }
}

async function sendTrack(track, tabId) {
  if (track.playing) {
    currentTabId = tabId;
    await chrome.storage.session.set({ currentTabId: tabId });
    await bridgeFetch("/api/track", {
      method: "POST",
      body: JSON.stringify(track)
    });
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ color: "#32c67a" });
    return;
  }

  if (currentTabId === null) {
    const session = await chrome.storage.session.get("currentTabId");
    currentTabId = session.currentTabId ?? null;
  }
  if (currentTabId !== tabId) return;
  currentTabId = null;
  await chrome.storage.session.remove("currentTabId");
  await bridgeFetch("/api/stop", { method: "POST", body: "{}" });
  await chrome.action.setBadgeText({ text: "" });
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

  await bridgeFetch("/api/playlists", {
    method: "POST",
    body: JSON.stringify({ items })
  });
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
        return bridgeFetch("/api/status");
      case "setControl":
        return bridgeFetch("/api/control", {
          method: "POST",
          body: JSON.stringify(message.control || {})
        });
      case "pair":
        await pairBridge(true);
        return bridgeFetch("/api/status");
      case "syncSessionPlaylists":
        return { ok: true, items: await fetchPlaylistsFromSession() };
      case "playlistState": {
        const local = await chrome.storage.local.get(["sessionConnected", "lastPlaylistSync"]);
        return { ...local, extensionId: chrome.runtime.id };
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
    await bridgeFetch("/api/stop", { method: "POST", body: "{}" });
  } catch (_) {
    // Uygulama kapalıysa sessizce geç.
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  try {
    await pairBridge(true);
  } catch (_) {
    // Uygulama daha sonra açıldığında popup yeniden eşleşir.
  }
});
