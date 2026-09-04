use serde_json::{json, Map, Value};
use std::{
    env,
    fs,
    io::{self, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};

const PORT: u16 = 37645;
const CHROMIUM_EXTENSION_ID: &str = "mfhiohlcbedfhemkommfailjjfkdfobe";
const FIREFOX_EXTENSION_ID: &str = "tunecord@etlibiftek.local";

fn appdata_dir() -> PathBuf {
    let root = env::var_os("APPDATA")
        .or_else(|| env::var_os("LOCALAPPDATA"))
        .unwrap_or_default();
    PathBuf::from(root).join("TuneCord")
}

fn bridge_token() -> String {
    fs::read_to_string(appdata_dir().join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("bridgeToken").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default()
}

#[derive(Clone)]
struct Caller {
    extension_id: String,
    family: &'static str,
}

fn caller() -> Caller {
    let args: Vec<String> = env::args().skip(1).collect();

    if let Some(origin) = args.iter().find(|arg| arg.starts_with("chrome-extension://")) {
        let extension_id = origin
            .split_once("://")
            .map(|(_, rest)| rest.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| CHROMIUM_EXTENSION_ID.to_string());
        return Caller { extension_id, family: "chromium" };
    }

    // Firefox passes the native-host manifest path followed by the add-on ID,
    // rather than Chrome's chrome-extension:// origin argument.
    if args.iter().any(|arg| arg == FIREFOX_EXTENSION_ID) {
        return Caller { extension_id: FIREFOX_EXTENSION_ID.to_string(), family: "firefox" };
    }

    Caller { extension_id: CHROMIUM_EXTENSION_ID.to_string(), family: "chromium" }
}

fn read_native_message<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_ne_bytes(len_buf) as usize;
    if len == 0 || len > 64 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid native message length"));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_native_message<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "native response too large"));
    }
    writer.write_all(&(payload.len() as u32).to_ne_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

fn http_post_json(path: &str, value: &Value) -> Result<Value, String> {
    let address = format!("127.0.0.1:{PORT}").parse().map_err(|e: std::net::AddrParseError| e.to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(900))
        .map_err(|_| "TuneCord uygulaması bulunamadı.".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);

    let payload = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let header = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(&payload).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset && !response.is_empty() => break,
            Err(error) => return Err(error.to_string()),
        }
        if response.len() > 8 * 1024 * 1024 {
            return Err("TuneCord yerel servis yanıtı çok büyük.".into());
        }
    }

    let header_end = find_header_end(&response).ok_or_else(|| "TuneCord yerel servisinden geçersiz HTTP yanıtı geldi.".to_string())?;
    let header_text = String::from_utf8_lossy(&response[..header_end]);
    let status_ok = header_text.lines().next().map(|line| line.contains(" 200 ")).unwrap_or(false);
    let content_length = header_text
        .lines()
        .find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("content-length")))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok());
    let body = &response[header_end..];
    if let Some(expected) = content_length {
        if body.len() < expected {
            return Err("TuneCord yerel servis yanıtı yarıda kesildi.".into());
        }
    }
    let parsed = serde_json::from_slice::<Value>(body).map_err(|e| format!("TuneCord yerel servis JSON hatası: {e}"))?;
    if !status_ok {
        return Err(parsed.get("error").and_then(Value::as_str).unwrap_or("TuneCord yerel servis isteği başarısız.").to_string());
    }
    Ok(parsed)
}

fn decorate_message(message: &Value, caller: &Caller, token: &str) -> Result<Value, String> {
    let mut object: Map<String, Value> = message.as_object().cloned().ok_or_else(|| "Native Messaging isteği JSON nesnesi değil.".to_string())?;
    object.insert("extensionId".into(), Value::String(caller.extension_id.clone()));
    object.insert("browserFamily".into(), Value::String(caller.family.to_string()));
    object.insert("token".into(), Value::String(token.to_string()));
    Ok(Value::Object(object))
}

fn request_backend(message: &Value, caller: &Caller) -> Result<Value, String> {
    let mut token = bridge_token();
    let mut last_error = "TuneCord yerel köprüsüne bağlanılamadı.".to_string();

    for _ in 0..3 {
        let request = decorate_message(message, caller, &token)?;
        match http_post_json("/api/native", &request) {
            Ok(reply) => {
                if reply.get("code").and_then(Value::as_str) == Some("PAIR_REQUIRED") {
                    if let Some(next) = reply.get("token").and_then(Value::as_str) {
                        token = next.to_string();
                        continue;
                    }
                }
                return Ok(reply);
            }
            Err(error) => {
                last_error = error;
                std::thread::sleep(Duration::from_millis(60));
            }
        }
    }
    Err(last_error)
}

fn error_reply(id: Value, message: impl Into<String>) -> Value {
    json!({"id": id, "ok": false, "error": message.into()})
}

fn main() {
    let caller = caller();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();

    loop {
        let message = match read_native_message(&mut input) {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(error) => {
                let _ = write_native_message(&mut output, &error_reply(Value::Null, error.to_string()));
                break;
            }
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let reply = match request_backend(&message, &caller) {
            Ok(value) => value,
            Err(error) => error_reply(id, error),
        };
        if write_native_message(&mut output, &reply).is_err() {
            break;
        }
    }
}
