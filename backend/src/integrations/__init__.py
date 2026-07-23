"""Outbound third-party service clients (Gumroad, ...).

Each module wraps one external HTTP API behind a small, typed surface with
normalized errors, so routers and domain code never touch raw transport
details or vendor-specific failure shapes.
"""
