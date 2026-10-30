import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, SaveEvaluationSettingsSchema, EvaluationConfigurationSnapshotSchema,
  type EvaluationConfigurationSnapshot, type EvaluationPlanSummary, type ProductSettings, type Result } from '@flowmate/contracts';
import { validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import type { CredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import { experimentPlanSchema } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { localAgentCredential, sameAgentConnection, type EvaluationAgentCredential } from '../../../agent-eval/src/configuration.ts';
import { registerSecrets } from '../../../agent-eval/src/execution/evidence-safety.ts';

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
  const native = update.connection && 'provider' in update.connection;
  const sameTarget = update.connection && 'api' in update.connection && prior && 'api' in prior
    && update.connection.api === prior.api && update.connection.baseUrl === prior.baseUrl;
  const reference = update.connection === null || native ? null
    : update.apiKey !== undefined || !sameTarget ? randomUUID().replaceAll('-', '') : prior && 'credentialRef' in prior ? prior.credentialRef : null;
  const profile = update.connection === null ? null : native ? update.connection : { ...update.connection, credentialRef: reference! };
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
    ...Object.values(saved.data.evaluation ?? {}).flatMap(role => role && 'credentialRef' in role ? [role.credentialRef] : [])]);
  if (prior && 'credentialRef' in prior && !retained.has(prior.credentialRef)) {
    const removed = await ports.credentialStore(prior.credentialRef).remove();
    if (!removed.ok) process.stderr.write('[Flowmate] An obsolete evaluation credential could not be removed.\n');
  }
  return saved;
}

export async function evaluationCredentialStatus(settings: ProductSettings, store: EvaluationSettingsPorts['credentialStore']) {
  const roles = settings.evaluation ?? { agent: null, judge: null };
  return { agent: roles.agent ? await store(roles.agent.credentialRef).status() : 'missing' as const,
    judge: roles.judge ? 'credentialRef' in roles.judge ? await store(roles.judge.credentialRef).status() : 'configured' as const : 'missing' as const };
}

export async function evaluationConfigurationSnapshot(settings: ProductSettings, store: EvaluationSettingsPorts['credentialStore']): Promise<EvaluationConfigurationSnapshot> {
  const roles = settings.evaluation ?? { agent: null, judge: null };
  const { credentialRef: agentReference, ...agent } = roles.agent ?? {};
  const judge = roles.judge && 'credentialRef' in roles.judge ? (({ credentialRef: _, ...connection }) => connection)(roles.judge) : roles.judge;
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
  if (needsJudge && roles.judge && 'credentialRef' in roles.judge) {
    const read = await store(roles.judge!.credentialRef).read(); if (!read.ok) return read;
    if (!read.data?.trim()) return fail(appError('evaluation_not_ready', 'input', '评测Judge凭据不可用。'));
    judge = read.data;
  }
  return ok({ settings, credentials: { agent: agent.data, judge } });
}

export async function prepareExperimentCredentials(plan: unknown, settings: ProductSettings,
  store: EvaluationSettingsPorts['credentialStore']): Promise<Result<EvaluationAgentCredential[]>> {
  const parsed = experimentPlanSchema.safeParse(plan);
  if (!parsed.success) return fail(appError('input_invalid', 'input', '实验计划无效。'));
  const targets: Array<{ connection: EvaluationAgentCredential['connection']; reference: string | null }> = [];
  for (const arm of [parsed.data.control, ...parsed.data.candidates]) {
    const fallback = settings.evaluation?.agent;
    const connection = arm.model ? (({ reasoning: _, ...connection }) => connection)(arm.model)
      : fallback ? (({ credentialRef: _, ...connection }) => connection)(fallback) : null;
    if (!connection) continue;
    const matches = arm.model ? settings.models.filter(profile => sameAgentConnection(profile, connection)) : [];
    if (matches.length > 1) return fail(appError('evaluation_not_ready', 'input', '实验连接匹配多个模型配置，请先消除歧义。'));
    const matched = matches[0] ?? (fallback && sameAgentConnection(fallback, connection) ? fallback : null);
    if (!matched) continue;
    const reference = localAgentCredential(connection) ? null : matched.credentialRef;
    const prior = targets.find(target => sameAgentConnection(target.connection, connection));
    if (prior && prior.reference !== reference) return fail(appError('evaluation_not_ready', 'input', '同一实验连接选择了不同凭据。'));
    if (!prior) targets.push({ connection, reference });
  }
  const credentials: EvaluationAgentCredential[] = [];
  for (const target of targets) {
    let apiKey = localAgentCredential(target.connection);
    if (apiKey === null) {
      const result = await store(target.reference!).read(); if (!result.ok) return result;
      const raw = result.data?.trim();
      if (!raw) return fail(appError('evaluation_not_ready', 'input', '实验模型 API 凭据不可用。'));
      if (raw.startsWith('pi-credential-v1:')) {
        try {
          const credential = JSON.parse(raw.slice('pi-credential-v1:'.length));
          if (credential?.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key.trim()) throw Error('API credential required');
          apiKey = credential.key.trim();
        } catch { return fail(appError('evaluation_not_ready', 'input', '实验模型需要可读取的 API key；不能转发其他认证数据。')); }
      } else apiKey = raw;
    }
    registerSecrets([apiKey!]); credentials.push({ connection: target.connection, apiKey: apiKey! });
  }
  return ok(credentials);
}
