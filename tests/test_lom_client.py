"""Tests for the LOM bridge client against a fake WebSocket bridge."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
import websockets
from websockets.asyncio.server import ServerConnection, serve

from able_mcp.config import BridgeConfig
from able_mcp.lom.client import BridgeClient, BridgeError, BridgeUnavailable

# ---------------------------------------------------------------------------
# Fake bridge
# ---------------------------------------------------------------------------


class FakeBridge:
    """Minimal stand-in for the M4L bridge.

    Echos a ``bridge.hello`` notification on connect and dispatches a small
    method table. Tests can override ``methods`` per-instance.
    """

    def __init__(self) -> None:
        self.methods: dict[str, object] = {
            "ping": lambda _p: {"pong": True, "protocol": "able-mcp/0.1", "ts": 0},
            "song.getTempo": lambda _p: {"tempo": 124.5},
            "echo": lambda p: {"got": p},
            "slow": self._slow,
        }
        self.received: list[dict] = []

    @staticmethod
    async def _slow(_p):  # noqa: D401
        await asyncio.sleep(2.0)
        return {"ok": True}

    async def handler(self, ws: ServerConnection) -> None:
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "method": "bridge.hello",
            "params": {"protocol": "able-mcp/0.1"},
        }))
        async for raw in ws:
            msg = json.loads(raw)
            self.received.append(msg)
            method = msg.get("method")
            req_id = msg.get("id")
            handler = self.methods.get(method)
            if handler is None:
                await ws.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"method not found: {method}"},
                }))
                continue
            try:
                result = handler(msg.get("params", {}))
                if asyncio.iscoroutine(result):
                    result = await result
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}))
            except Exception as e:  # pragma: no cover - defensive
                await ws.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32000, "message": str(e)},
                }))


@asynccontextmanager
async def run_bridge() -> AsyncIterator[tuple[FakeBridge, int]]:
    bridge = FakeBridge()
    async with serve(bridge.handler, "127.0.0.1", 0) as server:
        port = next(iter(server.sockets)).getsockname()[1]
        yield bridge, port


def _config(port: int, *, request_timeout: float = 1.0) -> BridgeConfig:
    return BridgeConfig(
        host="127.0.0.1",
        port=port,
        request_timeout=request_timeout,
        connect_timeout=1.0,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ping_round_trip() -> None:
    async with run_bridge() as (_bridge, port), BridgeClient(_config(port)) as client:
        pong = await client.ping()
        assert pong["pong"] is True
        assert pong["protocol"] == "able-mcp/0.1"


@pytest.mark.asyncio
async def test_call_with_params_and_result() -> None:
    async with run_bridge() as (bridge, port), BridgeClient(_config(port)) as client:
        r = await client.call("echo", {"a": 1, "b": "x"})
        assert r == {"got": {"a": 1, "b": "x"}}
        # Verify the bridge actually saw the params:
        assert any(m.get("method") == "echo" for m in bridge.received)


@pytest.mark.asyncio
async def test_unknown_method_raises_bridge_error() -> None:
    async with run_bridge() as (_bridge, port), BridgeClient(_config(port)) as client:
        with pytest.raises(BridgeError) as ei:
            await client.call("no.such.method")
        assert ei.value.code == -32601


@pytest.mark.asyncio
async def test_concurrent_calls_do_not_cross_responses() -> None:
    async with run_bridge() as (_bridge, port), BridgeClient(_config(port)) as client:
        results = await asyncio.gather(
            client.call("echo", {"i": 1}),
            client.call("echo", {"i": 2}),
            client.call("echo", {"i": 3}),
        )
        assert [r["got"]["i"] for r in results] == [1, 2, 3]


@pytest.mark.asyncio
async def test_request_timeout_raises_bridge_error() -> None:
    async with run_bridge() as (_bridge, port), BridgeClient(_config(port, request_timeout=0.05)) as client:
        with pytest.raises(BridgeError):
            await client.call("slow")


@pytest.mark.asyncio
async def test_connect_failure_when_bridge_absent() -> None:
    # Pick a port nothing should be listening on. 1 is reserved.
    config = BridgeConfig(host="127.0.0.1", port=1, request_timeout=0.5, connect_timeout=0.5)
    client = BridgeClient(config)
    with pytest.raises(BridgeUnavailable):
        await client.connect()


@pytest.mark.asyncio
async def test_call_after_close_fails_cleanly() -> None:
    async with run_bridge() as (_bridge, port):
        client = BridgeClient(_config(port))
        await client.connect()
        await client.close()
        with pytest.raises(BridgeUnavailable):
            await client.call("ping")


@pytest.mark.asyncio
async def test_server_drop_fails_pending_requests() -> None:
    async with run_bridge() as (bridge, port):
        client = BridgeClient(_config(port, request_timeout=2.0))
        await client.connect()
        # Replace the slow handler with one that closes the connection.
        async def boom(_p):
            raise websockets.ConnectionClosed(rcvd=None, sent=None)
        bridge.methods["boom"] = boom
        # Fire a slow call, then force-close the client transport from our side
        # to simulate the bridge going away.
        task = asyncio.create_task(client.call("slow"))
        await asyncio.sleep(0.05)
        await client.close()
        with pytest.raises(BridgeUnavailable):
            await task
