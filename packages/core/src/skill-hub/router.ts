import { appError, fail, ok, resourceRefKey } from '@flowmate/contracts';
import type { ResourceRef, Result } from '@flowmate/contracts';

/** Match Pi 0.85.1's literal prefix and space delimiter, without keyword routing. */
export function resolveRequiredSkill(text: string, requested: ResourceRef | undefined,
  available: readonly ResourceRef[]): Result<ResourceRef | null> {
  const space = text.indexOf(' '), name = text.startsWith('/skill:') ? text.slice(7, space < 0 ? undefined : space) : null;
  const command = name === null ? null : available.find(ref => ref.kind === 'skill' && ref.id === name);
  if (name !== null && !command || requested && (requested.kind !== 'skill'
    || !available.some(ref => resourceRefKey(ref) === resourceRefKey(requested))
    || command && resourceRefKey(command) !== resourceRefKey(requested)))
    return fail(appError('resource_required_unavailable', 'input', 'The explicitly requested Skill is not enabled at this version.'));
  return ok(requested ?? command ?? null);
}
