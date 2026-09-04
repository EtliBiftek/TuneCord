const $ = id => document.getElementById(id);
let status = null;
let selectedIds = new Set();

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
  $("discordAppId").value = status.discordAppId || "";
  $("enabled").checked = Boolean(status.enabled);
  const mode = document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`);
  if (mode) mode.checked = true;
  renderPlaylists();
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
  } catch (_) {
    // Uygulama kapalı olsa da extension ayar sayfası açılabilir.
  }
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

$("save").addEventListener("click", async () => {
  const control = {
    enabled: $("enabled").checked,
    selectedOnly: document.querySelector("input[name='mode']:checked")?.value === "selected",
    discordAppId: $("discordAppId").value.trim(),
    selectedPlaylistIds: [...selectedIds]
  };

  if (control.discordAppId && !/^\d{17,22}$/.test(control.discordAppId)) {
    return message("Discord Application ID yalnızca 17–22 rakam olmalı.", true);
  }

  try {
    status = await request({ type: "setControl", control });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    message("Ayarlar kaydedildi.");
  } catch (error) {
    message(error.message, true);
  }
});

$("search").addEventListener("input", renderPlaylists);
load();
