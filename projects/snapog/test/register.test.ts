import { describe, it, expect } from 'vitest';
import { keyCreatedPage } from '../src/dashboard/pages';

// The registration handler now writes a hardcoded 'free' tier for every new
// key (the paid tier is granted only by the Stripe webhook after payment).
// These tests lock the user-facing contract of that fix: a new key always
// reads as FREE, and a paid *intent* becomes a checkout CTA — never a free
// paid key.
describe('new API key is always Free; paid intent -> checkout', () => {
  it('always renders the key as FREE', () => {
    for (const intent of [undefined, 'pro', 'business'] as const) {
      expect(keyCreatedPage('sk_test', 'a@b.co', intent)).toContain('API KEY — FREE');
    }
  });

  it('offers a checkout CTA (not a free upgrade) for Pro intent', () => {
    const html = keyCreatedPage('sk_test', 'a@b.co', 'pro');
    expect(html).toContain('Continue to payment');
    expect(html).toContain('$19');
    expect(html).toContain('action="/billing/checkout"');
    expect(html).toContain('value="pro"');
  });

  it('offers Business checkout for Business intent', () => {
    const html = keyCreatedPage('sk_test', 'a@b.co', 'business');
    expect(html).toContain('$49');
    expect(html).toContain('value="business"');
  });

  it('shows no upgrade CTA for a plain free signup', () => {
    const html = keyCreatedPage('sk_test', 'a@b.co', undefined);
    expect(html).not.toContain('Continue to payment');
  });

  it('escapes the key in the checkout form value', () => {
    const html = keyCreatedPage('"><x', 'a@b.co', 'pro');
    expect(html).not.toContain('value=""><x"');
    expect(html).toContain('&quot;&gt;&lt;x');
  });
});
