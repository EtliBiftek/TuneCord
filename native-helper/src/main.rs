#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    env,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};

const PORT: u16 = 37645;
const DEFAULT_DISCORD_APP_ID: &str = "1545256357727576124";
const CHROMIUM_EXTENSION_ID: &str = "mfhiohlcbedfhemkommfailjjfkdfobe";
const FIREFOX_EXTENSION_ID: &str = "tunecord@etlibiftek.local";
const WM_TRAY: u32 = 0x8000 + 77;
const CMD_OPEN: usize = 1001;
const CMD_TOGGLE: usize = 1002;
const CMD_EXIT: usize = 1003;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    enabled: bool,
    selected_only: bool,
    discord_app_id: String,
    bridge_token: String,
    selected_playlist_ids: Vec<String>,
    playlists: Vec<Playlist>,
    startup: bool,
    setup_complete: bool,
    selected_browser_id: String,
    selected_browser_path: String,
    selected_browser_family: String,
    extension_installed: bool,
    app_exe_path: String,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            selected_only: false,
            discord_app_id: DEFAULT_DISCORD_APP_ID.to_string(),
            bridge_token: String::new(),
            selected_playlist_ids: vec![],
            playlists: vec![],
            startup: false,
            setup_complete: false,
            selected_browser_id: String::new(),
            selected_browser_path: String::new(),
            selected_browser_family: "chromium".into(),
            extension_installed: false,
            app_exe_path: String::new(),
            extra: HashMap::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Playlist {
    id: String,
    title: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Track {
    title: String,
    artist: String,
    video_id: String,
    playlist_id: String,
    url: String,
    thumbnail: String,
    duration: f64,
    current_time: f64,
    playing: bool,
    source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserInfo {
    id: String,
    family: String,
    name: String,
    path: String,
    accent: String,
    extensions_url: String,
}

#[derive(Clone, Default)]
struct DiscordStatus {
    connected: bool,
    connecting: bool,
    error: String,
}

struct AppState {
    config: Mutex<Config>,
    track: Mutex<Track>,
    discord: Mutex<DiscordStatus>,
    clients: Mutex<HashMap<u64, TcpStream>>,
    stop: AtomicBool,
    tray_hwnd: AtomicIsize,
    client_seq: AtomicU64,
    helper_path: PathBuf,
}

static GLOBAL_APP: OnceLock<Arc<AppState>> = OnceLock::new();

impl AppState {
    fn config_path(&self) -> PathBuf { appdata_dir().join("config.json") }

    fn save_config(&self) {
        let cfg = self.config.lock().unwrap().clone();
        let _ = fs::create_dir_all(appdata_dir());
        if let Ok(text) = serde_json::to_string_pretty(&cfg) {
            let _ = fs::write(self.config_path(), text);
        }
    }

    fn state_json(&self) -> Value {
        let cfg = self.config.lock().unwrap().clone();
        let track = self.track.lock().unwrap().clone();
        let discord = self.discord.lock().unwrap().clone();
        let browser = selected_browser(&cfg);
        let family = browser.as_ref().map(|b| b.family.as_str()).unwrap_or(&cfg.selected_browser_family);
        let extension_path = installed_extension_path(family);
        json!({
            "helperVersion": env!("CARGO_PKG_VERSION"),
            "backend": "native",
            "lowMemoryTray": true,
            "enabled": cfg.enabled,
            "selectedOnly": cfg.selected_only,
            "discordAppId": cfg.discord_app_id,
            "defaultDiscordAppId": DEFAULT_DISCORD_APP_ID,
            "playlists": cfg.playlists,
            "selectedPlaylistIds": cfg.selected_playlist_ids,
            "startup": cfg.startup,
            "setupComplete": cfg.setup_complete,
            "selectedBrowserId": cfg.selected_browser_id,
            "selectedBrowser": browser,
            "extensionInstalled": cfg.extension_installed && extension_path.exists(),
            "extensionPath": extension_path.to_string_lossy(),
            "extensionConnected": !self.clients.lock().unwrap().is_empty(),
            "discordConnected": discord.connected,
            "discordConnecting": discord.connecting,
            "discordError": discord.error,
            "transport": "websocket-native",
            "track": track
        })
    }

    fn broadcast_state(&self) {
        let payload = json!({"type":"state","state":self.state_json()}).to_string();
        let mut dead = Vec::new();
        let mut clients = self.clients.lock().unwrap();
        for (id, stream) in clients.iter_mut() {
            if write_ws_text(stream, &payload).is_err() { dead.push(*id); }
        }
        for id in dead { clients.remove(&id); }
    }
}

fn appdata_dir() -> PathBuf {
    let root = env::var_os("APPDATA").or_else(|| env::var_os("LOCALAPPDATA")).unwrap_or_default();
    PathBuf::from(root).join("TuneCord")
}

fn local_bin_dir() -> PathBuf {
    let root = env::var_os("LOCALAPPDATA").or_else(|| env::var_os("APPDATA")).unwrap_or_default();
    PathBuf::from(root).join("TuneCord").join("bin")
}

fn generate_token() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let raw = format!("{}:{}:{}", now, std::process::id(), env::current_exe().unwrap_or_default().display());
    let digest = Sha1::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn load_config() -> Config {
    let path = appdata_dir().join("config.json");
    let mut cfg: Config = fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if cfg.discord_app_id.trim().is_empty() { cfg.discord_app_id = DEFAULT_DISCORD_APP_ID.into(); }
    if cfg.bridge_token.is_empty() { cfg.bridge_token = generate_token(); }
    if cfg.selected_browser_family.is_empty() { cfg.selected_browser_family = browser_family_from_id(&cfg.selected_browser_id).into(); }
    cfg
}

fn browser_family_from_id(id: &str) -> &'static str {
    match id { "firefox"|"firefox-developer"|"librewolf"|"waterfox"|"floorp"|"zen" => "firefox", _ => "chromium" }
}

fn p(root: &str, parts: &[&str]) -> PathBuf {
    let mut out = PathBuf::from(root);
    for part in parts { out.push(part); }
    out
}

fn candidate(id:&str, family:&str, name:&str, accent:&str, url:&str, paths:Vec<PathBuf>) -> Option<BrowserInfo> {
    paths.into_iter().find(|x| x.exists()).map(|path| BrowserInfo {
        id:id.into(), family:family.into(), name:name.into(), path:path.to_string_lossy().into_owned(), accent:accent.into(), extensions_url:url.into()
    })
}

fn detect_browsers() -> Vec<BrowserInfo> {
    let local = env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = env::var("PROGRAMFILES").unwrap_or_default();
    let pf86 = env::var("PROGRAMFILES(X86)").unwrap_or_default();
    let roaming = env::var("APPDATA").unwrap_or_default();
    let mut out = Vec::new();
    let items = vec![
        candidate("brave","chromium","Brave","#fb542b","brave://extensions/",vec![p(&local,&["BraveSoftware","Brave-Browser","Application","brave.exe"]),p(&pf,&["BraveSoftware","Brave-Browser","Application","brave.exe"]),p(&pf86,&["BraveSoftware","Brave-Browser","Application","brave.exe"])]),
        candidate("chrome","chromium","Google Chrome","#4285f4","chrome://extensions/",vec![p(&local,&["Google","Chrome","Application","chrome.exe"]),p(&pf,&["Google","Chrome","Application","chrome.exe"]),p(&pf86,&["Google","Chrome","Application","chrome.exe"])]),
        candidate("edge","chromium","Microsoft Edge","#0aa7b5","edge://extensions/",vec![p(&pf86,&["Microsoft","Edge","Application","msedge.exe"]),p(&pf,&["Microsoft","Edge","Application","msedge.exe"]),p(&local,&["Microsoft","Edge","Application","msedge.exe"])]),
        candidate("vivaldi","chromium","Vivaldi","#ef3939","vivaldi://extensions/",vec![p(&local,&["Vivaldi","Application","vivaldi.exe"]),p(&pf,&["Vivaldi","Application","vivaldi.exe"]),p(&pf86,&["Vivaldi","Application","vivaldi.exe"])]),
        candidate("opera-gx","chromium","Opera GX","#ff1b6b","opera://extensions/",vec![p(&local,&["Programs","Opera GX","opera.exe"]),p(&local,&["Programs","Opera GX","launcher.exe"]),p(&roaming,&["Opera Software","Opera GX Stable","opera.exe"])]),
        candidate("opera","chromium","Opera","#ff1b2d","opera://extensions/",vec![p(&local,&["Programs","Opera","opera.exe"]),p(&local,&["Programs","Opera","launcher.exe"])]),
        candidate("chromium","chromium","Chromium","#62a8e5","chrome://extensions/",vec![p(&local,&["Chromium","Application","chrome.exe"]),p(&local,&["Chromium","Application","chromium.exe"]),p(&pf,&["Chromium","Application","chrome.exe"])]),
        candidate("firefox","firefox","Mozilla Firefox","#ff7139","about:debugging#/runtime/this-firefox",vec![p(&pf,&["Mozilla Firefox","firefox.exe"]),p(&pf86,&["Mozilla Firefox","firefox.exe"]),p(&local,&["Mozilla Firefox","firefox.exe"])]),
        candidate("firefox-developer","firefox","Firefox Developer Edition","#7542e5","about:debugging#/runtime/this-firefox",vec![p(&pf,&["Firefox Developer Edition","firefox.exe"]),p(&pf86,&["Firefox Developer Edition","firefox.exe"])]),
        candidate("librewolf","firefox","LibreWolf","#6aa6d9","about:debugging#/runtime/this-firefox",vec![p(&pf,&["LibreWolf","librewolf.exe"]),p(&pf86,&["LibreWolf","librewolf.exe"]),p(&local,&["Programs","LibreWolf","librewolf.exe"])]),
        candidate("waterfox","firefox","Waterfox","#4d8cff","about:debugging#/runtime/this-firefox",vec![p(&pf,&["Waterfox","waterfox.exe"]),p(&pf86,&["Waterfox","waterfox.exe"]),p(&local,&["Waterfox","waterfox.exe"])]),
        candidate("floorp","firefox","Floorp","#6c8cff","about:debugging#/runtime/this-firefox",vec![p(&pf,&["Ablaze Floorp","floorp.exe"]),p(&pf,&["Floorp","floorp.exe"]),p(&local,&["Programs","Floorp","floorp.exe"])]),
        candidate("zen","firefox","Zen Browser","#9d7cff","about:debugging#/runtime/this-firefox",vec![p(&local,&["Programs","Zen Browser","zen.exe"]),p(&pf,&["Zen Browser","zen.exe"]),p(&pf,&["Zen","zen.exe"])]),
    ];
    for x in items.into_iter().flatten() {
        if !out.iter().any(|b: &BrowserInfo| b.path.eq_ignore_ascii_case(&x.path)) { out.push(x); }
    }
    out
}

fn selected_browser(cfg: &Config) -> Option<BrowserInfo> {
    detect_browsers().into_iter().find(|b| b.id == cfg.selected_browser_id).or_else(|| {
        if cfg.selected_browser_path.is_empty() { return None; }
        Some(BrowserInfo {
            id: cfg.selected_browser_id.clone(),
            family: if cfg.selected_browser_family.is_empty() { browser_family_from_id(&cfg.selected_browser_id).into() } else { cfg.selected_browser_family.clone() },
            name: if cfg.selected_browser_id.is_empty() { "Tarayıcı".into() } else { cfg.selected_browser_id.clone() },
            path: cfg.selected_browser_path.clone(), accent:"#d94683".into(),
            extensions_url: if cfg.selected_browser_family == "firefox" { "about:debugging#/runtime/this-firefox".into() } else { "chrome://extensions/".into() },
        })
    })
}

fn installed_extension_path(family: &str) -> PathBuf {
    appdata_dir().join(if family == "firefox" { "extension-firefox" } else { "extension" })
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() { fs::remove_dir_all(dst)?; }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() { copy_dir(&entry.path(), &target)?; } else { fs::copy(entry.path(), target)?; }
    }
    Ok(())
}

