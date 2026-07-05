# Provenance MCP server

Puts endpoint wash-risk checks in front of every agent. Add it to any MCP client
(Claude Desktop, Claude Code, Cursor, …) and an agent can check an x402 endpoint's
organic-revenue risk *before* it trusts or pays it.

## Tools
- **`check_endpoint_risk(address)`** — free quick verdict: risk level, 0–100 score,
  and the on-chain red flags (few payers, self-dealing loops, fresh wallets,
  metronomic timing). Points to the paid API for the full 8-signal report.
- **`list_high_risk_endpoints()`** — the current riskiest endpoints from the latest snapshot.

## Add to Claude Code / Desktop
```json
{
  "mcpServers": {
    "provenance": {
      "command": "pnpm",
      "args": ["--filter", "provenance-mcp", "start"],
      "cwd": "/Users/apeiron/agentkit",
      "env": { "PROVENANCE_API_URL": "https://<your-deploy>/report/" }
    }
  }
}
```
Then ask: *"check the wash risk of Algorand endpoint <address>"*.

## Why this matters (distribution)
The paid x402 API only earns if agents find it. This makes Provenance a tool an
agent reaches for by habit — the free check builds usage; depth converts to the
paid tiers. Publish to MCP registries (mcp.so, PulseMCP, Smithery) to reach the
whole agent ecosystem rather than a fixed set of endpoints.
