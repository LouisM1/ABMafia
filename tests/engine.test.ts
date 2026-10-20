import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accept, checkWinner, createGame, legalActions, pause, playerView, resume, tick } from '../server/engine.js';
import type { Action, Game, PersonaPrompt, Phase, Role } from '../shared/types.js';
import { actionSchema, context, openaiAction, MODEL } from '../server/ai.js';
import { Storage } from '../server/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const personas: PersonaPrompt[] = Array.from({length: 11}, (_, i) => ({id:`ai${i}`,name:`Player ${i+1}`,text:'A test persona.',behaviours:[],examples:[]}));
function game() {
  const g = createGame('owner', personas, 'Human', 'quick', MODEL, 0, n => n - 1);
  // Identity shuffle gives p0-p2 Mafia, p3 Angel, p4 Sheriff.
  return g;
}
function act(g: Game, id: string, type: Action['type'], targets: string[] = [], text?: string, commandId = randomUUID()) {
  return accept(g,id,{type,targets,text,commandId,phaseId:g.phaseId},Math.max(1,g.deadline-100), n=>n-1);
}
function phase(g: Game, p: Phase) { g.phase=p;g.phaseId=randomUUID();g.deadline=100_000;g.status='RUNNING';g.abilityDone=false; }
function expire(g: Game) { tick(g,g.deadline,n=>n-1); }
test('exact role distribution, random independently of persona, twelve unique seats',()=>{
  const g=game();
  assert.equal(new Set(g.players.map(p=>p.id)).size,12);
  for(const [role,n] of Object.entries({Mafia:3,Angel:1,Sheriff:1,Townsperson:7})) assert.equal(g.players.filter(p=>p.role===role).length,n);
  assert.equal(g.phase,'MAFIA');
});
test('original pointer survives revisions when final pointers disagree',()=>{
  const g=game(); act(g,'p0','Point',['p5']);act(g,'p0','Point',['p6']);act(g,'p1','Point',['p7']);expire(g);
  assert.equal(g.kill,'p5');
});
test('final unanimous pointers override first fallback',()=>{
  const g=game();act(g,'p0','Point',['p5']);
  for(const id of ['p0','p1','p2']) act(g,id,'Point',['p6']);
  expire(g);assert.equal(g.kill,'p6');
});
test('invalid pointer cannot establish fallback; single survivor uses current pointer',()=>{
  const g=game();assert.throws(()=>act(g,'p0','Point',['p1']));assert.equal(g.firstPointer,null);
  g.players[1].alive=false;g.players[2].alive=false;act(g,'p0','Point',['p5']);act(g,'p0','Point',['p6']);
  expire(g);assert.equal(g.kill,'p6');
});
test('missing Mafia action pauses without inventing a victim',()=>{
  const g=game();expire(g);assert.equal(g.status,'PAUSED');assert.equal(g.kill,null);
  resume(g,100_000);assert.equal(g.status,'RUNNING');assert.equal(g.firstPointer,null);
});
test('Angel self-protection, consecutive restriction, skip breaks sequence',()=>{
  const g=game();phase(g,'ANGEL');act(g,'p3','Protect',['p3']);assert.equal(g.protection,'p3');
  g.previousProtection='p3';phase(g,'ANGEL');assert.throws(()=>act(g,'p3','Protect',['p3']));
  act(g,'p3','SkipAbility');g.protection=null;phase(g,'SHERIFF');g.kill='p6';expire(g);
  assert.equal(g.previousProtection,null);
});
test('saved night reveals neither role nor target to ordinary Town',()=>{
  const g=game();g.kill='p5';g.protection='p5';phase(g,'SHERIFF');expire(g);
  const v=playerView(g,'p6');assert.equal(v.players[5].alive,true);
  assert.equal(v.protection,undefined);assert.equal(v.players[5].role,undefined);
  assert.match(v.events.at(-2)!.text,/Nobody died/);
});
test('targeted Sheriff can investigate before dawn, receives exact roles',()=>{
  const g=game();g.kill='p4';phase(g,'SHERIFF');act(g,'p4','Investigate',['p3']);
  assert.equal(g.players[4].alive,true);assert.equal(g.investigations.p4.p3,'Angel');
  expire(g);assert.equal(g.players[4].alive,false);
  assert.equal(playerView(g,'p6').investigations?.p3,undefined);
  assert.equal(playerView(g,'p4').investigations?.p3,'Angel');
});
test('Sheriff may recheck targets, cannot investigate self; all target roles supported',()=>{
  for(const [target,role] of [['p0','Mafia'],['p3','Angel'],['p5','Townsperson']] as [string,Role][]){
    const g=game();phase(g,'SHERIFF');assert.throws(()=>act(g,'p4','Investigate',['p4']));
    act(g,'p4','Investigate',[target]);assert.equal(g.investigations.p4[target],role);
    phase(g,'SHERIFF');act(g,'p4','Investigate',[target]);assert.equal(g.investigations.p4[target],role);
  }
});
test('dead ability holders keep identical phase timing and prompts',()=>{
  const a=game(),b=game();b.players[3].alive=false;b.players[4].alive=false;
  for(const g of [a,b]){act(g,'p0','Point',['p5']);expire(g);}
  assert.equal(a.deadline,b.deadline);assert.equal(a.events.at(-1)?.text,b.events.at(-1)?.text);
  expire(a);expire(b);assert.equal(a.deadline,b.deadline);assert.equal(a.events.at(-1)?.text,b.events.at(-1)?.text);
});
test('two distinct private nomination targets, self allowed, no totals leaked',()=>{
  const g=game();phase(g,'NOMINATIONS');assert.throws(()=>act(g,'p5','Nominate',['p6','p6']));
  act(g,'p5','Nominate',['p5','p6']);assert.deepEqual(playerView(g,'p5').ownNomination,['p5','p6']);
  assert.equal(playerView(g,'p6').ownNomination,undefined);
  assert(!playerView(g,'p6').events.some(e=>e.type==='NominationSubmitted'));
  assert.throws(()=>act(g,'p5','Nominate',['p7','p8']));
});
test('nomination cutoff tie selects one tied player and retains the leader',()=>{
  const g=game();phase(g,'NOMINATIONS');g.players.forEach((p,i)=>p.alive=i<6);
  g.nominations={p0:['p0','p1'],p1:['p0','p1'],p2:['p0','p1'],p3:['p0','p2'],p4:['p0','p2'],p5:['p2','p3']};
  expire(g);assert.deepEqual(g.nominees,['p0','p2']);
});
test('three tied leaders select exactly two without replacement',()=>{
  const g=game();phase(g,'NOMINATIONS');g.players.forEach((p,i)=>p.alive=i<3);
  g.nominations={p0:['p0','p1'],p1:['p1','p2'],p2:['p0','p2']};expire(g);
  assert.equal(new Set(g.nominees).size,2);assert(g.nominees.every(x=>['p0','p1','p2'].includes(x)));
});
test('only active nominee can defend; dead players cannot act',()=>{
  const g=game();phase(g,'DEFENSE_1');g.nominees=['p5','p6'];
  assert.throws(()=>act(g,'p6','Speak',[],'Interrupting'));act(g,'p5','Speak',[],'My defense.');
  g.players[5].alive=false;assert.throws(()=>act(g,'p5','Speak',[],'Still here'));
});
test('first tie gets new defenses; second tie eliminates exactly one',()=>{
  const g=game();phase(g,'VOTE');g.nominees=['p5','p6'];
  for(let i=0;i<12;i++) act(g,`p${i}`,'Vote',[i%2?'p5':'p6']);
  assert.equal(g.voteAttempt,2);assert.equal(g.phase,'DEFENSE_1');assert.deepEqual(g.votes,{});
  expire(g);expire(g);assert.equal(g.phase,'VOTE');
  for(let i=0;i<12;i++) act(g,`p${i}`,'Vote',[i%2?'p5':'p6']);
  assert.equal(g.players.filter(p=>!p.alive).length,1);
  assert.equal(g.events.filter(e=>e.type==='RandomSelection' && e.text==='Second vote tie').length,1);
});
test('public votes, immutable ballots, duplicate commands idempotent even after deadline',()=>{
  const g=game();phase(g,'VOTE');g.nominees=['p5','p6'];const phaseId=g.phaseId;
  const cmd={phaseId,commandId:'same',type:'Vote' as const,targets:['p5']};
  assert.equal(accept(g,'p5',cmd,5),true);assert.equal(accept(g,'p5',cmd,200_000),false);
  assert.equal(playerView(g,'p8').votes.p5,'p5');assert.throws(()=>accept(g,'p5',{...cmd,targets:['p6']},10));
  assert.throws(()=>act(g,'p5','Vote',['p6']));
});
test('stale, late and forbidden actions cannot mutate the game',()=>{
  const g=game();const old=JSON.stringify(g);
  assert.throws(()=>accept(g,'p0',{type:'Point',targets:['p5'],text:'Secret chat',commandId:'bad',phaseId:g.phaseId},1));
  assert.equal(JSON.stringify(g),old);
  assert.throws(()=>accept(g,'p0',{type:'Point',targets:['p5'],commandId:'late',phaseId:g.phaseId},g.deadline));
  assert.throws(()=>accept(g,'p0',{type:'Point',targets:['p5'],commandId:'old',phaseId:'stale'},1));
});
test('spectating human sees full prior secrets; dead AI still restricted',()=>{
  const g=game();g.players[0].alive=false;g.players[5].alive=false;
  const human=playerView(g,'p0'),ai=playerView(g,'p5');
  assert.equal(human.spectator,true);assert(human.players.every(p=>p.role));assert.deepEqual(human.legal,[]);
  assert.equal(ai.spectator,false);assert.equal(ai.players[1].role,undefined);
});
test('Town and Mafia victory includes special Town roles',()=>{
  const a=game();a.players.filter(p=>p.role==='Mafia').forEach(p=>p.alive=false);
  assert(checkWinner(a));assert.equal(a.winner,'Town');
  const b=game();b.players.forEach((p,i)=>p.alive=[0,1,3,4].includes(i));assert(checkWinner(b));assert.equal(b.winner,'Mafia');
});
test('missing required ballots pause; resume preserves accepted choices',()=>{
  const g=game();phase(g,'NOMINATIONS');act(g,'p0','Nominate',['p5','p6']);expire(g);
  assert.equal(g.status,'PAUSED');resume(g,200_000);assert.deepEqual(g.nominations.p0,['p5','p6']);
  assert.equal(legalActions(g,'p0').length,0);assert.equal(legalActions(g,'p1')[0].type,'Nominate');
});
test('complete rule simulations terminate with legal actions, including human controls',()=>{
  for(let run=0;run<20;run++){
    const g=game();
    for(let step=0;step<500 && g.status==='RUNNING';step++){
      const startingPhase = g.phaseId;
      for(const p of g.players){
        const v=playerView(g,p.id,Math.max(1,g.deadline-100));const type=v.legal[0]?.type;
        if(type && type!=='Speak'){
          const legal=v.legal.find(a=>a.type===type)!;
          const offset=run % legal.targets.length;
          const choices=[...legal.targets.slice(offset),...legal.targets.slice(0,offset)];
          act(g,p.id,type,choices.slice(0,legal.count));
        }
      }
      if(g.status==='RUNNING' && g.phaseId===startingPhase) expire(g);
    }
    assert.equal(g.status,'FINISHED');assert(g.winner);
  }
});
test('same starting state, commands, timers and draws replay identically',()=>{
  const a=game(),b=structuredClone(a);
  for(const g of [a,b]){
    accept(g,'p0',{type:'Point',targets:['p5'],commandId:'one',phaseId:g.phaseId},1,()=>0);
    tick(g,g.deadline,()=>0);
  }
  assert.deepEqual(a,b);
});
test('storage atomically preserves events and recovers paused using checkpoint time',()=>{
  const dir=mkdtempSync(join(tmpdir(),'abmafia-test-'));
  try{
    const s=new Storage(join(dir,'test.sqlite'));const g=game();g.remaining=3500;s.save(g);s.save(g);
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n:number}).n,g.events.length);
    const recovered=s.recover(1_000_000)[0];assert.equal(recovered.status,'PAUSED');assert.equal(recovered.remaining,3500);
    s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('OpenAI adapter sends only authorized context and validates structured completion',async()=>{
  const g=game();phase(g,'NOMINATIONS');const view=playerView(g,'p5');
  const fakeFetch=(async(url: string|URL|Request, init?:RequestInit)=>{
    assert.equal(String(url),'https://api.openai.com/v1/responses');
    const body=JSON.parse(init!.body as string);assert.equal(body.store,false);assert.equal(body.reasoning.effort,'none');
    const input=JSON.parse(body.input);assert.equal(input.authorizedGameView.players[0].role,undefined);
    assert.equal(body.text.format.strict,true);
    return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({type:'Nominate',targets:['p6','p7'],text:''})}]}]}));
  }) as typeof fetch;
  const action=await openaiAction('test-key-not-real',MODEL,personas[0],view,'Nominate',new AbortController().signal,fakeFetch);
  assert.equal(action.type,'Nominate');assert.equal(actionSchema(view,'Nominate').properties.targets.minItems,2);
  assert(!('personas' in context(view)));
});