fn open_browser_page(browser: &BrowserInfo, url: &str) -> Result<(), String> {
    if !Path::new(&browser.path).exists() { return Err("Seçilen tarayıcı artık bulunamıyor.".into()); }
    Command::new(&browser.path).arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn set_startup(enabled: bool, helper_path: &Path) {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let data = format!("\"{}\" --background", helper_path.display());
        let _ = Command::new("reg").args(["add", key, "/v", "TuneCord", "/t", "REG_SZ", "/d", &data, "/f"]).output();
    } else {
        let _ = Command::new("reg").args(["delete", key, "/v", "TuneCord", "/f"]).output();
    }
}

fn launch_ui(app: &AppState) {
    let path = app.config.lock().unwrap().app_exe_path.clone();
    if !path.is_empty() && Path::new(&path).exists() { let _ = Command::new(path).spawn(); }
}

fn parse_http_request(stream: &mut TcpStream) -> std::io::Result<(String,String,HashMap<String,String>,Vec<u8>)> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = Vec::new();
    let mut tmp = [0u8;4096];
    let header_end;
    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"eof")); }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") { header_end = pos + 4; break; }
        if buf.len() > 64*1024 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"headers too large")); }
    }
    let head = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut p = first.split_whitespace();
    let method = p.next().unwrap_or("").to_string();
    let path = p.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k,v)) = line.split_once(':') { headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string()); }
    }
    let len = headers.get("content-length").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    while buf.len() < header_end + len {
        let n = stream.read(&mut tmp)?;
        if n == 0 { break; }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = buf.get(header_end..header_end+len.min(buf.len().saturating_sub(header_end))).unwrap_or(&[]).to_vec();
    Ok((method,path,headers,body))
}

