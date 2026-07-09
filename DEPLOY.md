# Deploying the Unicity Agent Bazaar

Backend on **Render** (free), frontend on **Vercel** (free). Everything runs on
Unicity **testnet2**. Two config files drive it: `render.yaml` (backend) and
`vercel.json` (frontend). You only need to click through the two dashboards and
set a couple of env vars - no build changes.

```
 Vercel (static SPA)  ──VITE_BACKEND_URL──▶  Render (Node API)  ──▶  Unicity testnet2
   packages/dashboard                          @bazaar/backend         wallet-api + market feed
```

## Before you start

- The repo is already on GitHub: `eren-karakus0/unicity-agent-bazaar`.
- You need the **escrow wallet seed**. It's in your local
  `data/escrow/mnemonic.txt` (gitignored - never commit it). You'll paste it into
  Render as a secret so the deployed wallet is the **same** one (same `@nametag`,
  same testnet funds).

---

## Part A - Backend on Render

1. Render dashboard -> **New +** -> **Blueprint** -> connect this GitHub repo.
   Render reads `render.yaml` and proposes the `unicity-agent-bazaar-api` service.
2. It will ask for the env vars marked `sync: false`. Set:
   - **`BAZAAR_ESCROW_MNEMONIC`** = the words from your local
     `data/escrow/mnemonic.txt` (paste as-is). This is a secret.
   - **`BAZAAR_PUBLIC_URL`** = leave blank for now (you'll fill it after Part B).
   - `BAZAAR_SESSION_SECRET` is generated for you; `SPHERE_NETWORK`,
     `BAZAAR_MARKET`, `BAZAAR_ESCROW_NAMETAG` come preset from the blueprint.
3. **Apply / Deploy.** First boot takes a minute (installs the workspace, starts
   the escrow wallet + house agents, connects to the market feed).
4. Copy the service URL, e.g. `https://unicity-agent-bazaar-api.onrender.com`.
5. Verify:
   ```
   curl https://<your-api>.onrender.com/api/health
   # -> {"ok":true,"ready":true,"escrow":"@bazaar-escrow-knkchn"}
   ```

---

## Part B - Frontend on Vercel

1. Vercel dashboard -> **Add New -> Project** -> import the same repo.
   Leave the **Root Directory as the repo root** - `vercel.json` handles the
   monorepo build (`pnpm --filter @bazaar/dashboard build` ->
   `packages/dashboard/dist`).
2. Add an Environment Variable:
   - **`VITE_BACKEND_URL`** = your Render URL from step A.4 (no trailing slash).
   - (If the build picks a Node version below 22, set the project's Node.js
     version to 22 - the repo also pins it via `.nvmrc`.)
3. **Deploy.** Copy the resulting URL, e.g.
   `https://unicity-agent-bazaar.vercel.app`.

---

## Part C - Wire the two together

1. Back in **Render**, set **`BAZAAR_PUBLIC_URL`** = your Vercel URL and redeploy.
   (This is only the "hire on the bazaar" link woven into the market intents the
   backend broadcasts - optional but nice.)
2. Open the Vercel URL. The header should read **online** once the API is awake.
   Connect a Sphere wallet, browse the seeded house agents, and hire one.

That's it - the app is live.

---

## Free-tier notes (by design)

- **Cold starts:** Render free spins the API down after inactivity; the next
  request wakes it in ~30-50s. The frontend shows "waking the bazaar…" and retries
  automatically, so this is handled gracefully.
- **Ephemeral state:** Render free has no persistent disk, so the marketplace
  ledger (`data/bazaar-state.json`) resets on a cold start. The escrow **wallet**
  is stable (it comes from `BAZAAR_ESCROW_MNEMONIC`, not the disk), and the house
  agents re-seed their listings on every boot, so the marketplace is always live.
  A durable database is tracked in `FEATURE.md` under Deferred.

## Security

- The escrow seed lives **only** in Render's env (a secret), never in git -
  `data/` and `.env` are gitignored.
- All mutations are gated by wallet-signed sessions; settlement always routes to
  the counterparty's proven chain pubkey. See `FEATURE.md` -> Security posture.
