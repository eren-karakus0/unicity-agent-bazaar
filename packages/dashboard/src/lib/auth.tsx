import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setAuthToken, type Identity } from './api';
import { useWallet, type WalletStatus } from './useWallet';

const TOKEN_KEY = 'bazaar-session-token';

export type AuthPhase = 'anonymous' | 'signing-in' | 'authenticated';

export interface AuthContextValue {
  /** The signed-in identity, or null when anonymous. */
  session: Identity | null;
  phase: AuthPhase;
  walletStatus: WalletStatus;
  error: string | null;
  /** Connect the wallet (if needed) and complete Sign-In-With-Wallet. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The live wallet handle for on-chain actions (e.g. one-click funding). */
  wallet: ReturnType<typeof useWallet>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [session, setSession] = useState<Identity | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('anonymous');
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  // Restore a stored session token on load and validate it against the backend.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    setAuthToken(token);
    api
      .me()
      .then((identity) => {
        setSession(identity);
        setPhase('authenticated');
      })
      .catch(() => {
        // Expired / invalid — clear it.
        setAuthToken(null);
        localStorage.removeItem(TOKEN_KEY);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sign-in failed');
      setPhase('anonymous');
    }
  }, [wallet]);

  const signOut = useCallback(async () => {
    setAuthToken(null);
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
    setPhase('anonymous');
    await wallet.disconnect();
  }, [wallet]);

  return (
    <AuthContext.Provider
      value={{ session, phase, walletStatus: wallet.status, error, signIn, signOut, wallet }}
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
