/** Whole-task records, independent of Provider and development stage. */
export type GradeStatus = 'PASS' | 'FAIL' | 'UNJUDGEABLE' | 'ERROR' | 'NOT_RUN';
export type EvidenceFact = {
    present: boolean;
    actual: unknown;
    source: string;
};
export type ExecutionStatus = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'error' | 'not-started';
export type Observation = {
    id: string;
    parentId?: string;
    kind: 'span' | 'generation' | 'tool';
    name: string;
    startedAt: string;
    endedAt: string | null;
    input?: unknown;
    output?: unknown;
    model?: string;
    parameters?: Record<string, unknown>;
    usage?: Record<string, number>;
};
export type CaseExecutionResult = {
    identity: {
        executionId: string;
        trialId: string;
        caseId: string;
        caseVersion: number;
    };
    started: boolean;
    status: ExecutionStatus;
    endpointReached: boolean;
    input: {
        prompt: string;
        materials: Array<{
            sample: string;
            file: string;
            text: string;
        }>;
    };
    answer: string | null;
    artifacts: Array<{
        id: string;
        kind: string;
        content: unknown;
    }>;
    observations: Observation[];
    evidence: Record<string, EvidenceFact>;
    configuration: Record<string, unknown>;
    usage: Record<string, number | null>;
    startedAt: string | null;
    endedAt: string | null;
    error?: {
        code: string;
        message: string;
        infrastructure: boolean;
    };
};
