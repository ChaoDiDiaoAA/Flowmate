import { appError, fail, ok, PersonalAgentConfigurationSchema, PersonalAgentUpdateRequestSchema,
  PersonalAgentOpenConversationRequestSchema } from '@flowmate/contracts';
import type { PersonalAgentApi, PersonalAgentConfiguration, PersonalAgentOpenConversationRequest,
  PersonalAgentConversation, PersonalAgentSnapshot, PersonalAgentUpdateRequest, Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

export type PersonalAgentServiceOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  now: () => string;
  validateConfiguration: (configuration: PersonalAgentConfiguration) => Result<void> | Promise<Result<void>>;
};

const invalid = () => fail(appError('input_invalid', 'input', 'Personal Agent request is invalid.'));
const readFailure = () => fail(appError('storage_read_failed', 'storage', 'Personal Agent state could not be read.', true));
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'Personal Agent configuration could not be saved.', true));

export class PersonalAgentService implements PersonalAgentApi {
  public constructor(private readonly options: PersonalAgentServiceOptions) {}

  private async readDefault(): Promise<Result<PersonalAgentSnapshot | null>> {
    try { return await this.options.database.read(scope => scope.personalAgents.getDefault()); }
    catch { return readFailure(); }
  }

  private async validate(configuration: PersonalAgentConfiguration): Promise<Result<void>> {
    try { return await this.options.validateConfiguration(configuration); }
    catch { return fail(appError('personal_agent_configuration_unavailable', 'input', 'Personal Agent configuration references could not be checked.', true)); }
  }

  public async initialize(defaultConfiguration: PersonalAgentConfiguration): Promise<Result<PersonalAgentSnapshot>> {
    const parsed = PersonalAgentConfigurationSchema.safeParse(defaultConfiguration);
    const current = await this.readDefault();
    if (!current.ok) return current;
    if (current.data) return ok(current.data);
    if (!parsed.success) return invalid();
    const validated = await this.validate(parsed.data);
    if (!validated.ok) return validated;
    try {
      return await this.options.database.transaction(scope => scope.personalAgents.ensureDefault(parsed.data, this.options.now()));
    } catch { return writeFailure(); }
  }

  public async get(): Promise<Result<PersonalAgentSnapshot>> {
    const current = await this.readDefault();
    if (!current.ok) return current;
    return current.data ? ok(current.data) : fail(appError('personal_agent_not_found', 'input', 'Personal Agent has not been initialized.'));
  }

  public async update(input: PersonalAgentUpdateRequest): Promise<Result<PersonalAgentSnapshot>> {
    const parsed = PersonalAgentUpdateRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const validated = await this.validate(parsed.data.configuration);
    if (!validated.ok) return validated;
    try {
      return await this.options.database.transaction(scope => scope.personalAgents.update({ ...parsed.data, at: this.options.now() }));
    } catch { return writeFailure(); }
  }

  public async openConversation(input: PersonalAgentOpenConversationRequest): Promise<Result<PersonalAgentConversation>> {
    const parsed = PersonalAgentOpenConversationRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    try {
      return await this.options.database.read(scope => {
        const original = scope.invoiceWorks.get({ view: 'work', workId: parsed.data.workId, limit: 1 });
        if (!original.ok) return original;
        const { workId, sessionId, runtimeKind } = original.data.work;
        return ok({ workId, sessionId, runtimeKind });
      });
    } catch { return readFailure(); }
  }
}
