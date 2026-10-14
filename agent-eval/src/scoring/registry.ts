import type { EvaluatorDefinition } from './types.ts';
import { deterministicEvaluatorDefinitions } from './evaluators/registered.ts';
import { semanticEvaluatorDefinitions } from './judges/evaluators.ts';
import { answerRelevance } from './judges/answer-relevance.ts';
export class EvaluatorRegistry {
    private items = new Map<string, EvaluatorDefinition>();
    register(def: EvaluatorDefinition) {
        if (this.items.has(def.id))
            throw new Error('Duplicate metric: ' + def.id);
        this.items.set(def.id, def);
    }
    get(id: string) {
        // Explicit old dataset selections keep their original Judge without adding it to the active catalog.
        if(id==='answer-relevance'&&!this.items.has(id))return answerRelevance;
        const def = this.items.get(id);
        if (!def)
            throw new Error('Unknown metric: ' + id);
        return def;
    }
    list() { return [...this.items.values()]; }
}
export function createRegistry() {
    const r = new EvaluatorRegistry();
    for (const def of [...deterministicEvaluatorDefinitions, ...semanticEvaluatorDefinitions])
        r.register(def);
    return r;
}
