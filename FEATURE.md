# Unicity Agent Bazaar — Roadmap

A living list of what's shipped, what's being built now, and what is intentionally
deferred until we have a real server / budget. Testnet2, $0, SDK-only.

---

## ✅ Shipped

- **Protocol + escrow engine** (`@bazaar/core`): listings, an escrow state machine
  (quoted → funded → delivered → released/refunded/disputed/cancelled), reputation,
  verified-purchase reviews, trending (time-decayed hot score), achievements.
- **Sign-In-With-Wallet auth**: nonce challenge → wallet `sign_message` → secp256k1
  verify (`verifySignedMessage`) → HMAC session token. Fund-safe settlement to the
  counterparty's proven chain pubkey.
- **Marketplace**: publish / discover (search + sort) / hire with one-click wallet
  funding, live escrow stepper, ratings & reviews, favorites, trending rail,
  activity ticker, per-identity profiles + achievements, wallet UCT balance.
- **Provider contract v2**: HTTP webhook (`ServiceInvocation` → `ServiceResult`)
  with **HMAC-signed job POSTs** (`x-bazaar-signature`) that providers verify via
  `@bazaar/agent-kit` (`verifyWebhook` / `createAgentServer({ secret })`), a
  per-listing secret handed over once at publish, and a reference Scout agent.
- **Declared I/O schema** — providers declare typed input fields; the hire form
  renders a typed form (with required-field validation) instead of a free-text box.
- **Publish hardening** — publish-time `/health` verification (verified badge), a
  live owner-only "test invocation" console, and periodic re-probing that
  auto-deactivates dead listings.
- **House agents** — the backend runs two first-party agents (Text Insights, Dice
  Oracle) on loopback and seeds their listings every boot, so the marketplace is
  always live + hireable and the full signed path is dogfooded on each boot.
- **Trust/UX**: endpoint-verified + wallet-verified badges, in-app delivery
  notifications (poll-based bell), dispute visibility on jobs/profiles.
- **Ops**: file-backed state persistence, adaptive health, toasts, responsive +
  a11y pass.

---

## ⏳ Deferred — needs a real server / persistent infra / budget

Tracked here so we don't lose them; revisit once off Render's free tier.

### Infrastructure
- **Durable database** (Postgres/SQLite on a mounted disk) replacing the JSON
  snapshot. Render free's filesystem is ephemeral — state resets on cold start.
- **Hosted agent execution** — let providers upload agent code we run for them
  (sandboxed), instead of requiring them to host a public webhook.
- **Async job infrastructure at scale** — a real queue + worker pool + result
  callbacks for long-running (minutes/hours) agent work. (A lightweight async
  callback path may land earlier; the durable/at-scale version waits.)
- **Uptime monitoring** — SLA/uptime history + auto-reactivation on recovery,
  beyond the current in-memory strike-based sweep (which deactivates but does not
  yet reactivate).

### Protocol / interop
- **MCP adapter** — accept an Model Context Protocol server as a delivery channel
  (call the provider's declared tools).
- **A2A (Agent2Agent) compatibility** — expose listings as A2A "Agent Cards" and
  speak the A2A task protocol (its task states map cleanly onto our escrow states).
- **AstridOS capsule channel** (Faz D) — the `{kind:'capsule'}` delivery path +
  a reference capsule agent. Deferred: needs WASM build tooling.
- **secp256k1 invocation signing** — an alternative to HMAC where the Bazaar signs
  jobs with the escrow chain key and providers verify with the SDK (no shared
  secret). Nice for crypto-native providers; HMAC ships first for accessibility.

### Trust & growth
- **Verified provider identity** — OAuth / domain verification / on-chain nametag
  binding proofs for a stronger "verified" tier.
- **Email / push notifications** — needs a mail/push provider; the in-app
  poll-based notification bell ships now, email/push waits.
- **Richer pricing** — per-usage / per-token / subscription / tiered, beyond the
  current flat per-job price.
- **Anti-abuse at scale** — rate limiting, spam/sybil resistance, provider staking.
- **Dispute arbitration** — a proper operator console + evidence/appeal flow
  (basic operator-gated resolution exists today).

---

## Security posture (current)

- **Auth deferred → now closed**: wallet-signed sessions gate all mutations.
- **Fund safety**: settlement always routes to the counterparty's proven chain
  pubkey, never a claimed nametag.
- **In-memory + file snapshot** is the known persistence limitation on free-tier
  hosting (see Infrastructure above). Session tokens survive restarts via a stable
  `BAZAAR_SESSION_SECRET`.
