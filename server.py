"""Local server for the Versant practice trainer.

Serves the practice app and exposes POST /api/winh, which presses Win+H so
Windows voice typing opens in the answer box the page has just focused.

Run:  python server.py            (opens Edge when available, otherwise the default browser)
      python server.py --no-browser
"""

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
PAGE_TITLE_MARKER = "Versant Practice"

IS_WINDOWS = sys.platform == "win32"
_send_lock = threading.Lock()
_voice_target = None

if IS_WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)

    INPUT_KEYBOARD = 1
    KEYEVENTF_KEYUP = 0x0002
    VK_LWIN = 0x5B
    VK_H = 0x48
    ULONG_PTR = ctypes.c_size_t

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]

    user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
    user32.SendInput.restype = wintypes.UINT
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
    user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    def input_host_has_focus():
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(pid))
        handle = kernel32.OpenProcess(0x1000, False, pid.value)
        if not handle:
            return False
        try:
            size = wintypes.DWORD(32768)
            name = ctypes.create_unicode_buffer(size.value)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
                return False
            return Path(name.value).name.lower() in ("textinputhost.exe", "inputapp.exe")
        finally:
            kernel32.CloseHandle(handle)

    def _key(vk, up=False):
        item = INPUT(type=INPUT_KEYBOARD)
        item.ki = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP if up else 0, time=0, dwExtraInfo=0)
        return item

    def window_title(hwnd):
        if not hwnd:
            return ""
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        return buf.value

    def foreground_title():
        return window_title(user32.GetForegroundWindow())

    def press_win_h():
        seq = (INPUT * 4)(_key(VK_LWIN), _key(VK_H), _key(VK_H, up=True), _key(VK_LWIN, up=True))
        sent = user32.SendInput(4, seq, ctypes.sizeof(INPUT))
        return sent == 4


def trigger_win_h(delay_ms):
    if not IS_WINDOWS:
        return {"ok": False, "reason": "not_windows"}
    delay_ms = max(0, min(int(delay_ms), 2000))
    with _send_lock:
        if delay_ms:
            time.sleep(delay_ms / 1000)
        # Voice typing writes into whatever has focus, so only fire while the
        # trainer tab is the active window.
        title = foreground_title()
        if PAGE_TITLE_MARKER not in title:
            return {"ok": False, "reason": "not_foreground", "window": title}
        if not press_win_h():
            return {"ok": False, "reason": "sendinput_failed"}
    return {"ok": True}


def inspect_voice_typing(action="inspect"):
    """UI Automation is a best-effort adapter to the system panel, not a speech API."""
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(ROOT / "voice_typing.ps1"), "-Action", action],
            capture_output=True, text=True, timeout=4,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return json.loads(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {"state": "unavailable", "activated": False}


def ensure_voice_typing(open_hint=False):
    global _voice_target
    if not IS_WINDOWS:
        return {"ok": False, "reason": "not_windows"}
    with _send_lock:
        status = None
        if PAGE_TITLE_MARKER not in foreground_title():
            # A voice-panel button can own foreground focus. Only hand it back
            # to the trainer that opened this session, with a recognised panel.
            if not (open_hint and _voice_target and input_host_has_focus()
                    and PAGE_TITLE_MARKER in window_title(_voice_target)):
                return {"ok": False, "reason": "not_foreground"}
            status = inspect_voice_typing()
            if status["state"] not in ("listening", "paused"):
                return {"ok": False, "reason": "voice_state_unknown", "panelOpen": True}
            user32.SetForegroundWindow(_voice_target)
            if user32.GetForegroundWindow() != _voice_target:
                return {"ok": False, "reason": "not_foreground", "panelOpen": True}
        target = user32.GetForegroundWindow()
        _voice_target = target
        if status is None:
            status = inspect_voice_typing()
        opened = False
        # Never toggle an existing panel just because its listening state is unknown.
        if status["state"] == "closed" or (status["state"] == "unavailable" and not open_hint):
            if PAGE_TITLE_MARKER not in foreground_title():
                return {"ok": False, "reason": "not_foreground"}
            if not press_win_h():
                return {"ok": False, "reason": "sendinput_failed"}
            opened = True
            time.sleep(0.35)
            status = inspect_voice_typing()
        if status["state"] == "paused":
            # Recheck the actual control in the helper before invoking it.
            if user32.GetForegroundWindow() == target or input_host_has_focus():
                status = inspect_voice_typing("resume")
        if opened or status.get("activated"):
            # InvokePattern normally leaves focus alone. Restore only if focus moved
            # to the same Windows input host, never over a different user application.
            if user32.GetForegroundWindow() == target or input_host_has_focus():
                user32.SetForegroundWindow(target)
        listening = status["state"] == "listening"
        return {"ok": listening or bool(status.get("activated")), "state": status["state"],
                "panelOpen": opened or status["state"] in ("listening", "paused", "starting", "unknown") or bool(open_hint),
                "reason": None if listening or status.get("activated") else "voice_state_unknown"}


class Handler(SimpleHTTPRequestHandler):
    server_version = "VersantTrainer/1.0"

    def translate_path(self, path):
        clean = unquote(path.split("?", 1)[0].split("#", 1)[0])
        if clean.startswith("/data/"):
            base, rel = DATA_DIR, clean[len("/data/"):]
        else:
            base, rel = STATIC_DIR, clean.lstrip("/")
        base = base.resolve()
        target = (base / rel).resolve()
        if target != base and base not in target.parents:
            return str(base / "__not_found__")
        return str(target)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        if str(getattr(code, "value", code)).startswith(("4", "5")):
            super().log_request(code, size)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_allowed(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        port = self.server.server_address[1]
        return origin in (f"http://{HOST}:{port}", f"http://localhost:{port}")

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/health":
            return self._json(200, {"ok": True, "winh": IS_WINDOWS})
        return super().do_GET()

    def do_POST(self):
        endpoint = self.path.split("?", 1)[0]
        if endpoint not in ("/api/winh", "/api/voice/ensure"):
            return self._json(404, {"ok": False, "reason": "not_found"})
        if not self._origin_allowed() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(403, {"ok": False, "reason": "forbidden"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 1024)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"ok": False, "reason": "bad_request"})
        if endpoint == "/api/voice/ensure":
            return self._json(200, ensure_voice_typing(payload.get("panelOpen") is True))
        return self._json(200, trigger_win_h(payload.get("delayMs", 200)))


def open_browser(url):
    if IS_WINDOWS:
        candidates = [shutil.which("msedge.exe")]
        candidates.extend(
            str(Path(folder) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
            for folder in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"), os.environ.get("LOCALAPPDATA"))
            if folder
        )
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                try:
                    subprocess.Popen([candidate, url], creationflags=subprocess.CREATE_NO_WINDOW)
                    return True
                except OSError:
                    continue
    return webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description="Versant practice trainer")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser automatically")
    args = parser.parse_args()

    httpd = ThreadingHTTPServer((HOST, args.port), Handler)
    url = f"http://{HOST}:{args.port}/"
    print(f"Versant practice trainer running at {url}")
    if not args.no_browser:
        print("Opening Edge if installed, otherwise your default browser. Open the address above manually if needed.")
    print("Keep this window open. Press Ctrl+C to stop.")
    if not IS_WINDOWS:
        print("Note: Win+H voice typing is only available on Windows.")
    if not args.no_browser:
        threading.Timer(0.6, open_browser, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
