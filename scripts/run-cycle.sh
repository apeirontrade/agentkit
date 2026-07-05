#!/bin/bash
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
cd /Users/apeiron/agentkit
mkdir -p scratch/history
"/opt/homebrew/opt/node@22/bin/pnpm" provenance:cycle --anchor >> scratch/history/cycle.log 2>&1
