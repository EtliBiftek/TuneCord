import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "native-helper" / "target" / "release" / "tunecord-helper.exe"
HOST = ROOT / "native-host" / "target" / "release" / "tunecord-native-host.exe"
PORT = 37645


def wait_for_port(timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("TuneCord helper did not open port 37645")


def read_exact(stream, size):
    data = b""
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise RuntimeError("Native host closed stdout early")
        data += chunk
    return data


def native_roundtrip(proc, message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    proc.stdin.write(struct.pack("=I", len(payload)))
    proc.stdin.write(payload)
    proc.stdin.flush()
    size = struct.unpack("=I", read_exact(proc.stdout, 4))[0]
    if size <= 0 or size > 1024 * 1024:
        raise RuntimeError(f"Invalid native response length: {size}")
    return json.loads(read_exact(proc.stdout, size).decode("utf-8"))


def shutdown_helper():
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=2).read()
    except Exception:
        pass


def main():
    if not HELPER.exists() or not HOST.exists():
        raise RuntimeError("Native bridge binaries were not built")

    env = os.environ.copy()
    helper = subprocess.Popen([str(HELPER), "--background"], env=env)
    host = None
    try:
        wait_for_port()
        host = subprocess.Popen(
            [str(HOST)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        reply = native_roundtrip(host, {"id": "ci-ping", "type": "ping", "browserFamily": "chromium"})
        if reply.get("ok") is not True or reply.get("id") != "ci-ping":
            raise RuntimeError(f"Native bridge ping failed: {reply}")

        status = native_roundtrip(host, {"id": "ci-status", "type": "getStatus", "browserFamily": "chromium"})
        if status.get("ok") is not True or status.get("state", {}).get("transport") != "native-messaging-http":
            raise RuntimeError(f"Native bridge status failed: {status}")

        print("Native Messaging -> native host -> loopback HTTP -> helper smoke test passed")
    finally:
        if host is not None:
            try:
                host.stdin.close()
            except Exception:
                pass
            try:
                host.wait(timeout=2)
            except Exception:
                host.kill()
        shutdown_helper()
        try:
            helper.wait(timeout=3)
        except Exception:
            helper.kill()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise
