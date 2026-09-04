const $ = id => document.getElementById(id);

let state = {};
let setupFlowActive = false;
let detectedBrowsers = [];
let selectedSetupBrowserId = "";
let saveChain = Promise.resolve();
let discordTimer = null;
let discordEditing = false;

const artwork = document.createElement("img");
artwork.className = "track-artwork";
artwork.alt = "";
artwork.hidden = true;
document.querySelector(".now-art")?.prepend(artwork);
artwork.addEventListener("error", () => { artwork.hidden = true; });

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function selectedIds() {
  return [...document.querySelectorAll("#playlistList .playlist-item input:checked")].map(input => input.value);
}

function setMessage(text = "", bad = false) {
  $("message").textContent = text;
  $("message").className = bad ? "form-message bad" : "form-message";
}

function setSetupStep(step) {
  for (const number of [1, 2, 3]) {
    $(`setupStep${number}`).hidden = number !== step;
    document.querySelector(`[data-step-dot="${number}"]`)?.classList.toggle("active", number <= step);
  }
}

function showSetup(step = 1) {
  setupFlowActive = true;
  $("setupWizard").hidden = false;
  $("appShell").hidden = true;
  setSetupStep(step);
}

function showApp() {
  setupFlowActive = false;
  $("setupWizard").hidden = true;
  $("appShell").hidden = false;
}

function renderBrowserChoices() {
  const list = $("browserList");
  list.replaceChildren();
  if (!detectedBrowsers.length) {
    const empty = document.createElement("div");
    empty.className = "scan-placeholder";
    empty.textContent = "Chromium tabanlı tarayıcı bulunamadı.";
    list.append(empty);
    $("browserNext").disabled = true;
    return;
  }
  for (const browser of detectedBrowsers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `browser-choice${selectedSetupBrowserId === browser.id ? " selected" : ""}`;
    button.style.setProperty("--browser-accent", browser.accent || "#d62976");
    button.innerHTML = `<i class="browser-dot"></i><span><b>${escapeHtml(browser.name)}</b><small>${escapeHtml(browser.path)}</small></span>`;
    button.addEventListener("click", () => {
      selectedSetupBrowserId = browser.id;
      renderBrowserChoices();
    });
    list.append(button);
  }
  $("browserNext").disabled = !selectedSetupBrowserId;
}

async function scanBrowsers() {
  $("browserList").innerHTML = '<div class="scan-placeholder"><span class="spinner"></span> Tarayıcılar aranıyor…</div>';
  $("browserNext").disabled = true;
  try {
    detectedBrowsers = await window.tuneCord.scanBrowsers();
    if (!detectedBrowsers.some(item => item.id === selectedSetupBrowserId)) {
      selectedSetupBrowserId = state.selectedBrowserId && detectedBrowsers.some(item => item.id === state.selectedBrowserId)
        ? state.selectedBrowserId
        : (detectedBrowsers[0]?.id || "");
    }
    renderBrowserChoices();
  } catch (error) {
    detectedBrowsers = [];
    $("browserList").innerHTML = `<div class="scan-placeholder">Tarama başarısız: ${escapeHtml(error.message)}</div>`;
  }
}

function renderPlaylists() {
  const query = $("search").value.trim().toLocaleLowerCase("tr");
  const entries = (state.playlists || []).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase("tr").includes(query));
  const selected = new Set(state.selectedPlaylistIds || []);
  $("playlistList").innerHTML = entries.length
    ? entries.map(item => `
      <label class="playlist-item">
        <input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""}>
        <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.id)}</small></span>
      </label>`).join("")
    : '<p class="empty">Playlist bulunamadı. Eklenti ayarlarından YouTube oturumunu yenile.</p>';
}

function renderArtwork(track) {
  const note = document.querySelector(".music-note");
  const thumbnail = track?.playing && /^https:\/\//i.test(track?.thumbnail || "") ? track.thumbnail : "";
  if (!thumbnail) {
    artwork.hidden = true;
    artwork.removeAttribute("src");
    if (note) note.hidden = false;
    return;
  }
  if (artwork.src !== thumbnail) artwork.src = thumbnail;
  artwork.hidden = false;
  if (note) note.hidden = true;
}

