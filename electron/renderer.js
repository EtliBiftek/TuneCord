const $ = id => document.getElementById(id);
let state = {};

function selectedIds() {
  return [...document.querySelectorAll(".playlist-item input:checked")].map(input => input.value);
}

function render(next) {
  state = next;
  $("enabled").checked = Boolean(next.enabled);
  $("startup").checked = Boolean(next.startup);
  $("discordId").value = next.discordAppId || "";
  document.querySelector(`input[name="mode"][value="${next.selectedOnly ? "selected" : "all"}"]`).checked = true;
  $("connection").textContent = next.discordConnected ? "Discord bağlı" : "Discord bekleniyor";
  $("connection").classList.toggle("online", Boolean(next.discordConnected));
  $("extensionDot").classList.toggle("online", Boolean(next.extensionConnected));
  $("discordDot").classList.toggle("online", Boolean(next.discordConnected));
  $("extensionState").textContent = next.extensionConnected ? "Eklenti bağlı" : "Eklenti bekleniyor";
  $("discordState").textContent = next.discordConnected ? "Discord bağlı" : "Discord bekleniyor";
  $("trackTitle").textContent = next.track?.playing ? (next.track.title || "Bilinmeyen şarkı") : "Bir şey çalmıyor";
  $("trackArtist").textContent = next.track?.playing ? (next.track.artist || next.track.source || "YouTube") : "YouTube veya YouTube Music’te bir parça başlat.";
  $("playlistCount").textContent = `${next.playlists?.length || 0} playlist bulundu`;
  renderPlaylists();
}

function renderPlaylists() {
  const query = $("search").value.trim().toLocaleLowerCase("tr");
  const entries = (state.playlists || []).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase("tr").includes(query));
  const selected = new Set(state.selectedPlaylistIds || []);
  $("playlistList").innerHTML = entries.length ? entries.map(item => `<label class="playlist-item"><input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""}><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.id)}</small></span></label>`).join("") : '<p class="empty">Eşleşen playlist yok.</p>';
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

async function save(message = "Ayarlar kaydedildi.") {
  const appId = $("discordId").value.replace(/\s/g, "");
  if (appId && !/^\d{17,22}$/.test(appId)) { $("message").textContent = "Discord Application ID 17–22 rakam olmalı."; $("message").className = "bad"; return; }
  const next = await window.tuneCord.save({ enabled: $("enabled").checked, startup: $("startup").checked, selectedOnly: document.querySelector("input[name=mode]:checked").value === "selected", discordAppId: appId, selectedPlaylistIds: selectedIds() });
  render(next);
  $("message").textContent = message;
  $("message").className = "good";
}

$("save").addEventListener("click", () => save());
$("enabled").addEventListener("change", () => save("Presence ayarı güncellendi."));
$("startup").addEventListener("change", () => save("Başlangıç ayarı güncellendi."));
for (const radio of document.querySelectorAll("input[name=mode]")) radio.addEventListener("change", () => save("Playlist filtresi güncellendi."));
$("search").addEventListener("input", renderPlaylists);
$("playlistList").addEventListener("change", () => { $("message").textContent = "Seçimi kaydetmek için Kaydet’e bas."; $("message").className = "good"; });
$("reset").addEventListener("click", async () => { await window.tuneCord.resetPairing(); $("message").textContent = "Eşleşme sıfırlandı. Eklentide Yeniden bağlan’a bas."; $("message").className = "good"; });
window.tuneCord.onState(render);
window.tuneCord.state().then(render);
