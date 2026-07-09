/**
 * @bazaar/mcp - the Unicity Agent Bazaar as an MCP server.
 *
 * Exposes the marketplace to any MCP client (Claude, another agent, an IDE) as
 * tools: discover agents, read their input contract, hire one, fund the escrow
 * from the agent's own wallet, and track delivery. This is "agents hiring
 * agents" - an autonomous agent can now buy a service on-chain, end to end.
 *
 * Talks stdio, so every log MUST go to stderr (stdout is the protocol channel).
 */
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { canonicalReceipt } from '@bazaar/core';
import { verifySignedMessage } from '@unicitylabs/sphere-sdk';
import { z } from 'zod';
import { BazaarClient, type Signer } from '@bazaar/agent-kit';
import { McpWallet } from './wallet.js';
import { inputContract, summarizeListing } from './format.js';

const PUBLIC_TESTNET2_KEY = 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
const DEFAULT_WALLET_API_URL = 'https://wallet-api.unicity.network';

const log = (...a: unknown[]) => console.error('[bazaar-mcp]', ...a);
const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v && v.length > 0 ? v : undefined;
};

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): Text => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Text => ({ content: [{ type: 'text', text }], isError: true });
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function buildServer(client: BazaarClient, getWallet: () => McpWallet | null): McpServer {
  const server = new McpServer({ name: 'unicity-agent-bazaar', version: '0.1.0' });

  server.registerTool(
    'discover_agents',
    {
      title: 'Discover agents',
      description:
        'List agents for hire on the Unicity Agent Bazaar. Optionally filter by a text query (title/description/nametag) or category (analysis, data, creative, automation, game, other).',
      inputSchema: { query: z.string().optional(), category: z.string().optional() },
    },
    async ({ query, category }) => {
      try {
        let listings = await client.listings();
        if (category) listings = listings.filter((l) => l.category === category);
        if (query) {
          const q = query.toLowerCase();
          listings = listings.filter(
            (l) =>
              l.title.toLowerCase().includes(q) ||
              l.description.toLowerCase().includes(q) ||
              l.agentNametag.toLowerCase().includes(q),
          );
        }
        if (listings.length === 0) return ok('No agents match. Try a broader query or no filter.');
        return ok(`${listings.length} agent(s) for hire:\n${listings.map(summarizeListing).join('\n')}`);
      } catch (e) {
        return fail(`Could not reach the bazaar: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get agent details',
      description:
        "Fetch one listing's full details, including the exact input contract you must satisfy when hiring it.",
      inputSchema: { listingId: z.string() },
    },
    async ({ listingId }) => {
      try {
        const l = await client.listing(listingId);
        return ok(
          [
            `${l.title}  [${l.id}]`,
            `by ${l.agentNametag} · ${l.priceUct} UCT per job · ${l.category}${l.verified ? ' · ✓verified' : ''}`,
            '',
            l.description,
            '',
            inputContract(l),
            '',
            'To hire: call hire_agent with this listingId and an input object, then pay_escrow to fund it.',
          ].join('\n'),
        );
      } catch (e) {
        return fail(errMsg(e));
      }
    },
  );

  server.registerTool(
    'hire_agent',
    {
      title: 'Hire an agent',
      description:
        'Open an on-chain escrow to hire an agent for one job. Provide the input object matching the listing schema (use get_agent to see it). Optionally pass a `mandateId` to spend under a buyer\'s signed spending mandate (the platform enforces its budget/category/expiry caps). Returns a jobId and payment details - the escrow is NOT funded yet; call pay_escrow next.',
      inputSchema: {
        listingId: z.string(),
        input: z.record(z.any()).optional(),
        mandateId: z.string().optional(),
      },
    },
    async ({ listingId, input, mandateId }) => {
      if (!getWallet()) return fail('Read-only mode: set BAZAAR_MCP_MNEMONIC to hire agents.');
      try {
        const h = await client.hire(listingId, input ?? {}, mandateId ? { mandateId } : {});
        return ok(
          [
            `Escrow opened. jobId=${h.job.jobId}`,
            `Price: ${h.amountUct} UCT - held in escrow, released only on delivery.`,
            mandateId ? `Charged under mandate ${mandateId}.` : '',
            `Next: call pay_escrow with jobId="${h.job.jobId}" to fund it from your wallet.`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        return fail(`Hire failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    'pay_escrow',
    {
      title: 'Fund an escrow',
      description:
        'Fund a hired job by sending its price from the agent wallet into escrow (the memo is attached automatically). After this, the provider runs and delivers; poll job_status.',
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      const wallet = getWallet();
      if (!wallet) return fail('Read-only mode: set BAZAAR_MCP_MNEMONIC to fund escrows.');
      try {
        const view = await client.job(jobId);
        if (view.job.state !== 'quoted') {
          return ok(`Job ${jobId} is already "${view.job.state}" - no payment needed.`);
        }
        const dep = await client.depositInfo();
        await wallet.send(dep.escrow, view.job.amountUct, view.job.escrowRef);
        return ok(
          [
            `Sent ${view.job.amountUct} ${dep.symbol} to ${dep.escrow} (memo ${view.job.escrowRef}).`,
            'The bazaar will detect the funding within ~15s, then invoke the provider.',
            `Poll job_status with jobId="${jobId}" until it is "delivered".`,
          ].join('\n'),
        );
      } catch (e) {
        return fail(`Payment failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    'job_status',
    {
      title: 'Check a job',
      description:
        'Get a job\'s escrow state (quoted → funded → delivered → released/refunded), the delivered output when ready, and settlement info.',
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const v = await client.job(jobId);
        const lines = [`jobId=${v.job.jobId}  state=${v.job.state}  amount=${v.job.amountUct} UCT`];
        if (v.result) {
          lines.push('');
          lines.push(
            v.result.ok
              ? `delivered output:\n${JSON.stringify(v.result.output ?? null, null, 2)}`
              : `provider failed: ${v.result.error ?? 'unknown error'}`,
          );
        }
        if (v.job.state === 'delivered') lines.push('\nCall accept_job to release the funds (or dispute if wrong).');
        if (v.settlement) lines.push(`\nsettlement: ${v.settlement.status} (${v.settlement.kind})`);
        if (v.receipt) {
          lines.push(
            `\nsigned settlement receipt available (signer ${v.receipt.signer.slice(0, 12)}…) - call verify_receipt to check it independently.`,
          );
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(errMsg(e));
      }
    },
  );

  server.registerTool(
    'accept_job',
    {
      title: 'Accept & release',
      description: 'Accept a delivered job and release the escrowed funds to the provider.',
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      if (!getWallet()) return fail('Read-only mode: set BAZAAR_MCP_MNEMONIC to act on jobs.');
      try {
        const job = await client.accept(jobId);
        return ok(`Released. Job ${jobId} is now "${job.state}" - the provider has been paid.`);
      } catch (e) {
        return fail(`Accept failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    'verify_receipt',
    {
      title: 'Verify a settlement receipt',
      description:
        "Independently verify a job's settlement receipt: checks the escrow wallet's signature over the canonical receipt with secp256k1 - locally, without trusting the API. Proves the job settled exactly as stated.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const v = await client.job(jobId);
        if (!v.receipt) return ok(`Job ${jobId} has no settlement receipt yet (it must settle first).`);
        const { receipt, signature, signer } = v.receipt;
        const valid = verifySignedMessage(canonicalReceipt(receipt), signature, signer);
        return ok(
          [
            valid ? '✓ VALID - signature verifies against the escrow key.' : '✗ INVALID - signature does not match.',
            `outcome: ${receipt.outcome} of ${receipt.amountUct} UCT`,
            `recipient: ${receipt.recipient}`,
            `signer (escrow): ${signer}`,
            receipt.txId ? `on-chain tx: ${receipt.txId}` : 'on-chain tx: (pending / none recorded)',
          ].join('\n'),
        );
      } catch (e) {
        return fail(errMsg(e));
      }
    },
  );

  server.registerTool(
    'wallet_info',
    {
      title: 'Agent wallet info',
      description: "Show the agent wallet's identity (nametag / chain pubkey) and confirmed UCT balance.",
      inputSchema: {},
    },
    async () => {
      const wallet = getWallet();
      if (!wallet) return ok('Read-only mode - no wallet. Set BAZAAR_MCP_MNEMONIC to hire and pay.');
      try {
        const balance = await wallet.balanceUct();
        return ok(
          [
            `nametag: ${wallet.nametag ? '@' + wallet.nametag : '(none registered)'}`,
            `chainPubkey: ${wallet.chainPubkey}`,
            `balance: ${balance} UCT (testnet2)`,
          ].join('\n'),
        );
      } catch (e) {
        return fail(errMsg(e));
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const apiUrl = env('BAZAAR_API_URL') ?? 'http://localhost:4600';
  const mnemonic = env('BAZAAR_MCP_MNEMONIC');

  let wallet: McpWallet | null = null;
  let signer: Signer | undefined;
  if (mnemonic) {
    wallet = new McpWallet({
      mnemonic,
      nametag: env('BAZAAR_MCP_NAMETAG') ?? 'bazaar-mcp-agent',
      dataDir: env('BAZAAR_MCP_DATA_DIR') ?? path.join(os.homedir(), '.bazaar-mcp'),
      oracleApiKey: env('SPHERE_ORACLE_API_KEY') ?? PUBLIC_TESTNET2_KEY,
      walletApiUrl: env('SPHERE_WALLET_API_URL') ?? DEFAULT_WALLET_API_URL,
    });
    try {
      log('starting wallet…');
      await wallet.start();
      signer = { chainPubkey: wallet.chainPubkey, nametag: wallet.nametag, sign: (m) => wallet!.signMessage(m) };
      log(`wallet ready: ${signer.nametag ? '@' + signer.nametag : signer.chainPubkey.slice(0, 12) + '…'}`);
    } catch (e) {
      log('wallet init failed - running read-only:', errMsg(e));
      wallet = null;
      signer = undefined;
    }
  } else {
    log('no BAZAAR_MCP_MNEMONIC - running read-only (discover/get/status only)');
  }

  const funder = wallet
    ? async (to: string, amountUct: number, memo: string) => {
        await wallet!.send(to, amountUct, memo);
      }
    : undefined;
  const client = new BazaarClient(apiUrl, { signer, funder });
  if (signer) {
    try {
      await client.login();
      log('signed in to the bazaar');
    } catch (e) {
      log('sign-in failed (will retry on first authed call):', errMsg(e));
    }
  }

  const server = buildServer(client, () => wallet);
  await server.connect(new StdioServerTransport());
  log(`connected to ${apiUrl} - ready`);
}

main().catch((e) => {
  log('fatal:', errMsg(e));
  process.exit(1);
});
