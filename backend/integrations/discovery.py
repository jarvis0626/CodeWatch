"""Per-user desktop discovery. Windows credentials are protected with DPAPI."""

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile


MAX_DISCOVERY_BYTES = 16_384


def _validate_token(token: str) -> None:
    if not isinstance(token, str) or not 32 <= len(token) <= 512 or not token.isascii():
        raise ValueError("Desktop discovery credential is invalid")
    if any(character.isspace() or ord(character) < 33 or ord(character) > 126 for character in token):
        raise ValueError("Desktop discovery credential is invalid")


class _Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, *, decrypt: bool = False) -> bytes:
    buffer = ctypes.create_string_buffer(data)
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    target = _Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [
        ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob),
    ]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        kernel.LocalFree(target.data)


def write_discovery(path: Path, server_url: str, token: str) -> None:
    _validate_token(token)
    secret = token.encode("utf-8")
    windows = os.name == "nt"
    if windows:
        secret = _dpapi(secret)
    payload = {"version": 1, "serverUrl": server_url, "protection": "dpapi" if windows else "user-file",
               "credential": base64.b64encode(secret).decode("ascii")}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            json.dump(payload, handle)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_discovery(path: Path) -> tuple[str, str]:
    with path.open("rb") as handle:
        raw = handle.read(MAX_DISCOVERY_BYTES + 1)
    if len(raw) > MAX_DISCOVERY_BYTES:
        raise ValueError("Desktop discovery is invalid")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Desktop discovery is invalid")
    if payload.get("version") != 1:
        raise ValueError("Desktop discovery version is unsupported")
    if not isinstance(payload.get("credential"), str) or not isinstance(payload.get("serverUrl"), str):
        raise ValueError("Desktop discovery is invalid")
    secret = base64.b64decode(payload["credential"], validate=True)
    if payload["protection"] == "dpapi" and os.name == "nt":
        secret = _dpapi(secret, decrypt=True)
    elif payload["protection"] != "user-file" or os.name == "nt":
        raise ValueError("Desktop discovery credential protection is unsupported")
    token = secret.decode("utf-8")
    _validate_token(token)
    return payload["serverUrl"], token