function render(next) {
  state = next || {};
  if (!state.setupComplete && !setupFlowActive) {
    showSetup(1);
    scanBrowsers();
  } else if (state.setupComplete && !setupFlowActive) {
    showApp();
  }

  $("enabled").checked = Boolean(state.enabled);
  $("startup").checked = Boolean(state.startup);
  if (!discordEditing) $("discordId").value = state.discordAppId || "";
  const mode = document.querySelector(`input[name="mode"][value="${state.selectedOnly ? "selected" : "all"}"]`);
  if (mode) mode.checked = true;

  const connection = $("connection");
  if (!state.discordAppId) {
    connection.textContent = "Application ID gerekli";
    connection.classList.remove("online");
  } else if (state.discordConnected) {
    connection.textContent = "Discord bağlı";
    connection.classList.add("online");
  } else if (state.discordConnecting) {
    connection.textContent = "Discord'a bağlanıyor";
    connection.classList.remove("online");
  } else {
    connection.textContent = "Discord bekleniyor";
    connection.classList.remove("online");
  }

  $("extensionDot").classList.toggle("online", Boolean(state.extensionConnected));
  $("discordDot").classList.toggle("online", Boolean(state.discordConnected));
  $("extensionState").textContent = state.extensionConnected ? "Eklenti bağlı · WebSocket" : "Eklenti bekleniyor";
  $("discordState").textContent = state.discordConnected ? "Discord bağlı" : (state.discordConnecting ? "Discord'a bağlanıyor" : "Discord bekleniyor");

  $("trackTitle").textContent = state.track?.playing ? (state.track.title || "Bilinmeyen şarkı") : "Bir şey çalmıyor";
  $("trackArtist").textContent = state.track?.playing
    ? (state.track.artist || state.track.source || "YouTube")
    : "YouTube veya YouTube Music'te bir parça başlat.";
  renderArtwork(state.track);

  $("playlistCount").textContent = `${state.playlists?.length || 0} playlist`;
  $("discordError").textContent = state.discordError || "";

  const browser = state.selectedBrowser;
  $("browserBadge").textContent = browser?.name || "Seçilmedi";
  $("browserName").textContent = browser?.name || "Tarayıcı seçilmedi";
  $("browserPath").textContent = browser?.path || "Kurulum sihirbazını çalıştır.";
  $("installState").textContent = state.extensionInstalled ? "Dosyalar hazır" : "Hazır değil";
  $("liveExtensionState").textContent = state.extensionConnected ? "Bağlı" : "Bekleniyor";
  $("openBrowser").disabled = !browser;
  renderPlaylists();
}

function persist(partial, text = "Otomatik kaydedildi.") {
  saveChain = saveChain.then(async () => {
    try {
      const next = await window.tuneCord.save(partial);
      render(next);
      setMessage(text, false);
      return next;
    } catch (error) {
      setMessage(error.message, true);
      throw error;
    }
  }).catch(() => {});
  return saveChain;
}

