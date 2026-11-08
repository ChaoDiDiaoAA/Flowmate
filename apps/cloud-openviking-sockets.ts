import type { OpenVikingManagementRole } from '../packages/contracts/src/openviking-management.ts';

export const cloudOpenVikingSockets = {
  P: '/run/flowmate-openviking-p/management.sock',
  A: '/run/flowmate-openviking-a/management.sock',
  S: '/run/flowmate-openviking-s/management.sock',
} as const satisfies Record<OpenVikingManagementRole, string>;
