import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, HttpError, setAuthToken, type Identity } from './api';
import { useWallet, type WalletStatus } from './useWallet';
import { useToast } from './toast';

const TOKEN_KEY = 'bazaar-session-token';

/** Decode our own session token client-side (the claims are signed, not secret). */
function decodeToken(token: string): { identity: Identity; exp: number } | null {
  try {
    const body = token.slice(0, token.lastIndexOf('.'));
    const pad = body.length % 4 === 0 ? '' : '='.repeat(4 - (body.length % 4));
    const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + pad)) as {
      sub?: string;
      tag?: string;
      exp?: number;
    };
    if (!json.sub || typeof json.exp !== 'number') return null;
    return { identity: { chainPubkey: json.sub, ...(json.tag ? { nametag: json.tag } : {}) }, exp: json.exp };
  } catch {
    return null;
  }
}

export type AuthPhase = 'anonymous' | 'signing-in' | 'authenticated';

export interface AuthContextValue {
  /** The signed-in identity, or null when anonymous. */
  session: Identity | null;
  phase: AuthPhase;
  walletStatus: WalletStatus;
  error: string | null;
  /** The wallet's confirmed UCT balance (human string), or null if unknown. */
  balance: string | null;
  /** Re-read the wallet balance (no-op without a live wallet session). */
  refreshBalance: () => void;
  /** Connect the wallet (if needed) and complete Sign-In-With-Wallet. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The live wallet handle for on-chain actions (e.g. one-click funding). */
  wallet: ReturnType<typeof useWallet>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const toast = useToast();
  const [session, setSession] = useState<Identity | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('anonymous');
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const restored = useRef(false);

  const refreshBalance = useCallback(() => {
    void (async () => {
      try {
        const info = await api.depositInfo();
        const bal = await wallet.getUctBalance(info.coinId, info.decimals);
        if (bal !== null) setBalance(bal);
      } catch {
        /* wallet locked / no permission / offline - keep the last known value */
      }
    })();
  }, [wallet]);

  // Restore a stored session on load. We decode the token locally so the user
  // stays signed in INSTANTLY across refreshes - even while the backend is
  // waking up. A background check only signs out on a definitive 401 (a truly
  // invalid/expired token), never on a transient network error.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const decoded = decodeToken(token);
    if (!decoded || decoded.exp < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    setAuthToken(token);
    setSession(decoded.identity);
    setPhase('authenticated');
    api
      .me()
      .then((identity) => setSession(identity))
      .catch((e) => {
        if (e instanceof HttpError && e.status === 401) {
          setAuthToken(null);
          localStorage.removeItem(TOKEN_KEY);
          setSession(null);
          setPhase('anonymous');
        }
        // else: backend asleep/unreachable - keep the optimistic session.
      });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    setPhase('signing-in');
    try {
      const identity = await wallet.connect(); // opens the wallet, returns { chainPubkey, nametag? }
      const challenge = await api.challenge(identity.chainPubkey);
      const signature = await wallet.signMessage(challenge.message); // wallet approval UI
      const { token, identity: proven } = await api.login({
        nonce: challenge.nonce,
        signature,
        nametag: identity.nametag,
      });
      setAuthToken(token);
      localStorage.setItem(TOKEN_KEY, token);
      setSession(proven);
      setPhase('authenticated');
      toast(`Signed in as ${proven.nametag ? `@${proven.nametag}` : 'your wallet'}`, 'ok');
      refreshBalance(); // we have a live wallet session right after sign-in
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'sign-in failed';
      setError(msg);
      setPhase('anonymous');
      toast(msg, 'bad');
    }
  }, [wallet, toast]);

  const signOut = useCallback(async () => {
    setAuthToken(null);
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
    setPhase('anonymous');
    setBalance(null);
    await wallet.disconnect();
  }, [wallet]);

  return (
    <AuthContext.Provider
      value={{ session, phase, walletStatus: wallet.status, error, balance, refreshBalance, signIn, signOut, wallet }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

/** A short, human display handle for an identity. */
export function displayName(identity: Identity | null): string {
  if (!identity) return '';
  if (identity.nametag) return `@${identity.nametag}`;
  return `${identity.chainPubkey.slice(0, 6)}…${identity.chainPubkey.slice(-4)}`;
}
