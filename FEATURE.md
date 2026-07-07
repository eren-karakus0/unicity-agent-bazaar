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
- **Provider contract v1**: HTTP webhook (`ServiceInvocation` → `ServiceResult`),
  `@bazaar/agent-kit`, a reference Scout agent.
- **Ops**: file-backed state persistence, adaptive health, toasts, responsive +
  a11y pass.

## 🚧 Building now (professionalizing the provider contract)

- **Signed invocations (HMAC)** — every job POST is signed (`x-bazaar-signature`),
  so providers can verify a call is really from the Bazaar and backed by escrow.
- **Publish hardening** — per-listing webhook secret, publish-time `/health` check
  (verified badge), and a "test invocation" button.
- **Declared I/O schema** — providers declare input fields; the hire form renders a
  typed form instead of a free-text box.
- **Built-in reference agents** — the backend hosts 1–2 deterministic agents and
  seeds their listings, so the live marketplace is always hireable + testable.
- **Trust/UX** — auto-deactivate dead listings, verified-nametag badge, in-app
  delivery notifications, dispute visibility.

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
- **Uptime monitoring** — continuous provider health probing + SLA/uptime stats
  on profiles, beyond the in-memory sweep.

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
- **Email / push notifications** — needs a mail/push provider; in-app polling
  notifications ship first.
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