test('legacy practice games are archived on recovery instead of making paid requests',()=>{
  const dir=mkdtempSync(join(tmpdir(),'abmafia-legacy-'));
  try {
    const s=new Storage(join(dir,'test.sqlite')); const g=game();
    (g as { mode: string }).mode='practice'; s.save(g);
    const recovered=s.recover(1_000_000)[0];
    assert.equal(recovered.status,'ABANDONED'); assert.equal(recovered.aiCalls,0);
    assert.equal(legalActions(recovered,'p0').length,0); s.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('OpenAI commentary is excluded from the final action JSON',async()=>{
  const g=game();phase(g,'NOMINATIONS');const view=playerView(g,'p5');
  const expected={type:'Nominate',targets:['p6','p7'],text:''};
  const fakeFetch=(async()=>new Response(JSON.stringify({status:'completed',output:[
    {phase:'commentary',content:[{type:'output_text',text:'I will choose two players.'}]},
    {phase:'final_answer',content:[{type:'output_text',text:JSON.stringify(expected)}]},
  ]}))) as typeof fetch;
  const action=await openaiAction('test-key-not-real',MODEL,personas[0],view,'Nominate',new AbortController().signal,fakeFetch);
  assert.deepEqual(action,expected);
  assert(accept(g,'p5',{...action,commandId:'model-final',phaseId:g.phaseId},1));
});

test('malformed model output is rejected without a canned fallback',async()=>{
  const g=game();phase(g,'NOMINATIONS');const view=playerView(g,'p5');
  const fakeFetch=(async()=>new Response(JSON.stringify({status:'completed',output:[
    {content:[{type:'output_text',text:'This is not an action.'}]},
  ]}))) as typeof fetch;
  await assert.rejects(openaiAction('test-key-not-real',MODEL,personas[0],view,'Nominate',new AbortController().signal,fakeFetch),/no usable action/);
  assert.deepEqual(g.nominations,{});
});
