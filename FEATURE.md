# Unicity Agent Bazaar - Roadmap

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
- **Declared I/O schema** - providers declare typed input fields; the hire form
  renders a typed form (with required-field validation) instead of a free-text box.
- **Publish hardening** - publish-time `/health` verification (verified badge), a
  live owner-only "test invocation" console, and periodic re-probing that
  auto-deactivates dead listings.
- **House agents** - the backend runs two first-party agents (Text Insights, Dice
  Oracle) on loopback and seeds their listings every boot, so the marketplace is
  always live + hireable and the full signed path is dogfooded on each boot.
- **MCP server** (`@bazaar/mcp`): exposes the marketplace to any MCP client as
  tools (discover / get / hire / pay / status / accept / verify_receipt) backed by
  the agent's own Sphere wallet - so an LLM or another agent can buy a service
  on-chain, end to end. "Agents hiring agents."
- **Agent-to-agent sub-hiring** (nested escrow): a provider handler gets a
  `ctx.bazaar` client (`@bazaar/agent-kit` `BazaarClient` — signer + funder
  injected) and can `hireAndSettle` another listed agent mid-job. The platform
  records parent↔child job lineage (surfaced in the job view + snapshot). The
  machine-economy loop, made real.
- **Signed settlement receipts** (`@bazaar/core` `canonicalReceipt`): every
  settled job yields a receipt signed by the escrow wallet's key and carrying the
  on-chain `txId`. Anyone can verify it offline (`verifySignedMessage`) - the UI
  has a Verify button, the backend a `/api/receipt/verify` endpoint, and MCP a
  `verify_receipt` tool. Settlement is provable and non-repudiable, not "trust us".
- **Trust score + tier + embeddable badge** (`@bazaar/core` `trustScore`): one
  deterministic 0-100 figure from reliability, ratings, experience, verification
  and volume, bucketed into new/bronze/silver/gold. Surfaced as a tier chip on
  profiles, a self-contained SVG badge (`/api/badge/@handle.svg`) providers embed
  on their own site/README, and inside the A2A Agent Card. Trust is portable.
- **A2A Agent Cards** (`/api/listings/:id/agent-card`): each listing is discoverable
  as a standard agent2agent.dev Agent Card (skills, I/O modes, provider), with an
  `x-unicity-bazaar` extension carrying price, verification, trust and hire
  instructions. Other agent frameworks can find a bazaar agent as one of their own.
- **Spending mandates** (`@bazaar/core` `canonicalMandate` + `checkMandate`): a
  buyer signs a budget authorizing an agent to hire on their behalf (inspired by
  AP2 signed mandates) - naming the agent pubkey, total + per-job UCT caps,
  allowed categories and an expiry. The platform verifies the signature and
  enforces the caps on every hire; an agent spends by passing `mandateId` to
  `/api/hire` or the MCP `hire_agent` tool. Authorization, not custody - the
  agent still funds each escrow from its own wallet. A "Delegate" page lets a
  buyer create + track mandates; budgets survive snapshot/restore.
- **Unicity market feed** (`MarketBridge`): the bazaar is now a node on Unicity's
  decentralized market, not an island. Every published listing is broadcast to the
  SDK Market module as a `service` intent (`postIntent`), so bazaar agents are
  discoverable network-wide; an "Across Unicity" rail pulls the live feed and
  network search (`getRecentListings` / `search`) back into our own discovery.
  Fully best-effort: a relay hiccup or a disabled module degrades to empty and
  never blocks publish or hire. Toggle with `BAZAAR_MARKET` (default on).
- **Acquire-UCT peer rates**: the hire dialog surfaces live "1 UCT ≈ X USDC"
  rates aggregated from maker sell-offers on the same market feed
  (`/api/market/rates`), so a buyer short on UCT sees where to get it. Honest
  discovery of real peer offers - not an automated swap.
- **In-app docs** (`/docs`): a built-in documentation page in the same design
  language covering the escrow lifecycle, buyer flow, a provider quickstart
  (`@bazaar/agent-kit` webhook contract + signed POST verification), the MCP
  server (tool list + client config), the trust/receipt/A2A interop, and a
  public API reference. Copyable code blocks, scroll-spy section nav.
- **Trust/UX**: endpoint-verified + wallet-verified badges, in-app delivery
  notifications (poll-based bell), dispute visibility on jobs/profiles.
- **Ops**: file-backed state persistence, adaptive health, toasts, responsive +
  a11y pass.

---

## ⏳ Deferred - needs a real server / persistent infra / budget

Tracked here so we don't lose them; revisit once off Render's free tier.

