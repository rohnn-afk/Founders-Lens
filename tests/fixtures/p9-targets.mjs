// Fixed loopback targets belong to acceptance infrastructure, never application code.
export const p9AcceptanceTarget = Object.freeze({ primaryPort: 55441, authorityPort: 55442, redisPort: 56383,
  database: 'founders_lens_cedar_acceptance' });
export const p9RecheckTarget = Object.freeze({ primaryPort: 55443, authorityPort: 55444, redisPort: 56384,
  database: 'founders_lens_cedar_recheck' });
export const p9OfflineTarget = Object.freeze({ primaryPort: 55445, authorityPort: 55446, redisPort: 56385,
  database: 'founders_lens_offline_acceptance' });
