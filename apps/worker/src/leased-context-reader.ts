/** Restricted PostgreSQL projection for an independently authorized generation lease. */
import type { Pool } from 'pg';

export function leasedContextReader(connection: Pool,
  issueGrant: (attempt: string, lease: number, contextVersion: number) => Promise<void>) {
  return async (scope: { id: string; contextEpoch: number }, lease: { epoch: number }): Promise<unknown> => {
    await issueGrant(scope.id, lease.epoch, scope.contextEpoch);
    const { rows: [row] } = await connection.query<{ context: unknown }>(
      'SELECT p9_context.read_attempt($1,$2,$3) AS context', [scope.id, lease.epoch, scope.contextEpoch]);
    return row?.context;
  };
}
