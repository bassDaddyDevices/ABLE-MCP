"""ABLE-MCP — MCP server for Ableton Live 12.

Two complementary capabilities:

* Offline parsing and analysis of ``.als`` (gzipped XML) project files.
* Live LOM access via a custom Max for Live bridge device over a localhost
  WebSocket + JSON-RPC channel.

Use :func:`able_mcp.server.main` as the stdio entry point.
"""

__version__ = "0.1.0"
