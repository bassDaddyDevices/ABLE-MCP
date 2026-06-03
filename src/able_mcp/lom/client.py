"""Async JSON-RPC 2.0 client for the ABLE-MCP M4L bridge.

Connects to ``ws://<host>:<port>`` (default ``127.0.0.1:9831``), correlates
request/response pairs by ``id``, and tolerates the bridge's ``bridge.hello``
notification on connect.

Usage::

    async with BridgeClient.from_env() as client:
        state = await client.call("song.getState")

The client is single-connection, single-task safe. Each :meth:`call` uses the
shared connection and an :class:`asyncio.Future` keyed by request id; the
background reader task fans responses back to the right caller.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection, connect

from ..config import BridgeConfig, load_bridge_config

log = logging.getLogger("able_mcp.lom")


class BridgeError(RuntimeError):
    """Raised when the bridge returns a JSON-RPC error or violates the protocol."""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


class BridgeUnavailable(BridgeError):
    """Raised when we can't reach the bridge (connection refused, timeout, etc.)."""


class BridgeClient:
    """Single-connection JSON-RPC client.

    Not safe to share across event loops, but multiple coroutines on one loop
    may call :meth:`call` concurrently — pending requests are tracked in a
    map keyed by id.
    """

    def __init__(self, config: BridgeConfig) -> None:
        self._config = config
        self._ws: ClientConnection | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._id_iter = itertools.count(1)
        self._closed = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @classmethod
    def from_env(cls) -> BridgeClient:
        return cls(load_bridge_config())

    @property
    def config(self) -> BridgeConfig:
        return self._config

    @property
    def url(self) -> str:
        return self._config.url

    async def connect(self) -> None:
        if self._ws is not None:
            return
        try:
            self._ws = await asyncio.wait_for(
                connect(self._config.url, max_size=8 * 1024 * 1024),
                timeout=self._config.connect_timeout,
            )
        except (TimeoutError, OSError, websockets.InvalidURI, websockets.InvalidHandshake) as e:
            raise BridgeUnavailable(f"bridge not reachable at {self._config.url}: {e}") from e
        self._reader_task = asyncio.create_task(self._reader(), name="able-mcp-bridge-reader")

    async def close(self) -> None:
        self._closed = True
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader_task
            self._reader_task = None
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        # Fail any outstanding waiters.
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(BridgeUnavailable("bridge connection closed"))
        self._pending.clear()

    async def __aenter__(self) -> BridgeClient:
        await self.connect()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # RPC
    # ------------------------------------------------------------------

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and wait for its response.

        Raises :class:`BridgeUnavailable` if not connected, :class:`BridgeError`
        if the server returns an error or the request times out.
        """
        if self._ws is None:
            raise BridgeUnavailable("client is not connected; call connect() first")

        req_id = next(self._id_iter)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[req_id] = future

        payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params:
            payload["params"] = params

        try:
            await self._ws.send(json.dumps(payload))
        except Exception as e:
            self._pending.pop(req_id, None)
            raise BridgeUnavailable(f"send failed: {e}") from e

        try:
            return await asyncio.wait_for(future, timeout=self._config.request_timeout)
        except TimeoutError as e:
            self._pending.pop(req_id, None)
            raise BridgeError(f"timeout waiting for {method}") from e

    async def ping(self) -> dict[str, Any]:
        """Health check. Returns the bridge's pong payload."""
        return await self.call("ping")

    # ------------------------------------------------------------------
    # Reader
    # ------------------------------------------------------------------

    async def _reader(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                self._dispatch(raw)
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            return
        except Exception:
            log.exception("bridge reader crashed")
        finally:
            # Wake up everyone still waiting.
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(BridgeUnavailable("bridge connection lost"))
            self._pending.clear()

    def _dispatch(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("bridge sent non-JSON frame: %r", raw[:200])
            return
        if not isinstance(msg, dict):
            return

        # Notifications (no id) — e.g. the bridge.hello on connect.
        if "id" not in msg:
            log.debug("bridge notification: %s", msg.get("method"))
            return

        future = self._pending.pop(msg["id"], None)
        if future is None or future.done():
            return
        if "error" in msg and msg["error"] is not None:
            err = msg["error"]
            future.set_exception(
                BridgeError(err.get("message", "unknown error"), code=err.get("code"))
            )
        else:
            future.set_result(msg.get("result"))


@contextlib.asynccontextmanager
async def open_client() -> AsyncIterator[BridgeClient]:
    """Convenience context manager that loads config from the environment."""
    client = BridgeClient.from_env()
    await client.connect()
    try:
        yield client
    finally:
        await client.close()
