const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
let status = null;
let selectedIds = new Set();
let discordTimer = null;
let discordEditing = false;
let saveChain = Promise.resolve();
let bridgeRefreshBusy = false;

async function request(message) {
  const result = await api.runtime.sendMessage(message);
  if (!result || result.ok === false) throw new Error(result?.error || "İşlem başarısız.");
  return result;
}
function note(text, bad = false) { $("message").textContent = text; $("message").className = bad ? "footer-message bad" : "footer-message"; }
function switchPane(name) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.pane === name));
  document.querySelectorAll(".option-pane").forEach(p => p.classList.toggle("active", p.id === `pane-${name}`));
}
document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => switchPane(button.dataset.pane)));

function renderPlaylists() {
  const query = $("search").value.trim().toLocaleLowerCase("tr");
  const items = (status?.playlists || []).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase("tr").includes(query));
  $("playlists").replaceChildren();
  if (!items.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = query ? "Eşleşen playlist yok." : "Playlistlerini YouTube oturumundan yenile."; $("playlists").append(p); return; }
  for (const item of items) {
    const label = document.createElement("label"); label.className = "playlist-item";
    const box = document.createElement("input"); box.type = "checkbox"; box.value = item.id; box.checked = selectedIds.has(item.id);
    box.addEventListener("change", () => { box.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id); persist({ selectedPlaylistIds: [...selectedIds] }, "Playlist seçimi kaydedildi"); });
    const span = document.createElement("span"); span.innerHTML = "<b></b><small></small>"; span.querySelector("b").textContent = item.title; span.querySelector("small").textContent = item.id;
    label.append(box, span); $("playlists").append(label);
  }
}

function render() {
  if (!status) return;
  $("appState").textContent = status.discordConnected ? "Discord bağlı" : (status.discordConnecting ? "Bağlanıyor…" : "TuneCord bağlı");
  $("appState").classList.toggle("online", Boolean(status.discordConnected));
  if (!discordEditing) $("discordAppId").value = status.discordAppId || status.defaultDiscordAppId || "";
  $("enabled").checked = Boolean(status.enabled);
  const mode = document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`); if (mode) mode.checked = true;
  renderPlaylists();
}

function persist(control, text = "Kaydedildi") {
  saveChain = saveChain.then(async () => {
    try { status = await request({ type: "setControl", control }); selectedIds = new Set(status.selectedPlaylistIds || []); render(); note(text); return status; }
    catch (error) { note(error.message, true); throw error; }
  }).catch(() => {});
  return saveChain;
}

async function refreshBridgeState(silent = false) {
  if (bridgeRefreshBusy) return;
  bridgeRefreshBusy = true;
  try {
    status = await request({ type: "getStatus" });
    selectedIds = new Set(status.selectedPlaylistIds || []);
    render();
    if (!silent) note("TuneCord bağlantısı hazır");
    else if ($("message").textContent.includes("TuneCord.exe")) note("");
  } catch (error) {
    status = null;
    $("appState").textContent = "Uygulama kapalı";
    $("appState").classList.remove("online");
    if (!silent || $("message").textContent === "") note("TuneCord yerel servisine ulaşılamıyor. TuneCord.exe açıksa eklentiyi yeniden yükle.", true);
  } finally {
    bridgeRefreshBusy = false;
  }
}

async function load() {
  await refreshBridgeState(false);
  try {
    const local = await request({ type: "playlistState" });
    $("extensionId").textContent = local.extensionId || "—";
    if (local.sessionConnected) {
      const when = local.lastPlaylistSync ? new Date(local.lastPlaylistSync).toLocaleString("tr-TR") : "";
      $("sessionState").textContent = `YouTube oturumu kullanılıyor${when ? ` · ${when}` : ""}`;
    }
  } catch (_) {}
}

$("sessionSync").addEventListener("click", async () => {
  const button = $("sessionSync"); button.disabled = true; button.textContent = "Playlistler alınıyor…";
  try { const result = await request({ type: "syncSessionPlaylists" }); status = await request({ type: "getStatus" }); selectedIds = new Set(status.selectedPlaylistIds || []); render(); $("sessionState").textContent = `${result.items.length} playlist yenilendi`; note("Playlistler güncellendi"); }
  catch (error) { note(error.message, true); }
  finally { button.disabled = false; button.textContent = "YouTube oturumundan playlistleri yenile"; }
});
$("enabled").addEventListener("change", e => persist({ enabled: e.target.checked }, "Presence ayarı kaydedildi"));
document.querySelectorAll("input[name='mode']").forEach(r => r.addEventListener("change", e => persist({ selectedOnly: e.target.value === "selected" }, "Playlist filtresi kaydedildi")));
$("discordAppId").addEventListener("focus", () => { discordEditing = true; });
$("discordAppId").addEventListener("blur", () => { discordEditing = false; });
$("discordAppId").addEventListener("input", event => {
  clearTimeout(discordTimer); const value = event.target.value.replace(/\s/g, "");
  if (value && !/^\d{17,22}$/.test(value)) { note("Application ID tamamlanınca kaydedilecek"); return; }
  discordTimer = setTimeout(() => persist({ discordAppId: value }, "Application ID kaydedildi"), 180);
});
$("resetDiscordId").addEventListener("click", () => { discordEditing = false; $("discordAppId").value = status?.defaultDiscordAppId || "1545256357727576124"; persist({ resetDiscordAppId: true }, "Standart Discord ID geri yüklendi"); });
$("search").addEventListener("input", renderPlaylists);
api.runtime.onMessage.addListener(message => { if (message?.type === "bridgeState" && message.state) { status = message.state; selectedIds = new Set(status.selectedPlaylistIds || []); render(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBridgeState(true); });
setInterval(() => { if (!document.hidden) refreshBridgeState(true); }, 2000);
load();
