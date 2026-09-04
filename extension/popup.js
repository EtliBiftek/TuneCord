const $ = id => document.getElementById(id);

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
  if (status.discordConnected) {
    $("bridgeState").textContent = "Discord bağlı · WebSocket";
    $("bridgeState").classList.add("online");
  } else {
    $("bridgeState").textContent = "Uygulama bağlı · WebSocket";
    $("bridgeState").classList.remove("online");
  }

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

  showError(status.discordError || "");
}

async function load(forcePair = false) {
  showError();
  try {
    render(await request({ type: forcePair ? "pair" : "getStatus" }));
  } catch (error) {
    $("bridgeState").textContent = "Uygulama kapalı";
    $("bridgeState").classList.remove("online");
    showError("TuneCord.exe'yi aç, sonra yeniden bağlan.");
  }
}

$("enabled").addEventListener("change", async event => {
  try {
    render(await request({ type: "setControl", control: { enabled: event.target.checked } }));
  } catch (error) {
    showError(error.message);
  }
});

for (const radio of document.querySelectorAll("input[name='mode']")) {
  radio.addEventListener("change", async event => {
    try {
      render(await request({ type: "setControl", control: { selectedOnly: event.target.value === "selected" } }));
    } catch (error) {
      showError(error.message);
    }
  });
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "bridgeState" && message.state) render(message.state);
});

$("retry").addEventListener("click", () => load(true));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load(false);
