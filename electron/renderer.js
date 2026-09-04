const $ = id => document.getElementById(id);

let state = {};
let setupFlowActive = false;
let setupStep = 1;
let detectedBrowsers = [];
let selectedSetupBrowserId = "";

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[char]);
}

function selectedIds() {
  return [...document.querySelectorAll("#playlistList .playlist-item input:checked")].map(input => input.value);
}

function setSetupStep(step) {
  setupStep = step;
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
      $("browserNext").disabled = false;
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
  $("discordId").value = state.discordAppId || "";
  const mode = document.querySelector(`input[name="mode"][value="${state.selectedOnly ? "selected" : "all"}"]`);
  if (mode) mode.checked = true;

  const connection = $("connection");
  if (!state.discordAppId) {
    connection.textContent = "Application ID gerekli";
    connection.classList.remove("online");
  } else if (state.discordConnected) {
    connection.textContent = "Discord bağlı";
    connection.classList.add("online");
  } else {
    connection.textContent = "Discord bekleniyor";
    connection.classList.remove("online");
  }

  $("extensionDot").classList.toggle("online", Boolean(state.extensionConnected));
  $("discordDot").classList.toggle("online", Boolean(state.discordConnected));
  $("extensionState").textContent = state.extensionConnected ? "Eklenti bağlı" : "Eklenti bekleniyor";
  $("discordState").textContent = state.discordConnected ? "Discord bağlı" : "Discord bekleniyor";

  $("trackTitle").textContent = state.track?.playing ? (state.track.title || "Bilinmeyen şarkı") : "Bir şey çalmıyor";
  $("trackArtist").textContent = state.track?.playing
    ? (state.track.artist || state.track.source || "YouTube")
    : "YouTube veya YouTube Music'te bir parça başlat.";

  $("playlistCount").textContent = `${state.playlists?.length || 0} playlist`;
  $("discordError").textContent = state.discordError || "";

  const browser = state.selectedBrowser;
  $("browserBadge").textContent = browser?.name || "Seçilmedi";
  $("browserName").textContent = browser?.name || "Tarayıcı seçilmedi";
  $("browserPath").textContent = browser?.path || "Kurulum sihirbazını çalıştır.";
  $("installState").textContent = state.extensionInstalled ? "Hazır" : "Kurulu değil";
  $("liveExtensionState").textContent = state.extensionConnected ? "Bağlı" : "Bekleniyor";
  $("openBrowser").disabled = !browser;

  renderPlaylists();
}

async function save(message = "Ayarlar kaydedildi.") {
  const appId = $("discordId").value.replace(/\s/g, "");
  if (appId && !/^\d{17,22}$/.test(appId)) {
    $("message").textContent = "Discord Application ID 17–22 rakam olmalı.";
    $("message").className = "form-message bad";
    return;
  }

  try {
    const next = await window.tuneCord.save({
      enabled: $("enabled").checked,
      startup: $("startup").checked,
      selectedOnly: document.querySelector("input[name=mode]:checked")?.value === "selected",
      discordAppId: appId,
      selectedPlaylistIds: selectedIds()
    });
    render(next);
    $("message").textContent = message;
    $("message").className = "form-message";
  } catch (error) {
    $("message").textContent = error.message;
    $("message").className = "form-message bad";
  }
}

$("rescanBrowsers").addEventListener("click", scanBrowsers);
$("browserNext").addEventListener("click", () => {
  const browser = detectedBrowsers.find(item => item.id === selectedSetupBrowserId);
  if (!browser) return;
  $("installDescription").textContent = `${browser.name} seçildi. TuneCord eklentiyi hazırlayıp ${browser.name}'ı eklentiyle başlatacak.`;
  $("installMessage").textContent = "";
  setSetupStep(2);
});
$("setupBack").addEventListener("click", () => setSetupStep(1));
$("installExtension").addEventListener("click", async () => {
  const button = $("installExtension");
  button.disabled = true;
  button.textContent = "Kuruluyor…";
  $("installMessage").textContent = "";
  try {
    const result = await window.tuneCord.installExtension(selectedSetupBrowserId);
    state = result.state;
    const browserName = result.browser?.name || "Tarayıcı";
    $("successText").textContent = `${browserName} eklentiyle açıldı. Tarayıcı ek bir güvenlik onayı gösterirse onayladıktan sonra YouTube'da bir şarkı başlatabilirsin.`;
    setSetupStep(3);
  } catch (error) {
    $("installMessage").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Eklentiyi kur";
  }
});
$("skipSetup").addEventListener("click", async () => {
  try {
    state = await window.tuneCord.skipSetup();
    showApp();
    render(state);
    $("message").textContent = "Eklenti kurulmadı; YouTube algılama çalışmayacak. Tarayıcı kartından kurulumu yeniden açabilirsin.";
    $("message").className = "form-message bad";
  } catch (error) {
    $("installMessage").textContent = error.message;
  }
});
$("finishSetup").addEventListener("click", () => {
  showApp();
  render(state);
});

$("save").addEventListener("click", () => save());
$("enabled").addEventListener("change", () => save("Presence ayarı güncellendi."));
$("startup").addEventListener("change", () => save("Başlangıç ayarı güncellendi."));
for (const radio of document.querySelectorAll("input[name=mode]")) {
  radio.addEventListener("change", () => save("Playlist filtresi güncellendi."));
}
$("search").addEventListener("input", renderPlaylists);
$("playlistList").addEventListener("change", () => {
  $("message").textContent = "Playlist seçimini kaydetmek için Kaydet'e bas.";
  $("message").className = "form-message";
});
$("reset").addEventListener("click", async () => {
  await window.tuneCord.resetPairing();
  $("message").textContent = "Eşleşme yenilendi. Eklenti birkaç saniye içinde tekrar bağlanır.";
  $("message").className = "form-message";
});
$("openBrowser").addEventListener("click", async () => {
  const button = $("openBrowser");
  button.disabled = true;
  try {
    await window.tuneCord.launchBrowser();
    $("message").textContent = "Tarayıcı TuneCord eklentisiyle açıldı.";
    $("message").className = "form-message";
  } catch (error) {
    $("message").textContent = error.message;
    $("message").className = "form-message bad";
  } finally {
    button.disabled = false;
  }
});
$("rerunSetup").addEventListener("click", async () => {
  state = await window.tuneCord.resetSetup();
  selectedSetupBrowserId = state.selectedBrowserId || "";
  showSetup(1);
  scanBrowsers();
});

window.tuneCord.onState(next => render(next));
window.tuneCord.onBridgeError(message => {
  $("discordError").textContent = `Yerel bridge: ${message}`;
});

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
  $("message").textContent = error.message;
  $("message").className = "form-message bad";
});
