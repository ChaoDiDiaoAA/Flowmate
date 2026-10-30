import { appError, fail, ok, PersonalAgentSnapshotSchema, PersonalAgentUpdateRequestSchema } from '@flowmate/contracts';
import type { AppError, PersonalAgentConfiguration, PersonalAgentSnapshot, PersonalAgentUpdateRequest, Result } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

export interface PersonalAgentRepository {
  getDefault(): Result<PersonalAgentSnapshot | null>;
  ensureDefault(configuration: PersonalAgentConfiguration, at: string): Result<PersonalAgentSnapshot>;
  update(input: PersonalAgentUpdateRequest & { at: string }): Result<PersonalAgentSnapshot>;
}

type AgentRow = { id: number; revision: number; configuration_json: string; created_at: string; updated_at: string };
class AgentFault extends Error { constructor(readonly error: AppError) { super(error.code); } }
const invalid = () => fail(appError('input_invalid', 'input', 'Personal Agent configuration or update is invalid.'));

function snapshot(row: AgentRow): PersonalAgentSnapshot {
  try {
    return PersonalAgentSnapshotSchema.parse({ personalAgentId: row.id, revision: row.revision, runtimeKind: 'durable',
      configuration: JSON.parse(row.configuration_json), createdAt: row.created_at, updatedAt: row.updated_at });
  } catch { throw new AgentFault(appError('storage_corrupt', 'storage', 'Stored Personal Agent configuration is invalid.')); }
}

export function createPersonalAgentRepository(db: SynchronousDatabaseExecutor): PersonalAgentRepository {
  const row = () => db.query<AgentRow, []>('SELECT id,revision,configuration_json,created_at,updated_at FROM personal_agents WHERE id=1').get();
  const failure = (error: unknown, code: 'storage_read_failed' | 'storage_write_failed'): Result<never> =>
    fail(error instanceof AgentFault ? error.error : appError(code, 'storage', 'Personal Agent storage is unavailable.', true));
  const write = (operation: () => Result<PersonalAgentSnapshot>): Result<PersonalAgentSnapshot> => {
    try {
      return db.transaction(() => {
        const result = operation();
        if (!result.ok) throw new AgentFault(result.error);
        return result;
      }).immediate();
    } catch (error) { return failure(error, 'storage_write_failed'); }
  };
  return {
    getDefault() {
      try { const stored = row(); return ok(stored ? snapshot(stored) : null); }
      catch (error) { return failure(error, 'storage_read_failed'); }
    },
    ensureDefault(configuration, at) {
      return write(() => {
        const existing = row();
        if (existing) return ok(snapshot(existing));
        const initial = PersonalAgentSnapshotSchema.safeParse({ personalAgentId: 1, revision: 0, runtimeKind: 'durable',
          configuration, createdAt: at, updatedAt: at });
        if (!initial.success) return invalid();
        db.query('INSERT INTO personal_agents(id,revision,configuration_json,created_at,updated_at) VALUES(1,0,?,?,?) ON CONFLICT(id) DO NOTHING')
          .run(JSON.stringify(initial.data.configuration), at, at);
        const stored = row();
        if (!stored) throw new AgentFault(appError('storage_corrupt', 'storage', 'Default Personal Agent was not saved.'));
        return ok(snapshot(stored));
      });
    },
    update(input) {
      const { at, ...request } = input, checked = PersonalAgentUpdateRequestSchema.safeParse(request);
      if (!checked.success) return invalid();
      return write(() => {
        if (checked.data.personalAgentId !== 1) return fail(appError('personal_agent_not_found', 'input', 'Personal Agent does not exist.'));
        const existing = row();
        if (!existing) return fail(appError('personal_agent_not_found', 'input', 'Personal Agent does not exist.'));
        const current = snapshot(existing);
        if (current.revision !== checked.data.expectedRevision || current.revision === Number.MAX_SAFE_INTEGER)
          return fail(appError('state_conflict', 'input', 'Personal Agent revision changed or cannot advance.', true));
        const next = PersonalAgentSnapshotSchema.safeParse({ ...current, revision: current.revision + 1,
          configuration: checked.data.configuration, updatedAt: at });
        if (!next.success) return invalid();
        const changed = db.query('UPDATE personal_agents SET revision=?,configuration_json=?,updated_at=? WHERE id=? AND revision=?')
          .run(next.data.revision, JSON.stringify(next.data.configuration), at, checked.data.personalAgentId, checked.data.expectedRevision).changes;
        if (changed !== 1) return fail(appError('state_conflict', 'input', 'Personal Agent revision changed.', true));
        const stored = row();
        if (!stored) throw new AgentFault(appError('storage_corrupt', 'storage', 'Updated Personal Agent is unavailable.'));
        return ok(snapshot(stored));
      });
    },
  };
}
