#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    env,
    fs,
    io::{self, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PORT: u16 = 37645;

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

fn caller_origin() -> String {
    env::args()
        .skip(1)
        .find(|arg| arg.starts_with("chrome-extension://") || arg.starts_with("moz-extension://"))
        .unwrap_or_else(|| "chrome-extension://mfhiohlcbedfhemkommfailjjfkdfobe/".to_string())
}

fn caller_extension_id(origin: &str) -> String {
    origin
        .split_once("://")
        .map(|(_, rest)| rest.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "mfhiohlcbedfhemkommfailjjfkdfobe".to_string())
}

fn browser_family(origin: &str) -> &'static str {
    if origin.starts_with("moz-extension://") { "firefox" } else { "chromium" }
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

fn websocket_handshake(stream: &mut TcpStream) -> Result<(), String> {
    let request = concat!(
        "GET /ws HTTP/1.1\r\n",
        "Host: 127.0.0.1:37645\r\n",
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Version: 13\r\n",
        "Sec-WebSocket-Key: dHVuZWNvcmQtbmF0aXZlIQ==\r\n",
        "\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut header = Vec::with_capacity(512);
    let mut one = [0u8; 1];
    while header.len() < 32 * 1024 {
        stream.read_exact(&mut one).map_err(|e| e.to_string())?;
        header.push(one[0]);
        if header.ends_with(b"\r\n\r\n") { break; }
    }
    let text = String::from_utf8_lossy(&header);
    if !text.starts_with("HTTP/1.1 101") {
        return Err(format!("TuneCord WebSocket handshake reddedildi: {}", text.lines().next().unwrap_or("yanıt yok")));
    }
    Ok(())
}

fn mask_key() -> [u8; 4] {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mixed = (now as u64) ^ ((process::id() as u64) << 17);
    [mixed as u8, (mixed >> 8) as u8, (mixed >> 16) as u8, (mixed >> 24) as u8]
}

fn send_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mask = mask_key();
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x80 | (opcode & 0x0f));
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(*byte ^ mask[index % 4]);
    }
    stream.write_all(&frame)?;
    stream.flush()
}

fn send_ws_json(stream: &mut TcpStream, value: &Value) -> io::Result<()> {
    let text = value.to_string();
    send_ws_frame(stream, 0x1, text.as_bytes())
}

fn read_ws_json(stream: &mut TcpStream) -> Result<Option<Value>, String> {
    loop {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).map_err(|e| e.to_string())?;
        let opcode = head[0] & 0x0f;
        let masked = head[1] & 0x80 != 0;
        let mut len = (head[1] & 0x7f) as u64;
        if len == 126 {
            let mut buf = [0u8; 2];
            stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
            len = u16::from_be_bytes(buf) as u64;
        } else if len == 127 {
            let mut buf = [0u8; 8];
            stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
            len = u64::from_be_bytes(buf);
        }
        if len > 4 * 1024 * 1024 { return Err("TuneCord WebSocket frame çok büyük.".into()); }
        let mut mask = [0u8; 4];
        if masked { stream.read_exact(&mut mask).map_err(|e| e.to_string())?; }
        let mut data = vec![0u8; len as usize];
        stream.read_exact(&mut data).map_err(|e| e.to_string())?;
        if masked {
            for (index, byte) in data.iter_mut().enumerate() { *byte ^= mask[index % 4]; }
        }
        match opcode {
            0x1 => {
                let value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
                return Ok(Some(value));
            }
            0x8 => return Ok(None),
            0x9 => { send_ws_frame(stream, 0xA, &data).map_err(|e| e.to_string())?; }
            _ => {}
        }
    }
}

fn connect_backend(origin: &str) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{PORT}").parse().map_err(|e: std::net::AddrParseError| e.to_string())?,
        Duration::from_millis(900),
    ).map_err(|_| "TuneCord uygulaması bulunamadı.".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    websocket_handshake(&mut stream)?;

    let hello_id = format!("native-hello-{}", process::id());
    let mut token = bridge_token();
    let extension_id = caller_extension_id(origin);
    let family = browser_family(origin);

    for _ in 0..2 {
        send_ws_json(&mut stream, &json!({
            "id": hello_id,
            "type": "hello",
            "token": token,
            "extensionId": extension_id,
            "browserFamily": family
        })).map_err(|e| e.to_string())?;

        loop {
            let Some(reply) = read_ws_json(&mut stream)? else { return Err("TuneCord bağlantıyı kapattı.".into()); };
            if reply.get("id").and_then(Value::as_str) != Some(&hello_id) { continue; }
            if reply.get("ok").and_then(Value::as_bool) == Some(true) { return Ok(stream); }
            if reply.get("code").and_then(Value::as_str) == Some("PAIR_REQUIRED") {
                if let Some(next) = reply.get("token").and_then(Value::as_str) {
                    token = next.to_string();
                    break;
                }
            }
            return Err(reply.get("error").and_then(Value::as_str).unwrap_or("TuneCord eşleşmesi başarısız.").to_string());
        }
    }
    Err("TuneCord eşleşmesi tamamlanamadı.".into())
}

fn error_reply(id: Value, message: impl Into<String>) -> Value {
    json!({"id": id, "ok": false, "error": message.into()})
}

fn main() {
    let origin = caller_origin();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut backend: Option<TcpStream> = None;

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

        if backend.is_none() {
            match connect_backend(&origin) {
                Ok(stream) => backend = Some(stream),
                Err(error) => {
                    let _ = write_native_message(&mut output, &error_reply(id, error));
                    continue;
                }
            }
        }

        let stream = backend.as_mut().unwrap();
        if let Err(error) = send_ws_json(stream, &message) {
            backend = None;
            let _ = write_native_message(&mut output, &error_reply(id, error.to_string()));
            continue;
        }

        loop {
            match read_ws_json(stream) {
                Ok(Some(reply)) => {
                    let is_response = reply.get("id") == Some(&id) && !id.is_null();
                    if write_native_message(&mut output, &reply).is_err() { return; }
                    if is_response { break; }
                }
                Ok(None) => {
                    backend = None;
                    let _ = write_native_message(&mut output, &error_reply(id, "TuneCord bağlantısı kapandı."));
                    break;
                }
                Err(error) => {
                    backend = None;
                    let _ = write_native_message(&mut output, &error_reply(id, error));
                    break;
                }
            }
        }
    }
}
