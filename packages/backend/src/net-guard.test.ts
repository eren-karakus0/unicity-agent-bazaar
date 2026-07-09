import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedAddress } from './net-guard.js';

describe('net-guard (SSRF)', () => {
  it('flags loopback / private / link-local / metadata literals', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows public literals', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('ftp://example.com/')).rejects.toThrow();
    await expect(assertPublicUrl('not a url')).rejects.toThrow();
  });

  it('blocks metadata / rfc1918 / loopback / .local URLs', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(assertPublicUrl('http://127.0.0.1:4600/admin')).rejects.toThrow();
    await expect(assertPublicUrl('http://192.168.0.1/')).rejects.toThrow();
    await expect(assertPublicUrl('http://localhost:9000/')).rejects.toThrow();
    await expect(assertPublicUrl('http://db.internal/')).rejects.toThrow();
  });

  it('honors the trusted-host allowlist for first-party loopback only', async () => {
    const allow = new Set(['127.0.0.1:45001']);
    await expect(assertPublicUrl('http://127.0.0.1:45001/', allow)).resolves.toBeInstanceOf(URL);
    // a loopback origin that is NOT allowlisted stays blocked
    await expect(assertPublicUrl('http://127.0.0.1:45002/', allow)).rejects.toThrow();
  });
});
