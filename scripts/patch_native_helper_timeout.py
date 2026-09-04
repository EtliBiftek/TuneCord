from pathlib import Path

path = Path("native-helper/src/main.rs")
text = path.read_text(encoding="utf-8")
needle = "    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
replacement = "    stream.set_read_timeout(None)?;\n    Ok((method,path,headers,body))\n}\n\nfn find_bytes"
if needle not in text:
    raise SystemExit("native-helper timeout patch target not found")
path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")
print("Cleared HTTP read timeout before WebSocket upgrade")
