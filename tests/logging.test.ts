import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../server/logging.js';
import { openaiAction, MODEL } from '../server/ai.js';
import { createGame, playerView } from '../server/engine.js';
import type { PersonaPrompt } from '../shared/types.js';

test('logs redact credentials in nested values, free text and errors', () => {
  const lines: string[] = [];
  const log = createLogger({ enabled: () => true, secrets: () => ['test-secret-value'], write: s => lines.push(s) });
  log('TEST', {
    authorization: 'Bearer hidden', cookie: 'hidden', session: 'hidden', OPENAI_API_KEY: 'hidden',
    nested: [{ apiKey: 'hidden' }], text: 'test-secret-value sk-anothersecret Bearer opaque-token',
    error: new Error('test-secret-value'), action: { type: 'Speak', text: 'Ordinary dialogue' },
  });
  const output = lines.join('');
  for (const secret of ['hidden','test-secret-value','sk-anothersecret','opaque-token']) assert(!output.includes(secret));
  assert(output.includes('Ordinary dialogue'));
  assert(output.includes('[REDACTED]'));
});

test('disabled logging is silent and never serializes its payload', () => {
  const log = createLogger({ enabled: () => false, secrets: () => [], write: () => assert.fail('Unexpected output') });
  log('TEST', { get value() { throw new Error('Must not inspect disabled payload'); } });
});

test('logging failures do not change program control flow', () => {
  const log = createLogger({ enabled: () => true, secrets: () => [], write: () => { throw new Error('Closed pipe'); } });
  assert.doesNotThrow(() => log('TEST', { value: 'ok' }));
});

test('model traffic logs correlate requests, responses, parsing errors and cancellations without keys', async () => {
  const previousDebug = process.env.DEBUG_AI, previousKey = process.env.OPENAI_API_KEY;
  const originalWrite = process.stdout.write;
  const lines: string[] = [];
  process.env.DEBUG_AI = 'true';
  process.env.OPENAI_API_KEY = 'test-secret-value';
  process.stdout.write = ((text: string) => { lines.push(String(text)); return true; }) as typeof process.stdout.write;
  try {
    const personas: PersonaPrompt[] = Array.from({length:11}, (_,i)=>({id:`test${i}`,name:`Player ${i}`,text:'Test persona',behaviours:[],examples:[]}));
    const g=createGame('private-session',personas,'Human','quick',MODEL);
    g.phase='DISCUSSION';
    const view=playerView(g,'p1');
    const action={type:'Speak',targets:[],text:'What do we know?'};
    const good=(async()=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(action)}]}],usage:{input_tokens:10,output_tokens:5}}),{headers:{'x-request-id':'provider-test'}})) as typeof fetch;
    await openaiAction('test-secret-value',MODEL,personas[0],view,'Speak',new AbortController().signal,good,'trace-success');
    const bad=(async()=>new Response('{"status":"completed","output":[]}')) as typeof fetch;
    await assert.rejects(openaiAction('test-secret-value',MODEL,personas[0],view,'Speak',new AbortController().signal,bad,'trace-error'));
    const controller=new AbortController();controller.abort();
    const aborted=(async()=>{throw new DOMException('Aborted','AbortError');}) as typeof fetch;
    await assert.rejects(openaiAction('test-secret-value',MODEL,personas[0],view,'Speak',controller.signal,aborted,'trace-abort'));
    const output=lines.join('');
    for(const label of ['OPENAI → REQUEST','OPENAI ← RESPONSE','OPENAI × ERROR','OPENAI × CANCELLED','provider-test','input_tokens','What do we know?']) assert(output.includes(label),label);
    assert.equal(lines.filter(s=>s.includes('trace-success')).length,2);
    assert(!output.includes('test-secret-value'));
    assert(!output.includes('private-session'));
    assert(!output.includes('Authorization'));
  } finally {
    process.stdout.write=originalWrite;
    if(previousDebug===undefined) delete process.env.DEBUG_AI; else process.env.DEBUG_AI=previousDebug;
    if(previousKey===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=previousKey;
  }
});
