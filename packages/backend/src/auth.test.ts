import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { signMessage, verifySignedMessage, recoverPubkeyFromSignature } from '@unicitylabs/sphere-sdk';
import { AuthService, principalOf, normalizeNametag, type Identity } from './auth.js';

/** A throwaway secp256k1 wallet: a random private key + its compressed pubkey. */
function makeWallet(): { priv: string; pub: string } {
  const priv = crypto.randomBytes(32).toString('hex');
  const probe = signMessage(priv, 'probe');
  return { priv, pub: recoverPubkeyFromSignature('probe', probe) };
}

function newAuth(now: () => number = () => Date.now()): AuthService {
  return new AuthService({ sessionSecret: 'test-secret', verify: verifySignedMessage, now });
}

describe('AuthService - Sign-In-With-Wallet', () => {
  it('accepts a correctly signed challenge and issues a usable session', () => {
    const auth = newAuth();
    const wallet = makeWallet();

    const challenge = auth.issueChallenge(wallet.pub);
    expect(challenge.message).toContain(wallet.pub);

    const signature = signMessage(wallet.priv, challenge.message);
    const { token, identity } = auth.login({ nonce: challenge.nonce, signature, nametag: '@alice' });

    expect(identity.chainPubkey).toBe(wallet.pub);
    expect(identity.nametag).toBe('alice');

    const session = auth.verifySession(token);
    expect(session).not.toBeNull();
    expect(session!.chainPubkey).toBe(wallet.pub);
    expect(session!.nametag).toBe('alice');
  });

  it('rejects a signature from a different wallet', () => {
    const auth = newAuth();
    const wallet = makeWallet();
    const attacker = makeWallet();

    const challenge = auth.issueChallenge(wallet.pub);
    const forged = signMessage(attacker.priv, challenge.message); // signed by the wrong key

    expect(() => auth.login({ nonce: challenge.nonce, signature: forged })).toThrow(/did not match/);
  });

  it('rejects a tampered challenge message', () => {
    const auth = newAuth();
    const wallet = makeWallet();

    const challenge = auth.issueChallenge(wallet.pub);
    const signature = signMessage(wallet.priv, `${challenge.message} (tampered)`);

    expect(() => auth.login({ nonce: challenge.nonce, signature })).toThrow(/did not match/);
  });

  it('makes each nonce single-use', () => {
    const auth = newAuth();
    const wallet = makeWallet();

    const challenge = auth.issueChallenge(wallet.pub);
    const signature = signMessage(wallet.priv, challenge.message);

    auth.login({ nonce: challenge.nonce, signature });
    expect(() => auth.login({ nonce: challenge.nonce, signature })).toThrow(/not found or already used/);
  });

  it('rejects an expired challenge', () => {
    let clock = 1_000_000;
    const auth = newAuth(() => clock);
    const wallet = makeWallet();

    const challenge = auth.issueChallenge(wallet.pub);
    const signature = signMessage(wallet.priv, challenge.message);
    clock += 6 * 60_000; // past the 5-minute challenge TTL

    expect(() => auth.login({ nonce: challenge.nonce, signature })).toThrow(/expired/);
  });

  it('rejects an invalid chain public key at challenge time', () => {
    const auth = newAuth();
    expect(() => auth.issueChallenge('not-a-pubkey')).toThrow(/valid chain public key/);
  });

  it('rejects a forged / tampered session token', () => {
    const auth = newAuth();
    const wallet = makeWallet();
    const challenge = auth.issueChallenge(wallet.pub);
    const signature = signMessage(wallet.priv, challenge.message);
    const { token } = auth.login({ nonce: challenge.nonce, signature });

    expect(auth.verifySession(`${token}x`)).toBeNull(); // mutated HMAC
    expect(auth.verifySession('garbage.token')).toBeNull();
    expect(auth.verifySession(undefined)).toBeNull();

    // A token minted with a different secret must not verify.
    const other = new AuthService({ sessionSecret: 'different-secret', verify: verifySignedMessage });
    const c2 = other.issueChallenge(wallet.pub);
    const s2 = signMessage(wallet.priv, c2.message);
    const foreign = other.login({ nonce: c2.nonce, signature: s2 }).token;
    expect(auth.verifySession(foreign)).toBeNull();
  });

  it('expires a session token past its TTL', () => {
    let clock = 5_000_000;
    const auth = new AuthService({
      sessionSecret: 'test-secret',
      verify: verifySignedMessage,
      sessionTtlMs: 60_000,
      now: () => clock,
    });
    const wallet = makeWallet();
    const challenge = auth.issueChallenge(wallet.pub);
    const signature = signMessage(wallet.priv, challenge.message);
    const { token } = auth.login({ nonce: challenge.nonce, signature });

    expect(auth.verifySession(token)).not.toBeNull();
    clock += 61_000;
    expect(auth.verifySession(token)).toBeNull();
  });
});

describe('identity helpers', () => {
  it('principalOf prefers the nametag, falls back to the pubkey', () => {
    const withTag: Identity = { chainPubkey: '02'.padEnd(66, 'a'), nametag: 'scout' };
    const bare: Identity = { chainPubkey: '02'.padEnd(66, 'b') };
    expect(principalOf(withTag)).toBe('@scout');
    expect(principalOf(bare)).toBe('02'.padEnd(66, 'b'));
  });

  it('normalizeNametag strips @, rejects junk', () => {
    expect(normalizeNametag('@alice')).toBe('alice');
    expect(normalizeNametag('  bob  ')).toBe('bob');
    expect(normalizeNametag('a')).toBeUndefined(); // too short
    expect(normalizeNametag('has spaces')).toBeUndefined();
    expect(normalizeNametag(undefined)).toBeUndefined();
  });
});
