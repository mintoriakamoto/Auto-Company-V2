import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../src/crypto';
import { buildResendPayload, emailConfigured, apiKeyEmail } from '../src/email';
import type { Env } from '../src/types';

describe('encryptSecret / decryptSecret', () => {
  const SECRET = 'auth-secret-value';

  it('round-trips a value', async () => {
    const packed = await encryptSecret(SECRET, 'sk_live_abc123');
    expect(packed).not.toContain('sk_live_abc123'); // not plaintext
    expect(await decryptSecret(SECRET, packed)).toBe('sk_live_abc123');
  });

  it('uses a fresh IV (different ciphertext each call)', async () => {
    const a = await encryptSecret(SECRET, 'same');
    const b = await encryptSecret(SECRET, 'same');
    expect(a).not.toBe(b);
    expect(await decryptSecret(SECRET, a)).toBe('same');
    expect(await decryptSecret(SECRET, b)).toBe('same');
  });

  it('returns null for the wrong secret or tampered input', async () => {
    const packed = await encryptSecret(SECRET, 'secret-key');
    expect(await decryptSecret('wrong-secret', packed)).toBeNull();
    expect(await decryptSecret(SECRET, packed.slice(0, -4) + 'AAAA')).toBeNull();
    expect(await decryptSecret(SECRET, 'not-base64!!')).toBeNull();
  });
});

describe('email helpers', () => {
  it('is unconfigured until both key and from are set', () => {
    expect(emailConfigured({} as Env)).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: 'x' } as Env)).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: 'x', EMAIL_FROM: 'a@b' } as Env)).toBe(true);
  });

  it('builds a Resend payload', () => {
    const p = buildResendPayload('SnapOG <k@snapog.dev>', {
      to: 'u@x.co',
      subject: 'Hi',
      html: '<p>x</p>',
    });
    expect(p).toEqual({
      from: 'SnapOG <k@snapog.dev>',
      to: ['u@x.co'],
      subject: 'Hi',
      html: '<p>x</p>',
    });
  });

  it('key email embeds the key and a dashboard link', () => {
    const msg = apiKeyEmail('u@x.co', 'sk_abc', 'https://snapog.dev');
    expect(msg.html).toContain('sk_abc');
    expect(msg.html).toContain('https://snapog.dev/dashboard?key=sk_abc');
  });
});
