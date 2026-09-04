const $ = id => document.getElementById(id);
let state = {};
let setupFlowActive = false;
let detectedBrowsers = [];
let selectedSetupBrowserId = "";
let saveChain = Promise.resolve();
let discordTimer = null;
let discordEditing = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
}

function selectedIds() {
  return [...document.querySelectorAll("#playlistList input:checked")].map(input => input.value);
}

function toast(text = "", bad = false) {
  $("message").textContent = text;
  $("message").className = bad ? "save-note bad" : "save-note";
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

function switchPane(name) {
  for (const button of document.querySelectorAll(".category")) button.classList.toggle("active", button.dataset.pane === name);
  for (const pane of document.querySelectorAll(".pane")) pane.classList.toggle("active", pane.id === `pane-${name}`);
}

document.querySelectorAll(".category").forEach(button => button.addEventListener("click", () => switchPane(button.dataset.pane)));

function renderBrowserChoices() {
  const list = $("browserList");
  list.replaceChildren();
  if (!detectedBrowsers.length) {
    list.innerHTML = '<div class="scan-placeholder">Desteklenen tarayıcı bulunamadı.</div>';
    $("browserNext").disabled = true;
    return;
  }

  for (const family of ["chromium", "firefox"]) {
    const items = detectedBrowsers.filter(item => item.family === family);
    if (!items.length) continue;
    const section = document.createElement("div");
    section.className = "browser-family";
    const title = document.createElement("span");
    title.className = "family-title";
    title.textContent = family === "firefox" ? "Firefox tabanlı" : "Chromium tabanlı";
    section.append(title);
    for (const browser of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `browser-choice${selectedSetupBrowserId === browser.id ? " selected" : ""}`;
      button.style.setProperty("--browser-accent", browser.accent || "#d62976");
      button.innerHTML = `<i></i><span><b>${escapeHtml(browser.name)}</b><small>${escapeHtml(browser.path)}</small></span>`;
      button.addEventListener("click", () => { selectedSetupBrowserId = browser.id; renderBrowserChoices(); });
      section.append(button);
    }
    list.append(section);
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

function renderInstallGuide(result) {
  const guide = $("installGuide");
  const family = result.family || result.browser?.family || "chromium";
  if (family === "firefox") {
    guide.innerHTML = `
      <div class="guide-title">Firefox kurulumu</div>
      <ol>
        <li>Tarayıcıda <code>about:debugging#/runtime/this-firefox</code> sayfasını aç.</li>
        <li><b>Load Temporary Add-on / Geçici eklenti yükle</b> seçeneğine bas.</li>
        <li><code>${escapeHtml(result.manifestPath || "manifest.json")}</code> dosyasını seç.</li>
        <li>YouTube veya YouTube Music sekmesini yenile.</li>
      </ol>
      <p class="warning">Standart Firefox, imzasız eklentiyi kalıcı kurmaz. Bu geliştirme kurulumu Firefox yeniden başladığında tekrar yüklenmelidir; Mozilla imzalı sürüm yayınlandığında kalıcı kurulum mümkün olur.</p>`;
  } else {
    guide.innerHTML = `
      <div class="guide-title">Chromium kurulumu</div>
      <ol>
        <li>Tarayıcıda <code>${escapeHtml(result.extensionsUrl || "chrome://extensions/")}</code> adresini aç.</li>
        <li><b>Geliştirici modu / Developer mode</b> seçeneğini aç.</li>
        <li><b>Paketlenmemiş öğe yükle / Load unpacked</b> düğmesine bas.</li>
        <li><code>${escapeHtml(result.extensionPath)}</code> klasörünü seç.</li>
        <li>YouTube veya YouTube Music sekmesini yenile.</li>
      </ol>`;
  }
}

function renderPlaylists() {
  const query = $("search").value.trim().toLocaleLowerCase("tr");
  const entries = (state.playlists || []).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase("tr").includes(query));
  const selected = new Set(state.selectedPlaylistIds || []);
  $("playlistList").innerHTML = entries.length
    ? entries.map(item => `<label class="playlist-item"><input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""}><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.id)}</small></span></label>`).join("")
    : '<p class="empty">Playlist bulunamadı. Eklentinin ayarlarından YouTube oturumunu yenile.</p>';
}

function renderArtwork(track) {
  const image = $("trackArtwork");
  const fallback = $("artFallback");
  const thumbnail = track?.playing && /^https:\/\//i.test(track?.thumbnail || "") ? track.thumbnail : "";
  if (!thumbnail) {
    image.hidden = true;
    image.removeAttribute("src");
    fallback.hidden = false;
    return;
  }
  image.onload = () => { image.hidden = false; fallback.hidden = true; };
  image.onerror = () => { image.hidden = true; fallback.hidden = false; };
  if (image.src !== thumbnail) image.src = thumbnail;
}

function render(next) {
  state = next || {};
  if (!state.setupComplete && !setupFlowActive) { showSetup(1); scanBrowsers(); }
  else if (state.setupComplete && !setupFlowActive) showApp();

  $("enabled").checked = Boolean(state.enabled);
  $("startup").checked = Boolean(state.startup);
  if (!discordEditing) $("discordId").value = state.discordAppId || state.defaultDiscordAppId || "";
  const mode = document.querySelector(`input[name="mode"][value="${state.selectedOnly ? "selected" : "all"}"]`);
  if (mode) mode.checked = true;

  const connection = $("connection");
  if (state.discordConnected) { connection.textContent = "Discord bağlı"; connection.classList.add("online"); }
  else if (state.discordConnecting) { connection.textContent = "Bağlanıyor…"; connection.classList.remove("online"); }
  else { connection.textContent = "Discord bekleniyor"; connection.classList.remove("online"); }

  $("extensionDot").classList.toggle("online", Boolean(state.extensionConnected));
  $("discordDot").classList.toggle("online", Boolean(state.discordConnected));
  $("extensionState").textContent = state.extensionConnected ? "Eklenti bağlı" : "Eklenti bekleniyor";
  $("discordState").textContent = state.discordConnected ? "Discord bağlı" : (state.discordConnecting ? "Discord'a bağlanıyor" : "Discord bekleniyor");
  $("trackTitle").textContent = state.track?.playing ? (state.track.title || "Bilinmeyen şarkı") : "Bir şey çalmıyor";
  $("trackArtist").textContent = state.track?.playing ? (state.track.artist || state.track.source || "YouTube") : "YouTube veya YouTube Music'te bir parça başlat.";
  renderArtwork(state.track);

  $("playlistCount").textContent = `${state.playlists?.length || 0} playlist`;
  $("discordError").textContent = state.discordError || "";
  const browser = state.selectedBrowser;
  $("browserName").textContent = browser?.name || "Tarayıcı seçilmedi";
  $("browserPath").textContent = browser?.path || "Kurulum sihirbazını çalıştır.";
  $("installState").textContent = state.extensionInstalled ? "Dosyalar hazır" : "Hazır değil";
  $("liveExtensionState").textContent = state.extensionConnected ? "Bağlı" : "Bekleniyor";
  $("openBrowser").disabled = !browser;
  renderPlaylists();
}

function persist(partial, text = "Kaydedildi") {
  saveChain = saveChain.then(async () => {
    try {
      const next = await window.tuneCord.save(partial);
      render(next);
      toast(text);
      return next;
    } catch (error) {
      toast(error.message, true);
      throw error;
    }
  }).catch(() => {});
  return saveChain;
}

$("rescanBrowsers").addEventListener("click", scanBrowsers);
$("browserNext").addEventListener("click", () => {
  const browser = detectedBrowsers.find(item => item.id === selectedSetupBrowserId);
  if (!browser) return;
  $("installDescription").textContent = browser.family === "firefox"
    ? `${browser.name} için Firefox uyumlu TuneCord eklentisi hazırlanacak. Son yükleme onayı about:debugging ekranından yapılır.`
    : `${browser.name} için Chromium eklentisi hazırlanacak. Son yükleme onayını tarayıcıda sen verirsin.`;
  $("installMessage").textContent = "";
  setSetupStep(2);
});
$("setupBack").addEventListener("click", () => setSetupStep(1));
$("installExtension").addEventListener("click", async () => {
  const button = $("installExtension");
  button.disabled = true;
  button.textContent = "Hazırlanıyor…";
  try {
    const result = await window.tuneCord.installExtension(selectedSetupBrowserId);
    state = result.state;
    $("successText").textContent = `${result.browser?.name || "Tarayıcı"} için TuneCord eklentisi hazırlandı.`;
    $("extensionPathCode").textContent = result.extensionPath;
    renderInstallGuide(result);
    setSetupStep(3);
  } catch (error) {
    $("installMessage").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Dosyaları hazırla";
  }
});
$("skipSetup").addEventListener("click", async () => {
  try { state = await window.tuneCord.skipSetup(); showApp(); render(state); toast("Eklenti kurulmadı; şarkı algılama çalışmayacak.", true); }
  catch (error) { $("installMessage").textContent = error.message; }
});
$("finishSetup").addEventListener("click", () => { showApp(); render(state); });

$("enabled").addEventListener("change", e => persist({ enabled: e.target.checked }, "Presence ayarı kaydedildi"));
$("startup").addEventListener("change", e => persist({ startup: e.target.checked }, "Başlangıç ayarı kaydedildi"));
document.querySelectorAll('input[name="mode"]').forEach(radio => radio.addEventListener("change", e => persist({ selectedOnly: e.target.value === "selected" }, "Playlist filtresi kaydedildi")));

$("discordId").addEventListener("focus", () => { discordEditing = true; });
$("discordId").addEventListener("blur", () => { discordEditing = false; });
$("discordId").addEventListener("input", event => {
  clearTimeout(discordTimer);
  const appId = event.target.value.replace(/\s/g, "");
  if (appId && !/^\d{17,22}$/.test(appId)) { toast("Application ID tamamlanınca kaydedilecek"); return; }
  discordTimer = setTimeout(() => persist({ discordAppId: appId }, "Application ID kaydedildi"), 180);
});
$("resetDiscordId").addEventListener("click", () => {
  discordEditing = false;
  $("discordId").value = state.defaultDiscordAppId || "1545256357727576124";
  persist({ resetDiscordAppId: true }, "Standart Discord ID geri yüklendi");
});

$("search").addEventListener("input", renderPlaylists);
$("playlistList").addEventListener("change", event => {
  if (event.target.matches('input[type="checkbox"]')) persist({ selectedPlaylistIds: selectedIds() }, "Playlist seçimi kaydedildi");
});
$("reset").addEventListener("click", async () => {
  try { await window.tuneCord.resetPairing(); toast("Eklenti eşleşmesi yenilendi"); }
  catch (error) { toast(error.message, true); }
});
$("openBrowser").addEventListener("click", async () => {
  try { await window.tuneCord.launchBrowser(); toast("YouTube açıldı"); }
  catch (error) { toast(error.message, true); }
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
  if (next.setupComplete) { showApp(); render(next); }
  else { showSetup(1); render(next); scanBrowsers(); }
}).catch(error => { $("appShell").hidden = false; toast(error.message, true); });
