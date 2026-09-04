const $ = (id) => document.getElementById(id);

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.ok === false) throw new Error(result?.error || "Bağlantı kurulamadı.");
  return result;
}

function showError(message = "") {
  $("error").hidden = !message;
  $("error").textContent = message;
}

function render(status) {
  $("bridgeState").textContent = status.discordConnected ? "Discord bağlı" : "Uygulama bağlı · Discord bekleniyor";
  $("enabled").checked = Boolean(status.enabled);
  document.querySelector(`input[name='mode'][value='${status.selectedOnly ? "selected" : "all"}']`).checked = true;
  if (status.track?.playing) {
    $("trackTitle").textContent = status.track.title || "Bilinmeyen şarkı";
    $("trackArtist").textContent = status.track.artist || status.track.source || "YouTube";
  } else {
    $("trackTitle").textContent = "Bir şey çalmıyor";
    $("trackArtist").textContent = "YouTube'u açıp bir şarkı başlat.";
  }
}

async function load(forcePair = false) {
  showError();
  try {
    render(await request({ type: forcePair ? "pair" : "getStatus" }));
  } catch (error) {
    $("bridgeState").textContent = "Uygulama kapalı";
    showError("TuneCord.exe'yi aç, sonra yeniden bağlan.");
  }
}

$("enabled").addEventListener("change", async (event) => {
  try { render(await request({ type: "setControl", control: { enabled: event.target.checked } })); }
  catch (error) { showError(error.message); }
});

for (const radio of document.querySelectorAll("input[name='mode']")) {
  radio.addEventListener("change", async (event) => {
    try { render(await request({ type: "setControl", control: { selectedOnly: event.target.value === "selected" } })); }
    catch (error) { showError(error.message); }
  });
}

$("retry").addEventListener("click", () => load(true));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load(false);
