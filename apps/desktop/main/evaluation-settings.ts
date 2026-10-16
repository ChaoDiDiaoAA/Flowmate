import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, SaveEvaluationSettingsSchema, EvaluationConfigurationSnapshotSchema,
  type EvaluationConfigurationSnapshot, type EvaluationPlanSummary, type ProductSettings, type Result } from '@flowmate/contracts';
import { validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import type { CredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';

export type EvaluationSettingsPorts = {
  getSettings(): Promise<Result<ProductSettings>>;
  saveSettings(settings: ProductSettings): Promise<Result<ProductSettings>>;
  credentialStore(reference: string): CredentialStore;
};

export function validateBusinessSettings(input: unknown, previous: ProductSettings): Result<ProductSettings> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return validateProductSettings(input);
  const submitted = input as Record<string, unknown>, evaluation = previous.evaluation ?? { agent: null, judge: null };
  if (Object.hasOwn(submitted, 'evaluation') && !isDeepStrictEqual(submitted.evaluation, evaluation))
    return fail(appError('evaluation_settings_separate', 'input', '评测模型须通过专用设置保存。'));
  return validateProductSettings({ ...submitted, evaluation });
}

export async function saveEvaluationSettings(input: unknown, ports: EvaluationSettingsPorts): Promise<Result<ProductSettings>> {
  const parsed = SaveEvaluationSettingsSchema.safeParse(input);
  if (!parsed.success) return fail(appError('input_invalid', 'input', '评测模型配置输入无效。'));
  const previous = await ports.getSettings();
  if (!previous.ok) return previous;
  const update = parsed.data;
  if (previous.data.revision !== update.expectedRevision)
    return fail(appError('config_revision_conflict', 'input', '配置已变化，请刷新后保存。', true));
  const evaluation = previous.data.evaluation ?? { agent: null, judge: null };
  const prior = evaluation[update.role];
  const sameTarget = update.connection && prior && update.connection.api === prior.api && update.connection.baseUrl === prior.baseUrl;
  const reference = update.connection === null ? null
    : update.apiKey !== undefined || !sameTarget ? randomUUID().replaceAll('-', '') : prior!.credentialRef;
  const profile = update.connection === null ? null : { ...update.connection, credentialRef: reference! };
  const next = validateProductSettings({ ...previous.data, evaluation: { ...evaluation, [update.role]: profile } });
  if (!next.ok) return next;
  const created = reference !== null && update.apiKey !== undefined;
  if (created) {
    const written = await ports.credentialStore(reference).write(update.apiKey!);
    if (!written.ok) {
      const removed = await ports.credentialStore(reference).remove();
      if (!removed.ok) return fail(appError('evaluation_credential_cleanup_failed', 'storage', '评测密钥写入失败，且本次未发布密钥未能清理；原配置未更改。'));
      return written;
    }
  }
  let saved: Result<ProductSettings>;
  try { saved = await ports.saveSettings(next.data); }
  catch { saved = fail(appError('operation_result_unknown', 'runtime', '设置保存结果未知，请刷新核对。', true)); }
  if (!saved.ok && saved.error.category === 'runtime') {
    try {
      const observed = await ports.getSettings();
      if (observed.ok && observed.data.revision > previous.data.revision && isDeepStrictEqual(observed.data.evaluation?.[update.role], profile))
        saved = ok(observed.data);
    } catch { /* An uncertain publication must retain its possibly committed credential. */ }
  }
  if (!saved.ok) {
    if (created && saved.error.category !== 'runtime') {
      const removed = await ports.credentialStore(reference!).remove();
      if (!removed.ok) return fail(appError('evaluation_credential_cleanup_failed', 'storage', '评测设置未发布，且本次新密钥未能清理；原配置未更改。'));
    }
    return saved;
  }
  const retained = new Set([...saved.data.models.map(model => model.credentialRef),
    ...Object.values(saved.data.evaluation ?? {}).flatMap(role => role ? [role.credentialRef] : [])]);
  if (prior && !retained.has(prior.credentialRef)) {
    const removed = await ports.credentialStore(prior.credentialRef).remove();
    if (!removed.ok) process.stderr.write('[Flowmate] An obsolete evaluation credential could not be removed.\n');
  }
  return saved;
}

export async function evaluationCredentialStatus(settings: ProductSettings, store: EvaluationSettingsPorts['credentialStore']) {
  const roles = settings.evaluation ?? { agent: null, judge: null };
  return { agent: roles.agent ? await store(roles.agent.credentialRef).status() : 'missing' as const,
    judge: roles.judge ? await store(roles.judge.credentialRef).status() : 'missing' as const };
}

export async function evaluationConfigurationSnapshot(settings: ProductSettings, store: EvaluationSettingsPorts['credentialStore']): Promise<EvaluationConfigurationSnapshot> {
  const roles = settings.evaluation ?? { agent: null, judge: null };
  const { credentialRef: agentReference, ...agent } = roles.agent ?? {};
  const { credentialRef: judgeReference, ...judge } = roles.judge ?? {};
  return EvaluationConfigurationSnapshotSchema.parse({ revision: settings.revision, agent: roles.agent ? agent : null,
    judge: roles.judge ? judge : null, credentials: await evaluationCredentialStatus(settings, store) });
}

export async function prepareEvaluationCredentials(preview: { settings: EvaluationConfigurationSnapshot;
  plan: Pick<EvaluationPlanSummary, 'judgeMaxGenerations' | 'judgeRequired'> }, current: ProductSettings,
  store: EvaluationSettingsPorts['credentialStore']): Promise<Result<{ settings: EvaluationConfigurationSnapshot;
    credentials: { agent: string; judge: string | null } }>> {
  const changed = () => fail(appError('evaluation_preview_changed', 'input', '评测模型或凭据状态已变化，请重新预览。', true));
  if (current.revision !== preview.settings.revision) return changed();
  const settings = await evaluationConfigurationSnapshot(current, store);
  if (!isDeepStrictEqual(settings, preview.settings)) return changed();
  const roles = current.evaluation;
  const needsJudge = preview.plan.judgeMaxGenerations > 0 && !!roles?.judge && settings.credentials.judge === 'configured';
  if (!roles?.agent || settings.credentials.agent !== 'configured' || preview.plan.judgeRequired && !needsJudge)
    return fail(appError('evaluation_not_ready', 'input', '所选评测所需专用模型或凭据不可用。'));
  const agent = await store(roles.agent.credentialRef).read(); if (!agent.ok) return agent;
  if (!agent.data?.trim()) return fail(appError('evaluation_not_ready', 'input', '评测Agent凭据不可用。'));
  let judge: string | null = null;
  if (needsJudge) {
    const read = await store(roles.judge!.credentialRef).read(); if (!read.ok) return read;
    if (!read.data?.trim()) return fail(appError('evaluation_not_ready', 'input', '评测Judge凭据不可用。'));
    judge = read.data;
  }
  return ok({ settings, credentials: { agent: agent.data, judge } });
}
