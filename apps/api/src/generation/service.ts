// Isolated use cases. The service obtains independent scope evidence outside
// transactions, then relies on the repository to recheck local state under locks.
import { authorizeChild, type IdeaScope } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, suppressionWindow, type SuppressionAuthority } from '../security/suppression-authority.js';
import type { Command, CommandResult, Generation } from './contracts.js';

export type Scope = { id: string; ideaId: string; idea: IdeaScope };
export interface GenerationRepository {
  scope(principal: Principal, target: string, attempt: boolean): Promise<Scope | null>;
  status(principal: Principal, scope: Scope, id: string, requireFresh?: () => void, activeOnly?: boolean): Promise<Generation>;
  command(principal: Principal, scope: Scope, command: Command): Promise<CommandResult>;
}

export function createGenerationService(repository: GenerationRepository, authority: SuppressionAuthority,
  statusDeadline?: () => Promise<number>, statusConversation?: string) {
  async function scope(principal: Principal, target: string, attempt: boolean, write: boolean, source = authority) {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (!principal.subjectKeys.length) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) {
      await requireClearance(source, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
        subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
    }
    const current = await repository.scope(principal, target, attempt);
    await authorizeChild(principal, current?.idea ?? null, current, source, write ? 'write' : 'read');
    if (!current || (!attempt && current.id !== target)) throw new SecurityError('RESOURCE_NOT_FOUND');
    return current;
  }
  return {
    async status(principal: Principal, id: string, activeOnly = false) {
      const deadline = await statusDeadline?.();
      const window = suppressionWindow(authority);
      const current = await scope(principal, id, true, activeOnly, window.authority);
      if (statusConversation && current.id !== statusConversation) throw new SecurityError('RESOURCE_NOT_FOUND');
      function requireFresh() {
        window.requireFresh();
        if (deadline !== undefined && Date.now() >= deadline) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
      const result = await repository.status(principal, current, id, requireFresh, activeOnly);
      requireFresh();
      return result;
    },
    async command(principal: Principal, command: Command) {
      return repository.command(principal, await scope(principal, command.target, command.kind === 'cancel', true), command);
    }
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
