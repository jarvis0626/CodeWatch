"""Frozen service / MCP entrypoint. Never launches a desktop window."""

import argparse
import io
import json
import multiprocessing
import os
from pathlib import Path
import socket
import sys
import threading

from backend.integrations.discovery import read_discovery, write_discovery


def serve(discovery: Path) -> None:
    import uvicorn
    from backend.main import create_app

    token = os.environ.pop("CODEWATCH_DESKTOP_TOKEN", "")
    if len(token) < 32:
        raise ValueError("Desktop service must be started by CodeWatch")
    # Keep the bound socket open: no free-port lookup / rebind race.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    app = create_app(server_url=url, desktop_token=token, discovery_path=str(discovery))
    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started and not self.should_exit:
                write_discovery(discovery, url, token)
                print(json.dumps({"kind": "ready", "url": url}), flush=True)

    config = uvicorn.Config(
        app, log_level="warning", loop="asyncio", http="h11", ws="websockets", ws_max_size=2_000_000
    )
    server = ReadyServer(config)

    def cleanup_discovery():
        # A previous service must not remove a newer service's discovery record on restart.
        try:
            if read_discovery(discovery) == (url, token):
                discovery.unlink(missing_ok=True)
        except (OSError, ValueError, KeyError):
            pass

    def force_exit():
        cleanup_discovery()
        os._exit(0)

    def supervise():
        # A closed pipe means our owning Electron process exited or crashed.
        sys.stdin.readline()
        server.should_exit = True
        timer = threading.Timer(8, force_exit)
        timer.daemon = True
        timer.start()

    threading.Thread(target=supervise, daemon=True).start()
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()
        cleanup_discovery()


def main() -> None:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="CodeWatch packaged helper")
    parser.add_argument("action", choices=["serve", "mcp"])
    parser.add_argument("--discovery", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "serve":
        serve(args.discovery)
    else:
        run_mcp(args.discovery)


def run_mcp(discovery: Path) -> None:
    from backend.mcp_server import create_mcp

    # The SDK creates UTF-8 wrappers whose destruction closes their binary streams.
    # Give it duplicated descriptors so PyInstaller can still flush the original
    # standard streams at shutdown without a closed-file traceback.
    originals = (sys.stdin, sys.stdout)
    duplicates = []
    try:
        for stream, mode in zip(originals, ("rb", "wb"), strict=True):
            duplicates.append(io.TextIOWrapper(os.fdopen(os.dup(stream.fileno()), mode), encoding="utf-8"))
        sys.stdin, sys.stdout = duplicates
        # Resolve the current endpoint on each request, including after desktop restarts.
        create_mcp(discovery_path=str(discovery)).run(transport="stdio")
    finally:
        sys.stdin, sys.stdout = originals
        for stream in duplicates:
            if not stream.closed:
                stream.close()


if __name__ == "__main__":
    main()
