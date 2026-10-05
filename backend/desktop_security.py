"""Authentication for the owned desktop service; source CLI remains compatible."""

import secrets
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

MAX_BODY_BYTES = 2_000_000


class DesktopBoundary:
    def __init__(self, app, token: str, server_url: str):
        self.app = app
        self.token = token.encode("utf-8")
        self.server_url = server_url
        self.host = urlsplit(server_url).netloc

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin", b"").decode("latin1")
        host = headers.get(b"host", b"").decode("latin1")
        cookie = SimpleCookie()
        try:
            cookie.load(headers.get(b"cookie", b"").decode("latin1"))
        except Exception:
            pass
        credential = headers.get(b"authorization", b"").decode("latin1")
        if credential.startswith("Bearer "):
            credential = credential[7:]
        else:
            credential = cookie["codewatch_auth"].value if "codewatch_auth" in cookie else ""
        allowed = host == self.host and (not origin or origin == self.server_url)
        if not allowed or not secrets.compare_digest(credential.encode("utf-8"), self.token):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await JSONResponse({"detail": "Desktop connection denied"}, status_code=403)(
                    scope, receive, send
                )
            return
        if scope["type"] == "websocket":
            return await self.app(scope, receive, send)
        length = headers.get(b"content-length", b"0")
        if not length.isdigit() or len(length) > 16 or int(length) > MAX_BODY_BYTES:
            await self.reject_size(scope, receive, send)
            return

        # Enforce the limit on received bytes too: chunked bodies have no Content-Length.
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                await self.reject_size(scope, receive, send)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)

    @staticmethod
    async def reject_size(scope, receive, send):
        await JSONResponse({"detail": "Payload too large"}, status_code=413)(scope, receive, send)
