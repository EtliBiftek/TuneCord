from pathlib import Path

path = Path("native-helper/src/main.rs")
text = path.read_text(encoding="utf-8")
changes = []

# HTTP parser uses a short timeout while reading request headers. Do not let
# that timeout leak into the legacy WebSocket path.
timeout_needle = "    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
timeout_replacement = "    stream.set_read_timeout(None)?;\n    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
if timeout_replacement not in text:
    if timeout_needle not in text:
        raise SystemExit("native-helper timeout patch target not found")
    text = text.replace(timeout_needle, timeout_replacement, 1)
    changes.append("cleared WebSocket read timeout")

# Preparing extension files must never open a browser. The explicit
# 'Eklenti sayfasını aç' action remains available through /api/launch-browser.
open_needle = "            app.save_config(); let _=open_browser_page(&browser,&extensions_url); app.broadcast_state();"
open_replacement = "            app.save_config(); app.broadcast_state();"
if open_needle in text:
    text = text.replace(open_needle, open_replacement, 1)
    changes.append("disabled automatic browser opening after extension preparation")
elif open_replacement not in text:
    raise SystemExit("native-helper browser-open patch target not found")

# Native Messaging now uses one short-lived loopback HTTP request per browser
# message. This avoids stale/persistent TCP sockets and WSAECONNRESET 10054.
connected_needle = '            "extensionConnected": !self.clients.lock().unwrap().is_empty(),'
connected_replacement = '            "extensionConnected": cfg.extra.get("extensionLastSeenMs").and_then(Value::as_u64).map(|seen| (now_ms() as u64).saturating_sub(seen) < 10_000).unwrap_or(false) || !self.clients.lock().unwrap().is_empty(),'
if connected_needle in text:
    text = text.replace(connected_needle, connected_replacement, 1)
    changes.append("tracked native extension heartbeat")
elif connected_replacement not in text:
    raise SystemExit("native-helper extensionConnected patch target not found")

transport_needle = '            "transport": "websocket-native",'
transport_replacement = '            "transport": "native-messaging-http",'
if transport_needle in text:
    text = text.replace(transport_needle, transport_replacement, 1)
    changes.append("updated transport state")

native_anchor = '        ("POST","/api/shutdown") => { app.stop.store(true,Ordering::SeqCst);'
native_marker = '("POST","/api/native")'
if native_marker not in text:
    if native_anchor not in text:
        raise SystemExit("native-helper /api/native insertion target not found")
    native_endpoint = r'''        ("POST","/api/native") => (|| -> Result<Value,String> {
            let id=data.get("id").cloned().unwrap_or(Value::Null);
            let typ=data.get("type").and_then(Value::as_str).unwrap_or("").to_string();
            let extension_id=data.get("extensionId").and_then(Value::as_str).unwrap_or("").to_string();
            let family=data.get("browserFamily").and_then(Value::as_str).unwrap_or("chromium").to_string();
            let token=data.get("token").and_then(Value::as_str).unwrap_or("").to_string();
            {
                let mut cfg=app.config.lock().unwrap();
                let known=extension_id==CHROMIUM_EXTENSION_ID||extension_id==FIREFOX_EXTENSION_ID;
                let family_ok=cfg.extension_installed && family==cfg.selected_browser_family && !extension_id.is_empty();
                if !known&&!family_ok {
                    return Ok(json!({"id":id,"ok":false,"code":"BAD_EXTENSION","error":"TuneCord eklentisi doğrulanamadı."}));
                }
                if token!=cfg.bridge_token {
                    return Ok(json!({"id":id,"ok":false,"code":"PAIR_REQUIRED","token":cfg.bridge_token}));
                }
                cfg.extra.insert("extensionLastSeenMs".into(),json!(now_ms() as u64));
            }
            match typ.as_str() {
                "getStatus" => Ok(json!({"id":id,"ok":true,"state":app.state_json()})),
                "ping" => Ok(json!({"id":id,"ok":true,"pong":now_ms(),"state":app.state_json()})),
                "track" => {
                    if let Some(value)=data.get("track") {
                        let track=serde_json::from_value::<Track>(value.clone()).map_err(|_|"Geçersiz parça bilgisi.".to_string())?;
                        *app.track.lock().unwrap()=track;
                    }
                    app.broadcast_state();
                    Ok(json!({"id":id,"ok":true,"state":app.state_json()}))
                },
                "stop" => {
                    *app.track.lock().unwrap()=Track::default();
                    app.broadcast_state();
                    Ok(json!({"id":id,"ok":true,"state":app.state_json()}))
                },
                "setControl" => {
                    let control=data.get("control").cloned().unwrap_or_else(||json!({}));
                    {
                        let mut cfg=app.config.lock().unwrap();
                        if let Some(v)=control.get("enabled").and_then(Value::as_bool){cfg.enabled=v;}
                        if let Some(v)=control.get("selectedOnly").and_then(Value::as_bool){cfg.selected_only=v;}
                        if let Some(v)=control.get("discordAppId").and_then(Value::as_str){if v.len()>=17&&v.len()<=22&&v.chars().all(|c|c.is_ascii_digit()){cfg.discord_app_id=v.into();}}
                        if control.get("resetDiscordAppId").and_then(Value::as_bool)==Some(true){cfg.discord_app_id=DEFAULT_DISCORD_APP_ID.into();}
                        if let Some(a)=control.get("selectedPlaylistIds").and_then(Value::as_array){cfg.selected_playlist_ids=a.iter().filter_map(Value::as_str).map(str::to_string).collect();}
                    }
                    app.save_config(); app.broadcast_state();
                    Ok(json!({"id":id,"ok":true,"state":app.state_json()}))
                },
                "playlists" => {
                    if let Some(items)=data.get("items").and_then(Value::as_array){
                        let mut cfg=app.config.lock().unwrap();
                        cfg.playlists=items.iter().filter_map(|v|serde_json::from_value(v.clone()).ok()).collect();
                        let ids:Vec<String>=cfg.playlists.iter().map(|x|x.id.clone()).collect();
                        cfg.selected_playlist_ids.retain(|playlist_id|ids.contains(playlist_id));
                    }
                    app.save_config(); app.broadcast_state();
                    Ok(json!({"id":id,"ok":true,"state":app.state_json()}))
                },
                _ => Ok(json!({"id":id,"ok":false,"error":"Bilinmeyen Native Messaging isteği."}))
            }
        })(),
'''
    text = text.replace(native_anchor, native_endpoint + native_anchor, 1)
    changes.append("added stateless /api/native bridge")

path.write_text(text, encoding="utf-8")
print("Native helper patches: " + (", ".join(changes) if changes else "already applied"))
