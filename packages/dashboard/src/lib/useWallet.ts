import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectClient,
  SPHERE_NETWORKS,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
} from '@unicitylabs/sphere-sdk/connect';
import { PostMessageTransport, ExtensionTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import type { ConnectTransport, PublicIdentity } from '@unicitylabs/sphere-sdk/connect';

const WALLET_URL = 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere-connect-session';
// The public identity is persisted so the user stays connected across refreshes
// without re-opening the wallet popup. All state-changing actions (sign-in,
// deposits) still go through the wallet's own approval UI - the dapp holds no keys.
const IDENTITY_KEY = 'sphere-connect-identity';

const DAPP = {
  name: 'Unicity Agent Bazaar',
  description: 'Hire autonomous agents and pay on delivery - on-chain escrow, settled in real UCT.',
  url: typeof location !== 'undefined' ? location.origin : 'https://unicityagentbazaar.vercel.app',
  icon: '/icon.svg',
};

/** True when the Sphere browser extension is installed. */
function hasExtension(): boolean {
  try {
    const s = (window as unknown as { sphere?: { isInstalled?: () => boolean } }).sphere;
    return !!s && typeof s.isInstalled === 'function' && s.isInstalled() === true;
  } catch {
    return false;
  }
}

/**
 * Wait for the wallet popup to post HOST_READY before we handshake - otherwise
 * the connect message races ahead of the wallet's listener and is dropped
 * (the popup opens but never shows the approval UI).
 */
function waitForHostReady(timeoutMs = HOST_READY_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Wallet did not become ready - make sure you are signed in to your Sphere wallet.'));
    }, timeoutMs);
    function handler(event: MessageEvent) {
      if ((event.data as { type?: string })?.type === HOST_READY_TYPE) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

/** The wallet's `sign_message` intent result is wallet-defined; normalize it to the 130-hex signature. */
function extractSignature(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    for (const key of ['signature', 'sig', 'result', 'signedMessage']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  throw new Error('The wallet returned an unexpected sign-message response.');
}

/** base-unit integer string → a short human amount (up to 2 fractional digits). */
function formatUnits(base: string, decimals: number): string {
  try {
    const n = BigInt(base);
    const d = 10n ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return '0';
  }
}

export type WalletStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  identity: PublicIdentity | null;
  error: string | null;
  connect: () => Promise<PublicIdentity>;
  disconnect: () => Promise<void>;
  /** Ask the wallet to sign a plaintext message (opens its approval UI); returns the hex signature. */
  signMessage: (message: string) => Promise<string>;
  /**
   * Read the wallet's confirmed UCT balance (human string) via the live session
   * - does NOT open the wallet. Returns null when there is no live session yet.
   */
  getUctBalance: (coinId: string, decimals: number) => Promise<string | null>;
  /**
   * Ask the wallet to send a real transfer (opens its approval UI).
   * `amountBase` is a positive integer string in the coin's base units.
   */
  deposit: (params: { to: string; amountBase: string; coinId: string; memo?: string }) => Promise<void>;
}

export function useWallet(): WalletState {
  const [status, setStatus] = useState<WalletStatus>('idle');
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ConnectClient | null>(null);
  const transportRef = useRef<ConnectTransport | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Restore a previous connection on refresh so the user stays connected.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      if (raw) {
        setIdentity(JSON.parse(raw) as PublicIdentity);
        setStatus('connected');
      }
    } catch {
      /* corrupt / unavailable storage - ignore */
    }
  }, []);

  /**
   * Get a LIVE ConnectClient session - reuses the current one when its transport
   * is still alive, otherwise opens the wallet (popup/extension) and handshakes
   * (resuming the previous session skips the approval screen).
   */
  const openClient = useCallback(async (): Promise<ConnectClient> => {
    const alive =
      clientRef.current?.isConnected && (!popupRef.current || popupRef.current.closed === false);
    if (alive) return clientRef.current!;

    let transport: ConnectTransport;
    let isPopup = false;

    if (hasExtension()) {
      transport = ExtensionTransport.forClient();
    } else {
      const popup = window.open(
        `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
        'sphere-connect',
        'width=440,height=680',
      );
      if (!popup) throw new Error('Popup blocked - please allow popups for this site.');
      popupRef.current = popup;
      transport = PostMessageTransport.forClient({ target: popup, targetOrigin: WALLET_URL });
      isPopup = true;
    }
    transportRef.current = transport;

    if (isPopup) await waitForHostReady();

    const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    const client = new ConnectClient({
      transport,
      dapp: DAPP,
      network: SPHERE_NETWORKS.testnet2,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    clientRef.current = client;

    const result = await client.connect();
    sessionStorage.setItem(SESSION_KEY, result.sessionId);
    try {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(result.identity));
    } catch {
      /* storage unavailable - non-fatal, connection still works this session */
    }
    setIdentity(result.identity);
    setStatus('connected');
    return client;
  }, []);

  const connect = useCallback(async (): Promise<PublicIdentity> => {
    setStatus('connecting');
    setError(null);
    try {
      const client = await openClient();
      const id = client.walletIdentity;
      if (!id) throw new Error('Wallet did not return an identity.');
      return id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      setStatus('error');
      throw e;
    }
  }, [openClient]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      const client = await openClient();
      const result = await client.intent('sign_message', { message });
      return extractSignature(result);
    },
    [openClient],
  );

  const getUctBalance = useCallback(
    async (coinId: string, decimals: number): Promise<string | null> => {
      const client = clientRef.current;
      if (!client?.isConnected) return null; // no live session - never force a popup for a read
      // Bridges to sphere.payments.getAssets(coinId) - the same Asset shape the
      // backend sums (symbol / coinId / confirmedAmount / totalAmount, base units).
      const assets = (await client.query('sphere_getAssets', { coinId })) as {
        symbol?: string;
        coinId?: string;
        confirmedAmount?: string;
        totalAmount?: string;
      }[];
      let total = 0n;
      for (const a of assets ?? []) {
        if (a.symbol !== 'UCT' && a.coinId !== coinId) continue;
        try {
          total += BigInt(a.confirmedAmount || a.totalAmount || '0');
        } catch {
          /* ignore a malformed row */
        }
      }
      return formatUnits(total.toString(), decimals);
    },
    [],
  );

  const deposit = useCallback(
    async (params: { to: string; amountBase: string; coinId: string; memo?: string }) => {
      const client = await openClient();
      await client.intent('send', {
        to: params.to,
        amount: params.amountBase,
        coinId: params.coinId,
        ...(params.memo ? { memo: params.memo } : {}),
      });
    },
    [openClient],
  );

  const disconnect = useCallback(async () => {
    try {
      await clientRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      transportRef.current?.destroy();
    } catch {
      /* ignore */
    }
    try {
      popupRef.current?.close();
    } catch {
      /* ignore */
    }
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(IDENTITY_KEY);
    clientRef.current = null;
    transportRef.current = null;
    popupRef.current = null;
    setIdentity(null);
    setStatus('idle');
  }, []);

  return { status, identity, error, connect, disconnect, signMessage, getUctBalance, deposit };
}