fn find_bytes(hay:&[u8], needle:&[u8]) -> Option<usize> { hay.windows(needle.len()).position(|w| w==needle) }

fn http_json(stream:&mut TcpStream, status:&str, value:&Value) {
    let body = value.to_string();
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.as_bytes().len(), body);
    let _ = stream.write_all(response.as_bytes());
}

fn handle_http(app:&Arc<AppState>, stream:&mut TcpStream, method:&str, path:&str, body:&[u8]) {
    let data: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(body).unwrap_or_else(|_|json!({})) };
    let result: Result<Value,String> = match (method,path) {
        ("GET","/api/state") => Ok(app.state_json()),
        ("GET","/api/scan-browsers") => Ok(serde_json::to_value(detect_browsers()).unwrap()),
        ("POST","/api/register") => {
            let mut cfg = app.config.lock().unwrap();
            if let Some(v)=data.get("appExePath").and_then(Value::as_str) { cfg.app_exe_path=v.to_string(); }
            drop(cfg); app.save_config(); Ok(app.state_json())
        },
        ("POST","/api/control") => {
            let mut cfg=app.config.lock().unwrap();
            if let Some(v)=data.get("enabled").and_then(Value::as_bool){cfg.enabled=v;}
            if let Some(v)=data.get("selectedOnly").and_then(Value::as_bool){cfg.selected_only=v;}
            if let Some(v)=data.get("startup").and_then(Value::as_bool){cfg.startup=v;}
            if data.get("resetDiscordAppId").and_then(Value::as_bool)==Some(true){cfg.discord_app_id=DEFAULT_DISCORD_APP_ID.into();}
            if let Some(v)=data.get("discordAppId").and_then(Value::as_str){ let x=v.trim(); if x.len()>=17 && x.len()<=22 && x.chars().all(|c|c.is_ascii_digit()){cfg.discord_app_id=x.into();} }
            if let Some(arr)=data.get("selectedPlaylistIds").and_then(Value::as_array){cfg.selected_playlist_ids=arr.iter().filter_map(Value::as_str).map(str::to_string).collect();}
            let startup=cfg.startup; drop(cfg); app.save_config(); set_startup(startup,&app.helper_path); app.broadcast_state(); Ok(app.state_json())
        },
        ("POST","/api/reset-pairing") => { let mut cfg=app.config.lock().unwrap(); cfg.bridge_token=generate_token(); drop(cfg); app.save_config(); app.clients.lock().unwrap().clear(); app.broadcast_state(); Ok(json!({"ok":true})) },
        ("POST","/api/skip-setup") => { let mut cfg=app.config.lock().unwrap(); cfg.setup_complete=true; cfg.extension_installed=false; drop(cfg); app.save_config(); app.broadcast_state(); Ok(app.state_json()) },
        ("POST","/api/reset-setup") => { let mut cfg=app.config.lock().unwrap(); cfg.setup_complete=false; drop(cfg); app.save_config(); app.broadcast_state(); Ok(app.state_json()) },
        ("POST","/api/install-extension") => (|| -> Result<Value,String> {
            let browser_id=data.get("browserId").and_then(Value::as_str).unwrap_or("");
            let root=data.get("resourceRoot").and_then(Value::as_str).ok_or_else(||"Uygulama kaynak klasörü bulunamadı.".to_string())?;
            let browser=detect_browsers().into_iter().find(|b|b.id==browser_id).ok_or_else(||"Seçtiğin tarayıcı bulunamadı. Yeniden tara.".to_string())?;
            let family=browser.family.clone();
            let extensions_url=browser.extensions_url.clone();
            let folder=if family=="firefox"{"extension-firefox"}else{"extension"};
            let src=PathBuf::from(root).join(folder); let dst=installed_extension_path(&family);
            if !src.exists(){return Err("Paket içindeki TuneCord eklentisi bulunamadı.".into());}
            copy_dir(&src,&dst).map_err(|e|e.to_string())?;
            {let mut cfg=app.config.lock().unwrap(); cfg.selected_browser_id=browser.id.clone(); cfg.selected_browser_path=browser.path.clone(); cfg.selected_browser_family=family.clone(); cfg.extension_installed=true; cfg.setup_complete=true;}
            app.save_config(); let _=open_browser_page(&browser,&extensions_url); app.broadcast_state();
            Ok(json!({"browser":browser,"family":family,"extensionPath":dst.to_string_lossy(),"manifestPath":dst.join("manifest.json").to_string_lossy(),"extensionsUrl":extensions_url,"temporary":family=="firefox","state":app.state_json()}))
        })(),
        ("POST","/api/launch-browser") => (|| -> Result<Value,String> { let cfg=app.config.lock().unwrap().clone(); let browser=selected_browser(&cfg).ok_or_else(||"Önce bir tarayıcı seç.".to_string())?; open_browser_page(&browser,&browser.extensions_url)?; Ok(json!({"ok":true,"browser":browser.name,"extensionsUrl":browser.extensions_url})) })(),
        ("POST","/api/playlists") => { let mut cfg=app.config.lock().unwrap(); if let Some(items)=data.get("items").and_then(Value::as_array){cfg.playlists=items.iter().filter_map(|v|serde_json::from_value(v.clone()).ok()).collect(); let ids:Vec<String>=cfg.playlists.iter().map(|x|x.id.clone()).collect(); cfg.selected_playlist_ids.retain(|id|ids.contains(id));} drop(cfg); app.save_config(); app.broadcast_state(); Ok(app.state_json()) },
        ("POST","/api/shutdown") => { app.stop.store(true,Ordering::SeqCst); let hwnd=app.tray_hwnd.load(Ordering::SeqCst); if hwnd!=0 {unsafe{PostMessageW(hwnd as HWND,WM_CLOSE,0,0);}} Ok(json!({"ok":true})) },
        _ => Err("Bulunamadı.".into())
    };
    match result { Ok(v)=>http_json(stream,"200 OK",&v), Err(e)=>http_json(stream,"400 Bad Request",&json!({"error":e})) }
}

