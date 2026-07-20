import { describe, it, expect } from 'vitest';
import { termsPage, privacyPage, refundPage, type LegalConfig } from '../src/dashboard/pages';

const filled: LegalConfig = {
  entity: 'Acme LLC',
  email: 'legal@acme.test',
  jurisdiction: 'Delaware, USA',
  lastUpdated: '2026-07-20',
};

const placeholder: LegalConfig = {
  entity: '[LEGAL ENTITY]',
  email: '[CONTACT EMAIL]',
  jurisdiction: '[JURISDICTION]',
  lastUpdated: '2026-07-20',
};

describe('legal pages', () => {
  it('render all three with entity + contact interpolated', () => {
    for (const render of [termsPage, privacyPage, refundPage]) {
      const html = render(filled);
      expect(html).toContain('Acme LLC');
      expect(html).toContain('legal@acme.test');
      expect(html).toContain('<footer');
      // footer links present on every legal page
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/refunds"');
    }
  });

  it('show a finalize warning when placeholders are unset', () => {
    expect(termsPage(placeholder)).toContain('Template not finalized');
    expect(termsPage(filled)).not.toContain('Template not finalized');
  });

  it('escape a hostile entity value (no XSS via env)', () => {
    const evil = { ...filled, entity: '<script>alert(1)</script>' };
    const html = termsPage(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
