import { expect, it } from 'vitest';
import { serializeSqliteError } from '../src/storage/sqlite/error-transport.js';
import { GoldenSetEntryAlreadyRetiredError, AssessmentReceiptUnavailableError, AmbiguousProjectSkillError } from '../src/repository/errors.js';

it('transports public domain and auth fields without arbitrary internal error properties',()=>{
  const error=Object.assign(new AssessmentReceiptUnavailableError('not_terminal','Pending'),{
    sql:'private SQL',params:['secret'],cause:new Error('internal'),callback:()=>{}
  });
  expect(structuredClone(serializeSqliteError(error))).toEqual({name:error.name,message:'Pending',reason:'not_terminal'});
  expect(serializeSqliteError(new AmbiguousProjectSkillError('project',2))).toMatchObject({projectId:'project',criterionCount:2});
  expect(serializeSqliteError(Object.assign(new Error('Auth failed'),{statusCode:401,body:{code:'DENIED',message:'Auth failed',secret:'private'}})))
    .toEqual({name:'Error',message:'Auth failed',statusCode:401,body:{code:'DENIED',message:'Auth failed'}});
  expect(serializeSqliteError({message:'secret',sql:'private'})).toEqual({name:'Error',message:'SQLite command failed'});
});

it('preserves the typed retirement context and strips unrelated nested fields',()=>{
  const context={retiredAt:'2026-10-05T00:00:00Z',retiredByUserId:'user',retiredBy:'Owner',reason:'Superseded'};
  expect(serializeSqliteError(new GoldenSetEntryAlreadyRetiredError('entry',{...context,secret:'private'} as typeof context)).retirement).toEqual(context);
  expect(serializeSqliteError(new GoldenSetEntryAlreadyRetiredError('entry')).retirement).toBeNull();
});
