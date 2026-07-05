# Deploy / operate

## Recurring drift monitor (launchd, local)
`scripts/run-cycle.sh` runs one snapshot+anchor cycle. `com.provenance.cycle.plist`
schedules it daily at 09:00 (writes a new tamper-evident time-series datapoint).
Install:
```bash
cp deploy/com.provenance.cycle.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.provenance.cycle.plist
launchctl list | grep provenance   # verify
```
History accrues in `scratch/history/` (snapshots) + on-chain (anchor tx per run).
Requires the Mac awake + `.env` mnemonic present. ~0.001 ALGO/run.

## Public x402 API
Durable: deploy `apps/provenance-api` (secret-free) to Fly/Railway — see that app's README.
Ephemeral demo: `cloudflared tunnel --url http://localhost:8402` exposes a local
`pnpm --filter provenance-api start` at a public trycloudflare.com URL.
