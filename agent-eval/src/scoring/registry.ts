import type { EvaluatorDefinition } from './types.ts';
import { definitions } from './evaluators/index.ts';
import { answerRelevance } from './judges/answer-relevance.ts';
export class EvaluatorRegistry {
    private items = new Map<string, EvaluatorDefinition>();
    register(def: EvaluatorDefinition) {
        if (this.items.has(def.id))
            throw new Error('Duplicate metric: ' + def.id);
        this.items.set(def.id, def);
    }
    get(id: string) {
        const def = this.items.get(id);
        if (!def)
            throw new Error('Unknown metric: ' + id);
        return def;
    }
    list() { return [...this.items.values()]; }
}
export function createRegistry() {
    const r = new EvaluatorRegistry();
    for (const def of [...definitions, answerRelevance])
        r.register(def);
    return r;
}
