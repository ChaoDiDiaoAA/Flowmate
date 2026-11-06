import { expect, test } from 'bun:test';
import { DesktopActionProposalSchema } from '@flowmate/contracts';
import { toPiParameters } from '../../packages/runtime-pi/src/schema.ts';

test('the desktop proposal can be advertised to Pi while retaining its required observed target', () => {
  const parameters = toPiParameters(DesktopActionProposalSchema);
  expect(parameters).toMatchObject({ type: 'object', required: ['kind', 'observationId', 'elementIndex'], additionalProperties: false });
});
