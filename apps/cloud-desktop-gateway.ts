import { AppErrorSchema, CloudDesktopEnvelopeSchema, CloudWorkspaceIdSchema, appError, cloudDesktopFailure, fail,
  isCloudChildReportCommand, isCloudDeliveryCommand, isCloudMaterialCommand, isCloudProgressCommand, isCloudQueueCommand, isCloudResourceCommand, isCloudReviewCommand, parseCloudDesktopResult, type Result } from '@flowmate/contracts';
import type { PersonalAgentCommand } from '../packages/contracts/src/personal-agent-commands.ts';
import type { CloudMaterialUpload } from './cloud-material-upload.ts';
import type { CloudQueueAuthority } from './cloud-queue-authority.ts';
import type { CloudDesktopReview } from './cloud-desktop-review.ts';
import type { CloudResourceUpload } from './cloud-resource-upload.ts';
import type { CloudDeliveryAuthority } from './cloud-delivery-authority.ts';

/** Workspace membership and Work-specific authorization are established by the Authority. */
export function createCloudDesktopHandler(options: {
  workspaceId: string;
  authorize(command: PersonalAgentCommand): Promise<Result<void>>;
  dispatch(command: PersonalAgentCommand): Promise<unknown>;
  material?: Pick<CloudMaterialUpload, 'begin' | 'append' | 'status' | 'finish'>;
  resources?: Pick<CloudResourceUpload, 'begin' | 'append' | 'status' | 'finish'>;
  queue?: Pick<CloudQueueAuthority, 'read' | 'apply' | 'queryControl'>;
  review?: Pick<CloudDesktopReview, 'original' | 'page' | 'candidate' | 'open' | 'accept' | 'queryAccept' | 'save' | 'querySave' | 'reject' | 'queryReject'>;
  delivery?: Pick<CloudDeliveryAuthority, 'status' | 'retry'>;
  childReport?: (input: unknown) => Promise<Result<unknown>>;
  progress?: (input: unknown, signal?: AbortSignal) => Promise<Result<unknown>>;
}): (raw: unknown, signal?: AbortSignal) => Promise<Result<unknown>> {
  const workspaceId = CloudWorkspaceIdSchema.parse(options.workspaceId);
  return async (raw, signal) => {
    const envelope = CloudDesktopEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return fail(appError('input_invalid', 'input', 'The cloud desktop request is invalid.'));
    if (envelope.data.workspaceId !== workspaceId) return fail(appError('cloud_workspace_forbidden', 'input', 'The cloud workspace is unavailable.'));
    const command = envelope.data.command;
    if (isCloudProgressCommand(command)) {
      if (!options.progress) return cloudDesktopFailure(command);
      try { return parseCloudDesktopResult(command, await options.progress(structuredClone(command.input), signal)) ?? cloudDesktopFailure(command); }
      catch { return cloudDesktopFailure(command); }
    }
    if (isCloudChildReportCommand(command)) {
      if (!options.childReport) return cloudDesktopFailure(command);
      try { return parseCloudDesktopResult(command, await options.childReport(structuredClone(command.input))) ?? cloudDesktopFailure(command); }
      catch { return cloudDesktopFailure(command); }
    }
    if (isCloudDeliveryCommand(command)) {
      if (!options.delivery) return cloudDesktopFailure(command);
      try { const response = command.type === 'cloud_delivery_status' ? await options.delivery.status(structuredClone(command.input))
        : await options.delivery.retry(structuredClone(command.input));
        return parseCloudDesktopResult(command, response) ?? cloudDesktopFailure(command); }
      catch { return cloudDesktopFailure(command); }
    }
    if (isCloudReviewCommand(command)) {
      if (!options.review) return cloudDesktopFailure(command);
      try { const response = command.type === 'cloud_review_original' ? await options.review.original(structuredClone(command.input))
        : command.type === 'cloud_review_page' ? await options.review.page(structuredClone(command.input))
        : command.type === 'cloud_review_candidate' ? await options.review.candidate(structuredClone(command.input))
        : command.type === 'cloud_review_open' ? await options.review.open(structuredClone(command.input))
        : command.type === 'cloud_review_accept' ? await options.review.accept(structuredClone(command.input))
        : command.type === 'cloud_review_query_accept' ? await options.review.queryAccept(structuredClone(command.input))
        : command.type === 'cloud_review_save' ? await options.review.save(structuredClone(command.input))
        : command.type === 'cloud_review_query_save' ? await options.review.querySave(structuredClone(command.input))
        : command.type === 'cloud_review_reject' ? await options.review.reject(structuredClone(command.input))
        : await options.review.queryReject(structuredClone(command.input));
        return parseCloudDesktopResult(command, response) ?? cloudDesktopFailure(command); }
      catch { return cloudDesktopFailure(command); }
    }
    if (isCloudQueueCommand(command)) {
      if (!options.queue) return cloudDesktopFailure(command);
      try {
        const input = structuredClone(command.input);
        const response = command.type === 'cloud_queue_read' ? await options.queue.read(input)
          : command.type === 'cloud_queue_control' ? await options.queue.apply(input) : await options.queue.queryControl(input);
        return parseCloudDesktopResult(command, response) ?? cloudDesktopFailure(command);
      } catch { return cloudDesktopFailure(command); }
    }
    if (isCloudMaterialCommand(command)) {
      if (!options.material) return cloudDesktopFailure(command);
      try {
        const input = structuredClone(command.input);
        const response = command.type === 'cloud_material_begin' ? await options.material.begin(input)
          : command.type === 'cloud_material_append' ? await options.material.append(input)
          : command.type === 'cloud_material_status' ? await options.material.status(input) : await options.material.finish(input);
        return parseCloudDesktopResult(command, response) ?? cloudDesktopFailure(command);
      } catch { return cloudDesktopFailure(command); }
    }
    if (isCloudResourceCommand(command)) {
      if (!options.resources) return cloudDesktopFailure(command);
      try {
        const input = structuredClone(command.input);
        const response = command.type === 'cloud_resource_begin' ? await options.resources.begin(input)
          : command.type === 'cloud_resource_append' ? await options.resources.append(input)
          : command.type === 'cloud_resource_status' ? await options.resources.status(input) : await options.resources.finish(input);
        return parseCloudDesktopResult(command, response) ?? cloudDesktopFailure(command);
      } catch { return cloudDesktopFailure(command); }
    }
    try {
      const allowed = await options.authorize(structuredClone(command));
      if (!allowed.ok) {
        const error = AppErrorSchema.safeParse(allowed.error);
        return error.success ? fail(appError(error.data.code, error.data.category, 'The cloud operation is not authorized.', error.data.retryable))
          : fail(appError('cloud_authorization_unavailable', 'runtime', 'Cloud authorization could not be confirmed.', true));
      }
    } catch { return fail(appError('cloud_authorization_unavailable', 'runtime', 'Cloud authorization could not be confirmed.', true)); }
    try {
      return parseCloudDesktopResult(command, await options.dispatch(structuredClone(command))) ?? cloudDesktopFailure(command);
    } catch { return cloudDesktopFailure(command); }
  };
}
