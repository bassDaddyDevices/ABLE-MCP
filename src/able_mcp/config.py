"""Runtime configuration for ABLE-MCP.

All knobs are read from environment variables so MCP clients can override them
without editing code:

* ``ABLE_MCP_BRIDGE_HOST`` (default ``127.0.0.1``)
* ``ABLE_MCP_BRIDGE_PORT`` (default ``9831``)
* ``ABLE_MCP_BRIDGE_TIMEOUT`` — per-request timeout in seconds (default ``5.0``)
* ``ABLE_MCP_BRIDGE_CONNECT_TIMEOUT`` — initial connect timeout (default ``2.0``)
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BridgeConfig:
    host: str
    port: int
    request_timeout: float
    connect_timeout: float

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"


def load_bridge_config() -> BridgeConfig:
    return BridgeConfig(
        host=os.environ.get("ABLE_MCP_BRIDGE_HOST", "127.0.0.1"),
        port=int(os.environ.get("ABLE_MCP_BRIDGE_PORT", "9831")),
        request_timeout=float(os.environ.get("ABLE_MCP_BRIDGE_TIMEOUT", "5.0")),
        connect_timeout=float(os.environ.get("ABLE_MCP_BRIDGE_CONNECT_TIMEOUT", "2.0")),
    )
