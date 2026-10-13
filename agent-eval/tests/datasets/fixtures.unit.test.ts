import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeFixtureName, loadFixture, loadFixtureText, fixturePath } from '../../src/testing/load-fixture.ts';

test('Folio-style fixtures load raw JSON and text; malformed or missing samples report their path',()=>{
 const root=mkdtempSync(join(tmpdir(),'eval-fixture-'));
 try {
  writeFileSync(join(root,'raw.json'),' { "total": 42 }\n');
  writeFileSync(join(root,'source.md'),'Original source text.\n');
  writeFileSync(join(root,'broken.json'),'{ broken');
  expect(loadFixture<{total:number}>('raw',root)).toEqual({total:42});
  expect(loadFixtureText('source','md',root)).toBe('Original source text.\n');
  expect(()=>loadFixture('missing',root)).toThrow('missing.json');
  expect(()=>loadFixture('broken',root)).toThrow('broken.json');
  for(const name of ['','..','../raw','a/b','a\\b','C:\\private','/absolute','x:stream'])expect(()=>assertSafeFixtureName(name)).toThrow('Unsafe');
  expect(()=>fixturePath('raw','../json',root)).toThrow('Unsafe');
  const outside=mkdtempSync(join(tmpdir(),'eval-fixture-outside-'));
  try {
   writeFileSync(join(outside,'secret.json'),'{}');
   symlinkSync(outside,join(root,'linked.json'),'junction');
   expect(()=>loadFixture('linked',root)).toThrow(/links|Linked/);
   mkdirSync(join(root,'directory.json'));
   expect(()=>loadFixture('directory',root)).toThrow(/file|EISDIR/i);
  } finally {rmSync(outside,{recursive:true,force:true});}
 } finally {rmSync(root,{recursive:true,force:true});}
});
