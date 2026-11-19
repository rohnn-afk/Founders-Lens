// Authentication input adapter. The Clerk boundary calls it to extract exactly
// one bearer credential before passing anything to the verification SDK.

import type { IncomingHttpHeaders } from 'node:http';
import { SecurityError } from './errors.js';

// A bearer credential can be presented by whoever holds it. Inspect the raw
// headers for duplicates before relying on Node's normalized header value.
export function bearerToken(headers: IncomingHttpHeaders, rawHeaders: readonly string[]): string {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'authorization') count++;
  }
  const value = headers.authorization;
  // API authentication has exactly one source. Never let cookies refresh a bearer.
  if (count !== 1 || typeof value !== 'string' || headers.cookie !== undefined || value.length > 16_384) {
    throw new SecurityError('UNAUTHENTICATED');
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(value);
  if (!match?.[1]) throw new SecurityError('UNAUTHENTICATED');
  return match[1];
}
