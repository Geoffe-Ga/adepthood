# Authenticated agent discovery 0.24

These are canonical Creek publisher artifacts for the optional `agent_mcp`
extension on unversioned `GET /v1/capabilities`, stored separately from the
0.22 content bundle. `vendor.json` records their exact hashes and source paths;
the contract note links the pinned producer revision.

Both example vaults remain available for content. `agent-mcp-unavailable.json`
disables only the public agent surface. Older declared discovery minors omit
the new field. Adepthood keeps every versioned content request at 0.22.

The four recorded SHA256 values are public artifact digests, audited as
non-secrets in `.secrets.baseline`; the scanner remains enabled for these files.
