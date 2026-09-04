const $ = (id) => document.getElementById(id);
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
  const items = (status?.playlists || []).filter((item) => item.title.toLocaleLowerCase("tr").includes(query));
  $("playlists").replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "Eşleşen playlist yok." : "Google ile bağlanıp playlistlerini getir.";
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
    span.innerHTML = `<b></b><small></small>`;
    span.querySelector("b").textContent = item.title;
    span.querySelector("small").textContent = item.id;
    label.append(checkbox, span);
    $("playlists").append(label);
  }
}

function render() {
  $("appState").textContent = status.discordConnected ? "Discord bağlı" : "Uygulama bağlı";
  $("appState").classList.add("online");
  $("discordAppId").value = status.discordAppId || "";
  $("enabled").checked = Boolean(status.enabled);
  document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`).checked = true;
  renderPlaylists();
}

async function load() {
  try {
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
  } catch (error) {
    $("appState").textContent = "Uygulama kapalı";
    message("Önce TuneCord.exe'yi çalıştır.", true);
  }
  const state = await request({ type: "googleState" });
  $("extensionId").textContent = `Extension ID: ${state.extensionId}`;
  if (state.googleConnected || state.sessionConnected) {
    const when = state.lastPlaylistSync ? new Date(state.lastPlaylistSync).toLocaleString("tr-TR") : "";
    const method = state.googleConnected ? "Google OAuth bağlı" : "YouTube oturumu kullanıldı";
    $("googleState").textContent = `${method}${when ? ` · Son yenileme: ${when}` : ""}`;
  }
}

$("sessionSync").addEventListener("click", async () => {
  $("sessionSync").disabled = true;
  $("sessionSync").textContent = "Playlistler alınıyor…";
  try {
    const result = await request({ type: "syncSessionPlaylists" });
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    $("googleState").textContent = `YouTube oturumu · ${result.items.length} playlist`;
    message(`${result.items.length} playlist yenilendi.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    $("sessionSync").disabled = false;
    $("sessionSync").textContent = "YouTube oturumundan getir";
  }
});

$("sync").addEventListener("click", async () => {
  $("sync").disabled = true;
  $("sync").textContent = "Playlistler alınıyor…";
  try {
    const result = await request({ type: "syncPlaylists" });
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    $("googleState").textContent = `Bağlı · ${result.items.length} playlist`;
    message(`${result.items.length} playlist yenilendi.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    $("sync").disabled = false;
    $("sync").textContent = "Google ile bağlan / yenile";
  }
});

$("signOut").addEventListener("click", async () => {
  try {
    await request({ type: "googleSignOut" });
    $("googleState").textContent = "Bağlantı kaldırıldı";
    message("Google erişimi kaldırıldı.");
  } catch (error) { message(error.message, true); }
});

$("save").addEventListener("click", async () => {
  const selectedPlaylistIds = [...selectedIds];
  const control = {
    enabled: $("enabled").checked,
    selectedOnly: document.querySelector("input[name='mode']:checked")?.value === "selected",
    discordAppId: $("discordAppId").value.trim(),
    selectedPlaylistIds
  };
  if (control.discordAppId && !/^\d{17,22}$/.test(control.discordAppId)) {
    return message("Discord Application ID yalnızca 17–22 rakam olmalı.", true);
  }
  try {
    status = await request({ type: "setControl", control });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    message("Ayarlar kaydedildi.");
  } catch (error) { message(error.message, true); }
});

$("search").addEventListener("input", renderPlaylists);
load();
