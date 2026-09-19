"""Shared loopback HTTP client for MCP and CLI reporting; standard library only."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


DEFAULT_SERVER_URL = "http://127.0.0.1:8000"


class BridgeError(RuntimeError):
    """An actionable backend failure suitable for an MCP tool error or CLI message."""


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CodeWatchClient:
    """Small bounded HTTP client. It never opens project files or executes commands."""

    def __init__(self, server_url: str = DEFAULT_SERVER_URL, timeout: float = 15):
        parts = urlsplit(server_url)
        if (
            parts.scheme not in {"http", "https"}
            or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parts.username is not None
            or parts.password is not None
            or parts.path not in {"", "/"}
            or parts.query
            or parts.fragment
        ):
            raise ValueError(
                "CodeWatch server URL must be a loopback HTTP(S) origin, such as http://127.0.0.1:8000"
            )
        # Validate a supplied port now, rather than failing inside a tool call.
        _ = parts.port
        self.server_url = server_url.rstrip("/")
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirects())

    def request(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            self.server_url + path,
            data=body,
            method=method,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise BridgeError("CodeWatch returned an oversized response. Check the local backend.")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise BridgeError("CodeWatch returned an invalid response. Check the local backend.")
                return result
        except HTTPError as exc:
            try:
                detail = json.loads(exc.read(8000)).get("detail", exc.reason)
            except (ValueError, AttributeError):
                detail = exc.reason
            if exc.code == 409:
                hint = " Check codewatch_status or the current session; keep reports attached to the original run_id."
            elif exc.code == 404:
                hint = " Check that the current CodeWatch backend is running."
            else:
                hint = ""
            raise BridgeError(f"CodeWatch rejected the report ({exc.code}): {detail}.{hint}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise BridgeError(
                f"Cannot reach CodeWatch at {self.server_url}. Start the CodeWatch backend and retry."
            ) from exc
        except (ValueError, UnicodeDecodeError) as exc:
            raise BridgeError(
                "CodeWatch returned invalid JSON. Check the local backend URL and version."
            ) from exc