fn websocket_upgrade(app:Arc<AppState>, mut stream:TcpStream, headers:&HashMap<String,String>) {
    let Some(key)=headers.get("sec-websocket-key") else {return};
    let mut hasher=Sha1::new(); hasher.update(key.as_bytes()); hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept=BASE64.encode(hasher.finalize());
    let resp=format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    if stream.write_all(resp.as_bytes()).is_err(){return;}
    let client_id=app.client_seq.fetch_add(1,Ordering::Relaxed)+1;
    let mut authenticated=false;
    while !app.stop.load(Ordering::Relaxed) {
        let text=match read_ws_text(&mut stream){Ok(Some(x))=>x,Ok(None)=>break,Err(_)=>break};
        let msg:Value=match serde_json::from_str(&text){Ok(x)=>x,Err(_)=>continue};
        let id=msg.get("id").cloned().unwrap_or(Value::Null);
        let typ=msg.get("type").and_then(Value::as_str).unwrap_or("");
        if typ=="hello" {
            let token=msg.get("token").and_then(Value::as_str).unwrap_or("");
            let extension_id=msg.get("extensionId").and_then(Value::as_str).unwrap_or("");
            let family=msg.get("browserFamily").and_then(Value::as_str).unwrap_or("chromium");
            let cfg=app.config.lock().unwrap().clone();
            let known=extension_id==CHROMIUM_EXTENSION_ID||extension_id==FIREFOX_EXTENSION_ID;
            let family_ok=cfg.extension_installed && family==cfg.selected_browser_family && !extension_id.is_empty();
            if !known&&!family_ok { let _=write_ws_text(&mut stream,&json!({"id":id,"ok":false,"code":"BAD_EXTENSION","error":"TuneCord eklentisi doğrulanamadı."}).to_string()); continue; }
            if token!=cfg.bridge_token { let _=write_ws_text(&mut stream,&json!({"id":id,"ok":false,"code":"PAIR_REQUIRED","token":cfg.bridge_token}).to_string()); continue; }
            authenticated=true;
            if let Ok(writer)=stream.try_clone(){app.clients.lock().unwrap().insert(client_id,writer);}
            let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string()); app.broadcast_state(); continue;
        }
        if !authenticated { let _=write_ws_text(&mut stream,&json!({"id":id,"ok":false,"code":"NOT_AUTHENTICATED","error":"Önce eşleşme gerekli."}).to_string()); continue; }
        match typ {
            "getStatus"=>{let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string());},
            "track"=>{ if let Some(t)=msg.get("track"){ if let Ok(track)=serde_json::from_value::<Track>(t.clone()){*app.track.lock().unwrap()=track; app.broadcast_state();}} let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string());},
            "stop"=>{*app.track.lock().unwrap()=Track::default(); app.broadcast_state(); let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string());},
            "setControl"=>{{let mut cfg=app.config.lock().unwrap(); if let Some(v)=msg.pointer("/control/enabled").and_then(Value::as_bool){cfg.enabled=v;} if let Some(v)=msg.pointer("/control/selectedOnly").and_then(Value::as_bool){cfg.selected_only=v;} if let Some(v)=msg.pointer("/control/discordAppId").and_then(Value::as_str){if v.len()>=17&&v.len()<=22&&v.chars().all(|c|c.is_ascii_digit()){cfg.discord_app_id=v.into();}} if msg.pointer("/control/resetDiscordAppId").and_then(Value::as_bool)==Some(true){cfg.discord_app_id=DEFAULT_DISCORD_APP_ID.into();} if let Some(a)=msg.pointer("/control/selectedPlaylistIds").and_then(Value::as_array){cfg.selected_playlist_ids=a.iter().filter_map(Value::as_str).map(str::to_string).collect();} } app.save_config(); app.broadcast_state(); let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string());},
            "playlists"=>{if let Some(items)=msg.get("items").and_then(Value::as_array){let mut cfg=app.config.lock().unwrap(); cfg.playlists=items.iter().filter_map(|v|serde_json::from_value(v.clone()).ok()).collect();} app.save_config(); app.broadcast_state(); let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"state":app.state_json()}).to_string());},
            "ping"=>{let _=write_ws_text(&mut stream,&json!({"id":id,"ok":true,"pong":now_ms()}).to_string());},
            _=>{let _=write_ws_text(&mut stream,&json!({"id":id,"ok":false,"error":"Bilinmeyen WebSocket isteği."}).to_string());}
        }
    }
    app.clients.lock().unwrap().remove(&client_id); app.broadcast_state();
}

