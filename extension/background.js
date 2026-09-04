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
    await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
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
    await chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
  } else {
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
}

function getOAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      const token = typeof result === "string" ? result : result?.token;
      if (!token) return reject(new Error("Google erişim anahtarı alınamadı."));
      resolve(token);
    });
  });
}

async function fetchPlaylists(interactive = true) {
  const manifestClientId = chrome.runtime.getManifest().oauth2?.client_id || "";
  if (manifestClientId.startsWith("REPLACE_WITH_")) {
    throw new Error("Önce manifest.json içindeki Google OAuth Client ID alanını ayarla.");
  }

  let token = await getOAuthToken(interactive);
  const items = [];
  let pageToken = "";

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getOAuthToken(interactive);
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`YouTube API ${response.status}: ${detail.slice(0, 180)}`);
    }

    const data = await response.json();
    for (const playlist of data.items || []) {
      items.push({
        id: playlist.id,
        title: playlist.snippet?.title || playlist.id
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  await bridgeFetch("/api/playlists", {
    method: "POST",
    body: JSON.stringify({ items })
  });
  await chrome.storage.local.set({ googleConnected: true, lastPlaylistSync: Date.now() });
  return items;
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
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || "").join("");
  return "";
}

function collectSessionPlaylists(root) {
  const found = new Map();
  const seen = new Set();
  const visit = (node) => {
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

async function signOutGoogle() {
  await chrome.identity.clearAllCachedAuthTokens();
  await chrome.storage.local.set({ googleConnected: false });
  return { ok: true };
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
      case "syncPlaylists":
        return { ok: true, items: await fetchPlaylists(true) };
      case "syncSessionPlaylists":
        return { ok: true, items: await fetchPlaylistsFromSession() };
      case "googleState": {
        const state = await chrome.storage.local.get(["googleConnected", "sessionConnected", "lastPlaylistSync"]);
        return { ...state, extensionId: chrome.runtime.id };
      }
      case "googleSignOut":
        return signOutGoogle();
      default:
        throw new Error("Bilinmeyen istek.");
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
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
    // Uygulama daha sonra açıldığında popup otomatik yeniden eşleşir.
  }
});
