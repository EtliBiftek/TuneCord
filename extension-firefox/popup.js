const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);

async function request(message) {
  const result = await api.runtime.sendMessage(message);
  if (!result || result.ok === false) throw new Error(result?.error || "Bağlantı kurulamadı.");
  return result;
}

function showError(text = "") { $("error").hidden = !text; $("error").textContent = text; }
function renderArtwork(track) {
  const img = $("trackArt"), fallback = $("coverFallback");
  const src = track?.playing && /^https:\/\//i.test(track?.thumbnail || "") ? track.thumbnail : "";
  if (!src) { img.hidden = true; img.removeAttribute("src"); fallback.hidden = false; return; }
  img.onload = () => { img.hidden = false; fallback.hidden = true; };
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  if (img.src !== src) img.src = src;
}

function render(status) {
  if (status.discordConnected) $("bridgeState").textContent = "Discord bağlı";
  else if (status.discordConnecting) $("bridgeState").textContent = "Discord'a bağlanıyor…";
  else $("bridgeState").textContent = "TuneCord bağlı";
  $("bridgeState").classList.toggle("online", Boolean(status.discordConnected));
  $("enabled").checked = Boolean(status.enabled);
  const mode = document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`);
  if (mode) mode.checked = true;
  if (status.track?.playing) {
    $("trackTitle").textContent = status.track.title || "Bilinmeyen şarkı";
    $("trackArtist").textContent = status.track.artist || status.track.source || "YouTube";
  } else {
    $("trackTitle").textContent = "Bir şey çalmıyor";
    $("trackArtist").textContent = "YouTube'u açıp bir şarkı başlat.";
  }
  renderArtwork(status.track);
  showError(status.discordError || "");
}

async function load(forcePair = false) {
  showError();
  try { render(await request({ type: forcePair ? "pair" : "getStatus" })); }
  catch (_) { $("bridgeState").textContent = "Uygulama kapalı"; showError("TuneCord.exe'yi aç, sonra yeniden bağlan."); }
}

$("enabled").addEventListener("change", async event => {
  try { render(await request({ type: "setControl", control: { enabled: event.target.checked } })); }
  catch (error) { showError(error.message); }
});
document.querySelectorAll("input[name='mode']").forEach(radio => radio.addEventListener("change", async event => {
  try { render(await request({ type: "setControl", control: { selectedOnly: event.target.value === "selected" } })); }
  catch (error) { showError(error.message); }
}));
api.runtime.onMessage.addListener(message => { if (message?.type === "bridgeState" && message.state) render(message.state); });
$("retry").addEventListener("click", () => load(true));
$("settings").addEventListener("click", () => api.runtime.openOptionsPage());
load(false);