fn run_server(app:Arc<AppState>, listener:TcpListener) {
    let _=listener.set_nonblocking(true);
    while !app.stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream,_))=>{let app2=app.clone(); thread::spawn(move||{if let Ok((method,path,headers,body))=parse_http_request(&mut stream){let upgrade=headers.get("upgrade").map(|s|s.eq_ignore_ascii_case("websocket")).unwrap_or(false); if upgrade&&path=="/ws"{websocket_upgrade(app2,stream,&headers);}else{handle_http(&app2,&mut stream,&method,&path,&body);}}});},
            Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(35)),
            Err(_)=>thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn write_ws_text(stream:&mut TcpStream,text:&str)->std::io::Result<()> { let data=text.as_bytes(); let mut frame=Vec::with_capacity(data.len()+10); frame.push(0x81); if data.len()<126{frame.push(data.len() as u8);}else if data.len()<=65535{frame.push(126);frame.extend_from_slice(&(data.len() as u16).to_be_bytes());}else{frame.push(127);frame.extend_from_slice(&(data.len() as u64).to_be_bytes());} frame.extend_from_slice(data); stream.write_all(&frame) }

fn read_ws_text(stream:&mut TcpStream)->std::io::Result<Option<String>> { let mut h=[0u8;2]; if stream.read_exact(&mut h).is_err(){return Ok(None);} let opcode=h[0]&0x0f; let masked=h[1]&0x80!=0; let mut len=(h[1]&0x7f) as u64; if len==126{let mut b=[0;2];stream.read_exact(&mut b)?;len=u16::from_be_bytes(b) as u64;}else if len==127{let mut b=[0;8];stream.read_exact(&mut b)?;len=u64::from_be_bytes(b);} if len>4*1024*1024{return Ok(None);} let mut mask=[0u8;4]; if masked{stream.read_exact(&mut mask)?;} let mut data=vec![0u8;len as usize];stream.read_exact(&mut data)?; if masked{for(i,b)in data.iter_mut().enumerate(){*b^=mask[i%4];}} if opcode==8{return Ok(None);} if opcode==9{return Ok(Some(String::new()));} if opcode!=1{return Ok(Some(String::new()));} Ok(Some(String::from_utf8_lossy(&data).into_owned())) }

fn now_ms()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}
fn now_secs()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}

fn discord_frame(op:i32,body:&Value)->Vec<u8>{let payload=body.to_string().into_bytes();let mut out=Vec::with_capacity(payload.len()+8);out.extend_from_slice(&op.to_le_bytes());out.extend_from_slice(&(payload.len() as i32).to_le_bytes());out.extend_from_slice(&payload);out}
fn discord_write(file:&mut File,op:i32,body:&Value)->std::io::Result<()> {file.write_all(&discord_frame(op,body));file.flush()}

#[link(name="kernel32")]
extern "system" { fn PeekNamedPipe(h_named_pipe:*mut c_void,buffer:*mut c_void,buffer_size:u32,bytes_read:*mut u32,total_bytes_avail:*mut u32,bytes_left:*mut u32)->i32; }

