import type { EmbeddedFile } from '../dataset-loader/flat.ts';
import type { LocalCase } from '../dataset-loader/local.ts';
import type { InteractionProfile } from '../dataset-loader/schema.ts';
import type { UserTurn } from '../dataset-loader/authoring.ts';
import type { CaseExecutionResult, EvidenceFact } from '../types.ts';
import type { PrivateEffects } from '../execution/safety-probes.ts';
import {REPO_ROOT} from '../dataset-loader/local.ts';
import { agentConfig, prepareAgentConfig } from '../configuration.ts';
import { registerSecrets } from '../execution/evidence-safety.ts';
import type { EvaluationRuntime } from '../execution/source.ts';
export function assertModelConfiguration(config:{model?:unknown;baseUrl?:unknown;api?:unknown}) {
    if(typeof config.model!=='string'||!config.model.trim()||config.model.includes('REPLACE_WITH')||typeof config.baseUrl!=='string'||typeof config.api!=='string'||
        !['openai-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(config.api))
        throw new Error('Configuration template requires the actual Agent model, API and baseUrl');
    const url=new URL(config.baseUrl);
    if(url.hostname==='replace.invalid'||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
        throw new Error('Configuration template requires a credential-free actual Agent API root');
}
/** Controller-only setup and steps must never be copied wholesale into model input. */
export type AgentTrial = {
    identity: CaseExecutionResult['identity'];
    directory: string;
    input: CaseExecutionResult['input'];
    /** Private future user script. Submit only the currently eligible turn to the product. */
    turns?: UserTurn[];
    /** Trusted controller source; never part of the product input or model request. */
    invoiceSource?: { root: string; localRoot?: string; materials: LocalCase['input']['materials']; files?: EmbeddedFile[] };
    /** Declared controller inputs; never copied wholesale into the product or model input. */
    controllerInput?: {profile:InteractionProfile;payload:string};
    /** Controller-only synthetic attack targets and effect expectations; never model input. */
    privateEffects?: PrivateEffects;
    /** Only selected manifest-declared resource files are copied; adjacent quality files stay outside Host. */
    resourceRoot?: string;
    requires: string[];
    setup?: LocalCase['setup'];
    steps?: LocalCase['steps'];
    configuration: Record<string, unknown>;
};
export interface AgentTrialSession {
    /** Actual initial visible input after controlled setup, before any model call. */
    input: CaseExecutionResult['input'];
    execute(signal: AbortSignal, onQuiescent?: (facts: CaseExecutionResult) => void): Promise<CaseExecutionResult>;
    /** stopOnly reads existing owned actor state, without collecting full history/tool bodies. */
    snapshot(options?: { stopOnly?: boolean }): Promise<CaseExecutionResult>;
    cancel(): Promise<void>;
    close(): Promise<EvidenceFact>;
}
export interface AgentKernel {
    readiness(): {
        ready: boolean;
        reason: string;
    };
    prepare(trial: AgentTrial, signal: AbortSignal): Promise<AgentTrialSession>;
}
export function createProductAgent(repo: string, apiKey: string, runtime?: EvaluationRuntime): AgentKernel {
    registerSecrets([apiKey]);
    return {
    readiness() {
        if(!apiKey.trim())return{ready:false,reason:'Agent credential FLOWMATE_EVAL_AGENT_API_KEY is required; Judge credentials cannot substitute'};
        return{ready:true,reason:'Local Flowmate Host; actual configuration, data and Trial prerequisites are checked before Provider dispatch'};
    },
    async prepare(trial,signal) {
        signal.throwIfAborted();assertModelConfiguration(trial.configuration);
        if(!apiKey.trim())throw new Error('Agent credential FLOWMATE_EVAL_AGENT_API_KEY is required');
        const {prepareHostTrial}=await import('./host-research.ts');
        return prepareHostTrial(trial,signal,{repo,credential:apiKey,runtime});
    },
    };
}
export const productAgent: AgentKernel = {
    readiness() {
        try { return createProductAgent(REPO_ROOT, agentConfig(REPO_ROOT).apiKey).readiness(); }
        catch (error) { return { ready: false, reason: error instanceof Error ? error.message : 'Invalid evaluation Agent configuration' }; }
    },
    async prepare(trial, signal) {
        signal.throwIfAborted();
        const agent = await prepareAgentConfig(REPO_ROOT, process.env, trial.configuration);
        return createProductAgent(REPO_ROOT, agent.apiKey).prepare({ ...trial, configuration: { ...trial.configuration, ...agent.configuration } }, signal);
    },
};
