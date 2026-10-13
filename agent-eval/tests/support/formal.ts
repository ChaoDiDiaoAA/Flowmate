import {caseV2Schema} from '../../src/dataset-loader/schema.ts';
import {metricCatalog} from '../../src/scoring/catalog.ts';
import {task,observed} from './fixtures.ts';

/** Independent metric protocol fixtures; no formal Case or expected model answer is executed. */
export function formalFixture(...metricIds:string[]){
    const item=caseV2Schema.parse({...structuredClone(task),contract:'flowmate-agent-case/v2',expected:{...task.expected,metrics:metricCatalog.map(m=>metricIds.includes(m.id)||m.id==='task-success'
        ?{metricId:m.id,version:m.version,unit:m.unit,denominator:m.id==='task-success'?1:null}:{metricId:m.id,version:m.version,unit:m.unit,notApplicable:'Independent metric fixture.'})}});
    const result=observed();result.evidence={};return{task:item,result,projected:result.input,judge:null};
}