fn pipe_available(file:&File)->Result<u32,String>{let mut avail=0u32;let ok=unsafe{PeekNamedPipe(file.as_raw_handle() as *mut c_void,null_mut(),0,null_mut(),&mut avail,null_mut())};if ok==0{Err("Discord IPC bağlantısı kapandı.".into())}else{Ok(avail)}}

fn read_discord_frames(file:&mut File,buffer:&mut Vec<u8>)->Result<Vec<(i32,Value)>,String>{let avail=pipe_available(file)?;if avail>0{let mut tmp=vec![0u8;avail as usize];let n=file.read(&mut tmp).map_err(|e|e.to_string())?;buffer.extend_from_slice(&tmp[..n]);}let mut out=vec![];loop{if buffer.len()<8{break;}let op=i32::from_le_bytes(buffer[0..4].try_into().unwrap());let len=i32::from_le_bytes(buffer[4..8].try_into().unwrap());if len<0||len>4*1024*1024{return Err("Discord IPC geçersiz frame gönderdi.".into());}let end=8+len as usize;if buffer.len()<end{break;}let value=serde_json::from_slice::<Value>(&buffer[8..end]).unwrap_or_else(|_|json!({}));buffer.drain(..end);out.push((op,value));}Ok(out)}

fn try_discord_connect(app_id:&str)->Result<(File,Vec<u8>),String>{let mut last=String::new();for index in 0..10{let name=format!(r"\\?\pipe\discord-ipc-{index}");let Ok(mut file)=OpenOptions::new().read(true).write(true).open(&name) else {continue};discord_write(&mut file,0,&json!({"v":1,"client_id":app_id})).map_err(|e|e.to_string())?;let deadline=Instant::now()+Duration::from_millis(1400);let mut buffer=Vec::new();while Instant::now()<deadline{match read_discord_frames(&mut file,&mut buffer){Ok(frames)=>{for(op,payload)in frames{if op==3{let _=discord_write(&mut file,4,&payload);}else if op==2{return Err(payload.pointer("/data/message").and_then(Value::as_str).unwrap_or("Discord IPC bağlantıyı kapattı.").into());}else if op==1&&payload.get("evt").and_then(Value::as_str)==Some("READY"){return Ok((file,buffer));}else if op==1&&payload.get("evt").and_then(Value::as_str)==Some("ERROR"){return Err(payload.pointer("/data/message").and_then(Value::as_str).unwrap_or("Discord RPC hatası.").into());}}},Err(e)=>{last=e;break;}}thread::sleep(Duration::from_millis(10));}}Err(if last.is_empty(){"Discord masaüstü IPC bağlantısı bulunamadı.".into()}else{last})}

fn presence_key(cfg:&Config,track:&Track)->String{let show=cfg.enabled&&track.playing&&!track.title.is_empty()&&(!cfg.selected_only||cfg.selected_playlist_ids.contains(&track.playlist_id));if !show{return String::new();}format!("{}\n{}\n{}\n{}\n{}\n{}",cfg.discord_app_id,track.video_id,track.title,track.artist,track.playlist_id,track.thumbnail)}

fn activity_value(cfg:&Config,track:&Track)->Value{let show=cfg.enabled&&track.playing&&!track.title.is_empty()&&(!cfg.selected_only||cfg.selected_playlist_ids.contains(&track.playlist_id));if !show{return Value::Null;}let mut obj=json!({"type":2,"details":truncate(&track.title,128),"state":truncate(&track.artist,128)});if track.duration>0.0{let start=now_secs() as f64-track.current_time;let end=start+track.duration;obj["timestamps"]=json!({"start":start.max(0.0) as u64,"end":end.max(0.0) as u64});}if track.thumbnail.starts_with("https://"){obj["assets"]=json!({"large_image":truncate(&track.thumbnail,300),"large_text":truncate(&track.title,128)});}if track.url.starts_with("http"){obj["buttons"]=json!([{"label":"YouTube'da Aç","url":track.url}]);}obj}
fn truncate(s:&str,max:usize)->String{s.chars().take(max).collect()}

