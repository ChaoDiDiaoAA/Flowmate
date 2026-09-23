import { definition as task } from './task-result.ts';
import { definition as input } from './input-isolation.ts';
import { definition as environment } from './environment-isolation.ts';
import { definition as secret } from './no-secret.ts';
import { definition as closed } from './closed.ts';
import { definition as facts } from './fact-check.ts';
import { definition as fields } from './reference-fields.ts';
import { definition as lines } from './line-items.ts';
export const definitions = [task, input, environment, secret, closed, facts, fields, lines];
