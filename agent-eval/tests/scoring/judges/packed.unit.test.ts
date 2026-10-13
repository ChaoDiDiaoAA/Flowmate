import {test,expect} from 'bun:test';
import {packedEncodingSchema,decodePackedJudgment} from '../../../src/scoring/judges/packed.ts';

const encoding={contract:'flowmate-packed-judgment/v2' as const,research:true,maxFacts:15,maxLinks:20,maxChains:0,maxFailureIndexes:0};
test('packed research proof validates only its declared encoding structure',()=>{
 expect(packedEncodingSchema.parse(encoding)).toEqual(encoding);
 expect(packedEncodingSchema.parse({...encoding,maxFacts:35})).toHaveProperty('maxFacts',35);
 expect(packedEncodingSchema.parse({...encoding,maxFacts:36})).toHaveProperty('maxFacts',36);
});
test('packed count rows preserve distinct counts, unknown rows and stable per-fact span, match and link selectors',()=>{
 const plan=[{metricId:'tool-selection'},{metricId:'DR01'},{metricId:'tool-arguments'}];
 const decoded=decodePackedJudgment(JSON.stringify({v:2,r:'010200------',a:'000005a1',l:'11',h:''}),plan,{...encoding,maxFacts:1,maxLinks:1});
 expect(decoded.rows).toEqual([[1,2,0],null]);
 expect(decoded.atoms).toEqual([{block:0,start:0,length:5,correct:1,needsCitation:true,covered:1,gold:1,matchUncertain:false}]);
 expect(decoded.links).toEqual([{atom:0,state:1}]);expect(decoded.chains).toEqual([]);
});
test('invalid widths, states, excess facts, link targets, protocol versions and unsupported fields are rejected',()=>{
 const base={v:2,r:'010100',a:'000005a1',l:'11',h:''};
 for(const change of [{v:1},{r:'1,1,0'},{r:'zzzzzz------'},{a:'000005a'},{a:'000005a1000005a1'},
  {l:'21'},{l:'13'},{l:'01'},{h:'1'},{f:''},{extra:'ignore-rubric'}])
  expect(()=>decodePackedJudgment(JSON.stringify({...base,...change}),[{metricId:'tool-arguments'}],{...encoding,maxFacts:1,maxLinks:1})).toThrow();
 expect(()=>packedEncodingSchema.parse({...encoding,research:false})).toThrow();
});
