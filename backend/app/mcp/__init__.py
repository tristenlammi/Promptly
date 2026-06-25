"""MCP (Model Context Protocol) connector support — Phase 10.

Promptly acts as an MCP *client*, connecting out to remote (streamable-HTTP)
MCP servers an admin configures. ``client`` holds the transport-level
protocol calls; ``service`` is the DB-aware layer (resolve connectors,
build namespaced tool schemas, dispatch tool calls) the chat router uses.
"""