$("rescanBrowsers").addEventListener("click", scanBrowsers);
$("browserNext").addEventListener("click", () => {
  const browser = detectedBrowsers.find(item => item.id === selectedSetupBrowserId);
  if (!browser) return;
  const reason = browser.id === "chrome"
    ? "Google Chrome otomatik eklenti kurulumunu desteklemediği için son adımı sen tamamlayacaksın."
    : browser.id === "brave"
      ? "Brave çalışan profile komut satırıyla kalıcı eklenti eklemediği için güvenilir Load unpacked yöntemi kullanılacak."
      : "Chromium güvenlik modeli nedeniyle TuneCord dosyaları hazırlar; son Load unpacked onayını tarayıcıda sen verirsin.";
  $("installDescription").textContent = `${browser.name} seçildi. ${reason}`;
  $("installMessage").textContent = "";
  $("installExtension").textContent = "Dosyaları hazırla";
  setSetupStep(2);
});
$("setupBack").addEventListener("click", () => setSetupStep(1));
$("installExtension").addEventListener("click", async () => {
  const button = $("installExtension");
  button.disabled = true;
  button.textContent = "Hazırlanıyor…";
  $("installMessage").textContent = "";
  try {
    const result = await window.tuneCord.installExtension(selectedSetupBrowserId);
    state = result.state;
    $("successText").textContent = `${result.browser?.name || "Tarayıcı"} için eklenti dosyaları hazırlandı.`;
    $("extensionPathCode").textContent = result.extensionPath;
    $("extensionsUrlCode").textContent = result.extensionsUrl || "chrome://extensions/";
    setSetupStep(3);
  } catch (error) {
    $("installMessage").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Dosyaları hazırla";
  }
});
$("skipSetup").addEventListener("click", async () => {
  try {
    state = await window.tuneCord.skipSetup();
    showApp();
    render(state);
    setMessage("Eklenti kurulmadı; YouTube algılama çalışmayacak.", true);
  } catch (error) {
    $("installMessage").textContent = error.message;
  }
});
$("finishSetup").addEventListener("click", () => { showApp(); render(state); });

$("enabled").addEventListener("change", event => persist({ enabled: event.target.checked }, "Presence ayarı anında kaydedildi."));
$("startup").addEventListener("change", event => persist({ startup: event.target.checked }, "Başlangıç ayarı anında kaydedildi."));
for (const radio of document.querySelectorAll("input[name=mode]")) {
  radio.addEventListener("change", event => persist({ selectedOnly: event.target.value === "selected" }, "Playlist filtresi anında kaydedildi."));
}

$("discordId").addEventListener("focus", () => { discordEditing = true; });
$("discordId").addEventListener("blur", () => { discordEditing = false; });
$("discordId").addEventListener("input", event => {
  clearTimeout(discordTimer);
  const appId = event.target.value.replace(/\s/g, "");
  if (appId && !/^\d{17,22}$/.test(appId)) {
    setMessage("Application ID tamamlanınca otomatik kaydedilecek.", false);
    return;
  }
  discordTimer = setTimeout(() => persist({ discordAppId: appId }, "Application ID kaydedildi; Discord'a bağlanılıyor."), 180);
});

$("search").addEventListener("input", renderPlaylists);
$("playlistList").addEventListener("change", event => {
  if (event.target.matches('input[type="checkbox"]')) persist({ selectedPlaylistIds: selectedIds() }, "Playlist seçimi anında kaydedildi.");
});

$("reset").addEventListener("click", async () => {
  try {
    await window.tuneCord.resetPairing();
    setMessage("WebSocket eşleşmesi yenilendi; eklenti otomatik yeniden bağlanacak.");
  } catch (error) { setMessage(error.message, true); }
});
$("openBrowser").addEventListener("click", async () => {
  const button = $("openBrowser");
  button.disabled = true;
  try {
    await window.tuneCord.launchBrowser();
    setMessage("Tarayıcı açıldı.");
  } catch (error) { setMessage(error.message, true); }
  finally { button.disabled = false; }
});
$("rerunSetup").addEventListener("click", async () => {
  state = await window.tuneCord.resetSetup();
  selectedSetupBrowserId = state.selectedBrowserId || "";
  showSetup(1);
  scanBrowsers();
});

window.tuneCord.onState(next => render(next));
window.tuneCord.onBridgeError(message => { $("discordError").textContent = `Yerel WebSocket: ${message}`; });
window.tuneCord.state().then(next => {
  state = next;
  setupFlowActive = !next.setupComplete;
  if (next.setupComplete) {
    showApp();
    render(next);
  } else {
    showSetup(1);
    render(next);
    scanBrowsers();
  }
}).catch(error => {
  $("appShell").hidden = false;
  setMessage(error.message, true);
});
