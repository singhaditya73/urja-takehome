import { describe, expect, it } from 'vitest';
import { makeCanonical, signRequest } from '../src/portal/sign.js';

describe('HMAC request signing', () => {
  it('matches the canonical string the portal signs', () => {
    // Verified against the portal: GET /portal/export?page=1 signed this way is accepted.
    expect(makeCanonical('GET', '/portal/export', 'page=1', 1769490000)).toBe(
      'GET\n/portal/export\npage=1\n1769490000'
    );
  });

  it('produces the expected hex HMAC-SHA256', () => {
    const signed = signRequest('GET', '/portal/export', 'page=1', 1769490000, 'secret');
    expect(signed).toMatch(/^[0-9a-f]{64}$/);
    expect(signed).toBe(
      // independently computed reference value
      '4d7c39864c5cc896e88b3b4674285f35019120cdd16976a04a75bcc48a9c99b3'
    );
  });
});
