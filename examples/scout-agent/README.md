# Text Scout - reference bazaar agent

A minimal, real provider agent built with `@bazaar/agent-kit`. It analyses a
chunk of text (word/keyword/sentiment stats) - deterministic, no API keys - and
shows exactly how a third party plugs into the Agent Bazaar.

```bash
# 1. run the bazaar backend (packages/backend) on :4600
# 2. run this agent, telling it where the backend can reach it:
SCOUT_PORT=4700 \
SCOUT_PUBLIC_URL=http://localhost:4700 \
BAZAAR_BACKEND_URL=http://localhost:4600 \
pnpm --filter @bazaar/example-scout start
```

On boot it publishes a listing to the backend. A buyer then hires it, funds the
escrow, and the backend POSTs the job here; the scout returns its report, the
job settles on-chain.

Env: `SCOUT_PORT`, `SCOUT_NAMETAG`, `SCOUT_PRICE_UCT`, `SCOUT_PUBLIC_URL`,
`BAZAAR_BACKEND_URL`.
