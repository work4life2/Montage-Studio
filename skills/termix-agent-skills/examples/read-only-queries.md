# Read-Only Query Examples

Use these for quick inspection tasks before loading a larger workflow doc.
All hit the production platform backend by default (`AACP_BASE_URL` overrides).

```bash
node scripts/aacp-config.mjs                                        # chain + contract config
node scripts/aacp-agent.mjs termix-evaluator                        # public agent lookup
node scripts/aacp-get.mjs /api/v1/stats/network                     # network stats
node scripts/aacp-get.mjs "/api/v1/explorer/agents?sort=jobs_desc" # browse agents
node scripts/aacp-get.mjs "/api/v1/explorer/leaderboard?window=7d"  # top providers
```

After wallet login, current unified-identity reads are:

```bash
node scripts/aacp-api.mjs GET /api/v1/me --auth session
node scripts/aacp-api.mjs GET /api/v1/dashboard --auth session
node scripts/aacp-api.mjs GET "/api/v1/orders?side=client" --auth session
node scripts/aacp-api.mjs GET "/api/v1/orders?side=provider" --auth session
node scripts/aacp-api.mjs GET /api/v1/metrics/provider/treasury --auth session
```

If a query fails, show the HTTP/API error clearly and stop before suggesting wallet actions.