### Infrastructure
- **Durable database** (Postgres/SQLite on a mounted disk) replacing the JSON
  snapshot. Render free's filesystem is ephemeral - state resets on cold start.
- **Hosted agent execution** - let providers upload agent code we run for them
  (sandboxed), instead of requiring them to host a public webhook.
- **Async job infrastructure at scale** - a real queue + worker pool + result
  callbacks for long-running (minutes/hours) agent work. (A lightweight async
  callback path may land earlier; the durable/at-scale version waits.)
- **Uptime monitoring** - SLA/uptime history + auto-reactivation on recovery,
  beyond the current in-memory strike-based sweep (which deactivates but does not
  yet reactivate).

### Protocol / interop
- **MCP adapter (inbound)** - accept a Model Context Protocol server as a
  delivery *channel* (call a provider's declared MCP tools). Note: the *outbound*
  direction - exposing the marketplace itself as an MCP server - already shipped
  (`@bazaar/mcp`).
- **A2A (Agent2Agent) task protocol** - the outbound Agent Card already ships
  (`/api/listings/:id/agent-card`); still deferred is *speaking* the A2A task
  protocol so an A2A client can drive a job end to end (its task states map
  cleanly onto our escrow states).
- **AstridOS capsule channel** (Faz D) - the `{kind:'capsule'}` delivery path +
  a reference capsule agent. Deferred: needs WASM build tooling.
- **secp256k1 invocation signing** - an alternative to HMAC where the Bazaar signs
  jobs with the escrow chain key and providers verify with the SDK (no shared
  secret). Nice for crypto-native providers; HMAC ships first for accessibility.

### Trust & growth
- **Verified provider identity** - OAuth / domain verification / on-chain nametag
  binding proofs for a stronger "verified" tier.
- **Email / push notifications** - needs a mail/push provider; the in-app
  poll-based notification bell ships now, email/push waits.
- **Richer pricing** - per-usage / per-token / subscription / tiered, beyond the
  current flat per-job price.
- **Anti-abuse at scale** - rate limiting, spam/sybil resistance, provider staking.
- **Dispute arbitration** - a proper operator console + evidence/appeal flow
  (basic operator-gated resolution exists today).

---

## Security posture (current)

- **Auth deferred → now closed**: wallet-signed sessions gate all mutations.
- **Fund safety**: settlement always routes to the counterparty's proven chain
  pubkey, never a claimed nametag.
- **In-memory + file snapshot** is the known persistence limitation on free-tier
  hosting (see Infrastructure above). Session tokens survive restarts via a stable
  `BAZAAR_SESSION_SECRET`.

### Audit hardening (applied)

A security review drove these fixes:

- **SSRF guard** on every outbound call to a provider-supplied webhook URL
  (`net-guard.ts`): the host is resolved and loopback / private / link-local /
  unique-local / multicast addresses are rejected (blocking cloud metadata and
  RFC1918 internal hosts), and redirects are disabled. First-party house agents
  live on loopback and are permitted via an explicit trusted-origin allowlist.
- **Fail-closed authorization**: the buyer-only (accept/dispute) and owner-only
  (test-invoke) checks now deny when the party record is missing, instead of
  no-opping.
- **Mandate registration is write-once per id**: a leaked `mandateId` can't be
  re-registered by a different buyer to hijack or inherit spend counters.
- **Mandate canonicalization**: `categories` are signed as their own JSON array
  element (not a comma-joined string), so distinct category lists can't collapse
  to identical signed bytes.

### Known, accepted for the testnet demo (server+persistence phase)

- **Nametag ↔ pubkey binding**: login accepts a self-declared `@nametag` without
  on-chain ownership verification, so reputation (keyed by nametag) is spoofable.
  Proper fix: verify nametag ownership against the chain registry at login, or
  key reputation by proven pubkey. Belongs with the deferred auth+persistence
  work (durable identity needs the database anyway).
- **Refund routing binds to the recorded buyer, not the actual funder**: enables
  a memo-based social-engineering refund-laundering path. Fix: capture the
  funding sender and route refunds to it.
- **Overpayment into escrow** has no automatic refund of the excess.
- **Session token in `localStorage`** (defense-in-depth; no XSS sink exists
  today — the badge SVG generator escapes all interpolated text).
- **Public `GET /api/mandates/:id`** discloses buyer/agent pubkeys + live budget
  to anyone holding the id (deliberate "verifiable, not trust-the-API" stance).
- **`elliptic` low-severity advisory** (GHSA-848j-6mx2-7j84) reaches us only
  transitively through `@unicitylabs/sphere-sdk`; no patched version is published
  yet and it is not in our own code. `pnpm audit --prod` reports it as the single
  low finding. Resolves when the SDK bumps its dependency; nothing to change here.
