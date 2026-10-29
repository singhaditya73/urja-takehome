import { createHmac } from 'node:crypto';

/**
 * Signature scheme used by the portal's bulk-export endpoint, reverse
 * engineered from the bundled client script:
 *
 *   canonical = "<METHOD>\n" + "<path>\n" + "<query-string>\n" + "<epoch-seconds>"
 *   signature = hex( HMAC-SHA256( signingSecret, canonical ) )
 *
 * Sent as `x-timestamp` and `x-signature` headers. The server validates the
 * timestamp against a small window (observed: within ~90 seconds) and rejects
 * anything else with 401 signature_invalid.
 */
export function makeCanonical(method: string, path: string, query: string, timestampSeconds: number): string {
  return [method, path, query, String(timestampSeconds)].join('\n');
}

export function signRequest(method: string, path: string, query: string, timestampSeconds: number, secret: string): string {
  return createHmac('sha256', secret).update(makeCanonical(method, path, query, timestampSeconds)).digest('hex');
}
