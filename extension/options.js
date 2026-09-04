const $ = id => document.getElementById(id);
let status = null;
let selectedIds = new Set();
let discordTimer = null;
let discordEditing = false;
let saveChain = Promise.resolve();

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.ok === false) throw new Error(result?.error || "İşlem başarısız.");
  return result;
}

function message(text, bad = false) {
  $("message").textContent = text;
  $("message").className = bad ? "bad" : "good";
}

function renderPlaylists() {
  const query = $("search").value.trim().toLocaleLowerCase("tr");
  const items = (status?.playlists || []).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase("tr").includes(query));
  $("playlists").replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "Eşleşen playlist yok." : "YouTube oturumundan playlistlerini yenile.";
    $("playlists").append(empty);
    return;
  }

  for (const item of items) {
    const label = document.createElement("label");
    label.className = "playlist-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = item.id;
    checkbox.checked = selectedIds.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(item.id);
      else selectedIds.delete(item.id);
      persist({ selectedPlaylistIds: [...selectedIds] }, "Playlist seçimi anında kaydedildi.");
    });
    const span = document.createElement("span");
    span.innerHTML = "<b></b><small></small>";
    span.querySelector("b").textContent = item.title;
    span.querySelector("small").textContent = item.id;
    label.append(checkbox, span);
    $("playlists").append(label);
  }
}

function render() {
  if (!status) return;
  $("appState").textContent = status.discordConnected ? "Discord bağlı" : "Uygulama bağlı";
  $("appState").classList.toggle("online", Boolean(status.discordConnected));
  if (!discordEditing) $("discordAppId").value = status.discordAppId || "";
  $("enabled").checked = Boolean(status.enabled);
  const mode = document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`);
  if (mode) mode.checked = true;
  renderPlaylists();
}

function persist(control, text = "Otomatik kaydedildi.") {
  saveChain = saveChain.then(async () => {
    try {
      status = await request({ type: "setControl", control });
      selectedIds = new Set(status.selectedPlaylistIds || []);
      render();
      message(text);
    } catch (error) {
      message(error.message, true);
      throw error;
    }
  }).catch(() => {});
  return saveChain;
}

async function load() {
  try {
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
  } catch (error) {
    $("appState").textContent = "Uygulama kapalı";
    $("appState").classList.remove("online");
    message("Önce TuneCord.exe'yi çalıştır.", true);
  }

  try {
    const state = await request({ type: "playlistState" });
    $("extensionId").textContent = `Extension ID: ${state.extensionId}`;
    if (state.sessionConnected) {
      const when = state.lastPlaylistSync ? new Date(state.lastPlaylistSync).toLocaleString("tr-TR") : "";
      $("sessionState").textContent = `YouTube oturumu kullanılıyor${when ? ` · ${when}` : ""}`;
    }
  } catch (_) {}
}

$("sessionSync").addEventListener("click", async () => {
  const button = $("sessionSync");
  button.disabled = true;
  button.textContent = "Playlistler alınıyor…";
  try {
    const result = await request({ type: "syncSessionPlaylists" });
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    $("sessionState").textContent = `YouTube oturumu · ${result.items.length} playlist`;
    message(`${result.items.length} playlist yenilendi.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "YouTube oturumundan yenile";
  }
});

$("enabled").addEventListener("change", event => persist({ enabled: event.target.checked }, "Presence ayarı anında kaydedildi."));
for (const radio of document.querySelectorAll("input[name='mode']")) {
  radio.addEventListener("change", event => persist({ selectedOnly: event.target.value === "selected" }, "Playlist filtresi anında kaydedildi."));
}

$("discordAppId").addEventListener("focus", () => { discordEditing = true; });
$("discordAppId").addEventListener("blur", () => { discordEditing = false; });
$("discordAppId").addEventListener("input", event => {
  clearTimeout(discordTimer);
  const value = event.target.value.replace(/\s/g, "");
  if (value && !/^\d{17,22}$/.test(value)) {
    message("Application ID tamamlanınca otomatik kaydedilecek.");
    return;
  }
  discordTimer = setTimeout(() => persist({ discordAppId: value }, "Application ID otomatik kaydedildi."), 300);
});

$("search").addEventListener("input", renderPlaylists);
chrome.runtime.onMessage.addListener(messageData => {
  if (messageData?.type !== "bridgeState" || !messageData.state) return;
  status = messageData.state;
  selectedIds = new Set(status.selectedPlaylistIds || []);
  render();
});
load();
