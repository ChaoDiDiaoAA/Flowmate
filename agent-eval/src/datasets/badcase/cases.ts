import { flowmateAgentV1Dataset } from '../cases.ts';
import { regressionOrigins } from './members.ts';
import type { AuthorCase } from '../../dataset-loader/authoring.ts';

// Independent conditions belong here with globally unused FM-063 onward identities.
export const independentCases: AuthorCase[] = [];
export const flowmateBadcaseDataset = { version: 'v1', suite: 'badcase', regressionOrigins,
    cases: [...flowmateAgentV1Dataset.cases.filter(c => Object.hasOwn(regressionOrigins, c.id)), ...independentCases] };