fn run_discord(app:Arc<AppState>){let mut file:Option<File>=None;let mut connected_app=String::new();let mut buffer=Vec::new();let mut last_key="__initial__".to_string();let mut failures=0u32;while !app.stop.load(Ordering::Relaxed){let cfg=app.config.lock().unwrap().clone();let track=app.track.lock().unwrap().clone();if connected_app!=cfg.discord_app_id{if let Some(f)=file.as_mut(){let _=discord_write(f,1,&json!({"cmd":"SET_ACTIVITY","nonce":format!("clear-{}",now_ms()),"args":{"pid":std::process::id(),"activity":Value::Null}}));}file=None;buffer.clear();connected_app=cfg.discord_app_id.clone();last_key="__initial__".into();}
        if file.is_none()&&!cfg.discord_app_id.is_empty(){ {let mut d=app.discord.lock().unwrap();d.connected=false;d.connecting=true;if failures<3{d.error.clear();}} app.broadcast_state();match try_discord_connect(&cfg.discord_app_id){Ok((f,b))=>{file=Some(f);buffer=b;failures=0;last_key="__initial__".into();let mut d=app.discord.lock().unwrap();d.connected=true;d.connecting=false;d.error.clear();drop(d);app.broadcast_state();},Err(e)=>{failures+=1;let mut d=app.discord.lock().unwrap();d.connected=false;d.connecting=false;if failures>=3{d.error=e;}drop(d);app.broadcast_state();thread::sleep(Duration::from_millis(if failures<2{180}else{450}));continue;}}}
        if let Some(f)=file.as_mut(){match read_discord_frames(f,&mut buffer){Ok(frames)=>{let mut bad=false;for(op,payload)in frames{if op==3{if discord_write(f,4,&payload).is_err(){bad=true;break;}}else if op==2||(op==1&&payload.get("evt").and_then(Value::as_str)==Some("ERROR")){bad=true;break;}}if bad{file=None;let mut d=app.discord.lock().unwrap();d.connected=false;d.connecting=false;drop(d);app.broadcast_state();continue;}},Err(_)=>{file=None;let mut d=app.discord.lock().unwrap();d.connected=false;d.connecting=false;drop(d);app.broadcast_state();continue;}}
            let key=presence_key(&cfg,&track);if key!=last_key{let activity=activity_value(&cfg,&track);let body=json!({"cmd":"SET_ACTIVITY","nonce":format!("{}-{}",now_ms(),std::process::id()),"args":{"pid":std::process::id(),"activity":activity}});if discord_write(f,1,&body).is_ok(){last_key=key;}else{file=None;}}
        }
        thread::sleep(Duration::from_millis(100));}
    if let Some(mut f)=file{let _=discord_write(&mut f,1,&json!({"cmd":"SET_ACTIVITY","nonce":"shutdown","args":{"pid":std::process::id(),"activity":Value::Null}}));}}

// Minimal Win32 tray implementation: no WebView/Chromium is loaded in the background process.
type HWND=*mut c_void;type HINSTANCE=*mut c_void;type HICON=*mut c_void;type HCURSOR=*mut c_void;type HBRUSH=*mut c_void;type HMENU=*mut c_void;
#[repr(C)]struct POINT{x:i32,y:i32}
#[repr(C)]struct MSG{hwnd:HWND,message:u32,w_param:usize,l_param:isize,time:u32,pt:POINT,l_private:u32}
type WndProc=unsafe extern "system" fn(HWND,u32,usize,isize)->isize;
#[repr(C)]struct WNDCLASSW{style:u32,lpfn_wnd_proc:Option<WndProc>,cb_cls_extra:i32,cb_wnd_extra:i32,h_instance:HINSTANCE,h_icon:HICON,h_cursor:HCURSOR,hbr_background:HBRUSH,lpsz_menu_name:*const u16,lpsz_class_name:*const u16}
#[repr(C)]#[derive(Clone,Copy)]struct GUID{data1:u32,data2:u16,data3:u16,data4:[u8;8]}
#[repr(C)]struct NOTIFYICONDATAW{cb_size:u32,h_wnd:HWND,u_id:u32,u_flags:u32,u_callback_message:u32,h_icon:HICON,sz_tip:[u16;128],dw_state:u32,dw_state_mask:u32,sz_info:[u16;256],u_timeout_or_version:u32,sz_info_title:[u16;64],dw_info_flags:u32,guid_item:GUID,h_balloon_icon:HICON}

#[link(name="user32")]
extern "system"{fn RegisterClassW(c:*const WNDCLASSW)->u16;fn CreateWindowExW(ex:u32,class:*const u16,name:*const u16,style:u32,x:i32,y:i32,w:i32,h:i32,parent:HWND,menu:HMENU,instance:HINSTANCE,param:*mut c_void)->HWND;fn DefWindowProcW(hwnd:HWND,msg:u32,w:usize,l:isize)->isize;fn GetMessageW(msg:*mut MSG,hwnd:HWND,min:u32,max:u32)->i32;fn TranslateMessage(msg:*const MSG)->i32;fn DispatchMessageW(msg:*const MSG)->isize;fn DestroyWindow(hwnd:HWND)->i32;fn PostQuitMessage(code:i32);fn PostMessageW(hwnd:HWND,msg:u32,w:usize,l:isize)->i32;fn LoadIconW(instance:HINSTANCE,name:*const u16)->HICON;fn LoadImageW(instance:HINSTANCE,name:*const u16,kind:u32,cx:i32,cy:i32,flags:u32)->*mut c_void;fn CreatePopupMenu()->HMENU;fn AppendMenuW(menu:HMENU,flags:u32,id:usize,text:*const u16)->i32;fn GetCursorPos(point:*mut POINT)->i32;fn SetForegroundWindow(hwnd:HWND)->i32;fn TrackPopupMenu(menu:HMENU,flags:u32,x:i32,y:i32,reserved:i32,hwnd:HWND,rect:*const c_void)->i32;}
#[link(name="kernel32")]
extern "system"{fn GetModuleHandleW(name:*const u16)->HINSTANCE;}
#[link(name="shell32")]
extern "system"{fn Shell_NotifyIconW(message:u32,data:*mut NOTIFYICONDATAW)->i32;}
const WM_COMMAND:u32=0x0111;const WM_DESTROY:u32=0x0002;const WM_CLOSE:u32=0x0010;const WM_LBUTTONUP:u32=0x0202;const WM_RBUTTONUP:u32=0x0205;const NIM_ADD:u32=0;const NIM_DELETE:u32=2;const NIF_MESSAGE:u32=1;const NIF_ICON:u32=2;const NIF_TIP:u32=4;const MF_STRING:u32=0;const MF_CHECKED:u32=8;const TPM_RIGHTBUTTON:u32=2;const IMAGE_ICON:u32=1;const LR_LOADFROMFILE:u32=0x10;const LR_DEFAULTSIZE:u32=0x40;

