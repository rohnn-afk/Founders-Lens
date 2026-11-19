// Default suppression adapter. Callers can use it before an independent authority
// is configured. It supplies no clearance, so private operations fail closed.

import type { SuppressionAuthority } from './suppression-authority.js';

// The only runtime implementation. No file, PostgreSQL or Redis negative clearance.
export function unavailableSuppressionAuthority(): SuppressionAuthority {
  return Object.freeze({ async lookup() { return null; } });
}
