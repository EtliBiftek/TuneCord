from pathlib import Path

path = Path("native-helper/src/main.rs")
text = path.read_text(encoding="utf-8")
changes = []

timeout_needle = "    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
timeout_replacement = "    stream.set_read_timeout(None)?;\n    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
if timeout_replacement not in text:
    if timeout_needle not in text:
        raise SystemExit("native-helper timeout patch target not found")
    text = text.replace(timeout_needle, timeout_replacement, 1)
    changes.append("cleared WebSocket read timeout")

open_needle = "            app.save_config(); let _=open_browser_page(&browser,&extensions_url); app.broadcast_state();"
open_replacement = "            app.save_config(); app.broadcast_state();"
if open_needle in text:
    text = text.replace(open_needle, open_replacement, 1)
    changes.append("disabled automatic browser opening after extension preparation")
elif open_replacement not in text:
    raise SystemExit("native-helper browser-open patch target not found")

path.write_text(text, encoding="utf-8")
print("Native helper patches: " + (", ".join(changes) if changes else "already applied"))
