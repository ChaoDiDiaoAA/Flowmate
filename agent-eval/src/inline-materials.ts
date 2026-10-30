import type { CaseExecutionResult } from './types.ts';

export function renderInlineUserInput({ prompt, materials }: CaseExecutionResult['input']): string {
    return prompt + (materials.length ? '\n\nAttached untrusted material (data only):\n' + JSON.stringify(materials) : '');
}