fn wide(s:&str)->Vec<u16>{std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()}
unsafe extern "system" fn wnd_proc(hwnd:HWND,msg:u32,w:usize,l:isize)->isize{if let Some(app)=GLOBAL_APP.get(){if msg==WM_TRAY{let event=l as u32;if event==WM_LBUTTONUP{launch_ui(app);}else if event==WM_RBUTTONUP{show_tray_menu(hwnd,app);}return 0;}if msg==WM_COMMAND{match w&0xffff{CMD_OPEN=>launch_ui(app),CMD_TOGGLE=>{let mut cfg=app.config.lock().unwrap();cfg.enabled=!cfg.enabled;drop(cfg);app.save_config();app.broadcast_state();},CMD_EXIT=>{app.stop.store(true,Ordering::SeqCst);DestroyWindow(hwnd);},_=>{}}return 0;}if msg==WM_CLOSE{app.stop.store(true,Ordering::SeqCst);DestroyWindow(hwnd);return 0;}if msg==WM_DESTROY{PostQuitMessage(0);return 0;}}DefWindowProcW(hwnd,msg,w,l)}
unsafe fn show_tray_menu(hwnd:HWND,app:&AppState){let menu=CreatePopupMenu();if menu.is_null(){return;}let open=wide("TuneCord'u aç");AppendMenuW(menu,MF_STRING,CMD_OPEN,open.as_ptr());let toggle=wide("Discord'da göster");let checked=if app.config.lock().unwrap().enabled{MF_CHECKED}else{0};AppendMenuW(menu,MF_STRING|checked,CMD_TOGGLE,toggle.as_ptr());let exit=wide("Çıkış");AppendMenuW(menu,MF_STRING,CMD_EXIT,exit.as_ptr());let mut pt=POINT{x:0,y:0};GetCursorPos(&mut pt);SetForegroundWindow(hwnd);TrackPopupMenu(menu,TPM_RIGHTBUTTON,pt.x,pt.y,0,hwnd,null());}

fn run_tray(app:Arc<AppState>){unsafe{let instance=GetModuleHandleW(null());let class=wide("TuneCordNativeTray");let wc=WNDCLASSW{style:0,lpfn_wnd_proc:Some(wnd_proc),cb_cls_extra:0,cb_wnd_extra:0,h_instance:instance,h_icon:null_mut(),h_cursor:null_mut(),hbr_background:null_mut(),lpsz_menu_name:null(),lpsz_class_name:class.as_ptr()};RegisterClassW(&wc);let hwnd=CreateWindowExW(0,class.as_ptr(),wide("TuneCord").as_ptr(),0,0,0,0,0,null_mut(),null_mut(),instance,null_mut());if hwnd.is_null(){return;}app.tray_hwnd.store(hwnd as isize,Ordering::SeqCst);let icon_path=local_bin_dir().join("tunecord.ico");let icon=if icon_path.exists(){LoadImageW(null_mut(),wide(&icon_path.to_string_lossy()).as_ptr(),IMAGE_ICON,0,0,LR_LOADFROMFILE|LR_DEFAULTSIZE) as HICON}else{LoadIconW(null_mut(),32512usize as *const u16)};let mut data:NOTIFYICONDATAW=std::mem::zeroed();data.cb_size=std::mem::size_of::<NOTIFYICONDATAW>() as u32;data.h_wnd=hwnd;data.u_id=1;data.u_flags=NIF_MESSAGE|NIF_ICON|NIF_TIP;data.u_callback_message=WM_TRAY;data.h_icon=icon;let tip=wide("TuneCord");for(i,c)in tip.into_iter().take(127).enumerate(){data.sz_tip[i]=c;}Shell_NotifyIconW(NIM_ADD,&mut data);let mut msg:MSG=std::mem::zeroed();while GetMessageW(&mut msg,null_mut(),0,0)>0{TranslateMessage(&msg);DispatchMessageW(&msg);}Shell_NotifyIconW(NIM_DELETE,&mut data);}}

fn main(){
    let _=fs::create_dir_all(appdata_dir());
    let _=fs::create_dir_all(local_bin_dir());
    let listener=match TcpListener::bind(("127.0.0.1",PORT)){Ok(x)=>x,Err(_)=>return};
    let helper_path=env::current_exe().unwrap_or_else(|_|local_bin_dir().join("tunecord-helper.exe"));
    let mut cfg=load_config();
    let args:Vec<String>=env::args().collect();
    if let Some(i)=args.iter().position(|x|x=="--app-exe"){if let Some(v)=args.get(i+1){cfg.app_exe_path=v.clone();}}
    let app=Arc::new(AppState{config:Mutex::new(cfg),track:Mutex::new(Track::default()),discord:Mutex::new(DiscordStatus::default()),clients:Mutex::new(HashMap::new()),stop:AtomicBool::new(false),tray_hwnd:AtomicIsize::new(0),client_seq:AtomicU64::new(0),helper_path:helper_path.clone()});
    let _=GLOBAL_APP.set(app.clone());
    app.save_config();
    set_startup(app.config.lock().unwrap().startup,&helper_path);
    let s=app.clone();thread::spawn(move||run_server(s,listener));
    let d=app.clone();thread::spawn(move||run_discord(d));
    run_tray(app.clone());
    app.stop.store(true,Ordering::SeqCst);
    thread::sleep(Duration::from_millis(120));
}
