(() => {
  if (window.__tuneCordLoaded) return;
  window.__tuneCordLoaded = true;
  const api = globalThis.browser || globalThis.chrome;
  let boundVideo = null;
  let lastSignature = "";
  let sendTimer = null;
  const text = selector => document.querySelector(selector)?.textContent?.trim() || "";

  function getVideoId() {
    const url = new URL(location.href);
    const direct = url.searchParams.get("v");
    if (direct) return direct;
    return url.pathname.match(/\/shorts\/([^/?]+)/)?.[1] || "";
  }

  function getThumbnail(videoId, isMusic) {
    if (isMusic) {
      const img = document.querySelector("ytmusic-player-bar img.image, ytmusic-player-bar .thumbnail-image-wrapper img");
      if (img?.src?.startsWith("http")) return img.src;
    }
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og?.startsWith("http")) return og;
    return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
  }

  function getTrack() {
    const video = document.querySelector("video");
    const isMusic = location.hostname === "music.youtube.com";
    const url = new URL(location.href);
    const videoId = getVideoId();
    let title = "", artist = "";

    if (isMusic) {
      title = text("ytmusic-player-bar .title") || text("ytmusic-player-bar [class*='title']");
      const byline = text("ytmusic-player-bar .byline") || text("ytmusic-player-bar .subtitle");
      artist = byline.split(/\s*[•·]\s*/)[0]?.trim() || "YouTube Music";
    } else {
      title = text("ytd-watch-metadata h1 yt-formatted-string") || text("#title h1 yt-formatted-string") || document.querySelector("meta[itemprop='name']")?.content || "";
      artist = text("ytd-video-owner-renderer #channel-name a") || text("#owner #channel-name a") || "YouTube";
    }
    if (!title && document.title) title = document.title.replace(/\s*-\s*YouTube(?: Music)?\s*$/, "").trim();

    const duration = Number.isFinite(video?.duration) ? video.duration : 0;
    const currentTime = Number.isFinite(video?.currentTime) ? video.currentTime : 0;
    const playing = Boolean(video && !video.paused && !video.ended && video.readyState >= 2 && title);
    const list = url.searchParams.get("list") || "";
    return {
      title: title.slice(0, 240), artist: artist.slice(0, 180), videoId, playlistId: list,
      url: videoId ? `https://${location.hostname}/watch?v=${encodeURIComponent(videoId)}${list ? `&list=${encodeURIComponent(list)}` : ""}` : location.href,
      thumbnail: getThumbnail(videoId, isMusic), duration, currentTime, playing,
      source: isMusic ? "YouTube Music" : "YouTube"
    };
  }

  function emit(force = false) {
    const track = getTrack();
    const signature = JSON.stringify([track.title, track.artist, track.videoId, track.playlistId, track.playing, track.thumbnail]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const p = api.runtime.sendMessage({ type: "track", track });
    if (p?.catch) p.catch(() => {});
  }

  function onPlayerEvent() { setTimeout(() => emit(true), 100); }
  function bindVideo() {
    const video = document.querySelector("video");
    if (!video || video === boundVideo) return;
    if (boundVideo) for (const event of ["play","pause","ended","loadedmetadata","durationchange","seeked"]) boundVideo.removeEventListener(event, onPlayerEvent);
    boundVideo = video;
    for (const event of ["play","pause","ended","loadedmetadata","durationchange","seeked"]) video.addEventListener(event, onPlayerEvent, { passive: true });
    emit(true);
  }

  const observer = new MutationObserver(() => {
    bindVideo();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => emit(false), 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", () => setTimeout(() => emit(true), 350));
  setInterval(() => { bindVideo(); if (!document.querySelector("video")?.paused) emit(true); }, 10000);
  bindVideo();
  emit(true);
})();
