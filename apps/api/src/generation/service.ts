// Isolated use cases. The service obtains independent scope evidence outside
// transactions, then relies on the repository to recheck local state under locks.
import { authorizeChild, type IdeaScope } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, type SuppressionAuthority } from '../security/suppression-authority.js';
import type { Command, CommandResult, Generation } from './contracts.js';

export type Scope = { id: string; ideaId: string; idea: IdeaScope };
export interface GenerationRepository {
  scope(principal: Principal, target: string, attempt: boolean): Promise<Scope | null>;
  status(principal: Principal, scope: Scope, id: string): Promise<Generation>;
  command(principal: Principal, scope: Scope, command: Command): Promise<CommandResult>;
}

export function createGenerationService(repository: GenerationRepository, authority: SuppressionAuthority) {
  async function scope(principal: Principal, target: string, attempt: boolean, write: boolean) {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (!principal.subjectKeys.length) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) {
      await requireClearance(authority, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
        subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
    }
    const current = await repository.scope(principal, target, attempt);
    await authorizeChild(principal, current?.idea ?? null, current, authority, write ? 'write' : 'read');
    if (!current || (!attempt && current.id !== target)) throw new SecurityError('RESOURCE_NOT_FOUND');
    return current;
  }
  return {
    async status(principal: Principal, id: string) {
      return repository.status(principal, await scope(principal, id, true, false), id);
    },
    async command(principal: Principal, command: Command) {
      return repository.command(principal, await scope(principal, command.target, command.kind === 'cancel', true), command);
    }
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
