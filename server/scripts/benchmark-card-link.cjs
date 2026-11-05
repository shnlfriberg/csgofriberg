// Isolated capacity/algorithm/soak harness; never accepts a live database path.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {db}=require('../dist/db/knex');
const {ensureSchema}=require('../dist/db/schema');
const {buildGraph,loadGraph,selectQuestions}=require('../dist/card-link/graphs');
const {createMatch,joinMatch,controlMatch,readView,commandMatch,advanceById}=require('../dist/card-link/matches');
const {settle}=require('../dist/card-link/settlement');
const {createRound,applyCommand,shortestPath,graphIndex}=require('@friberg/card-link-core');
assert(process.env.DB_URL?.includes('verification')||process.env.DB_URL?.endsWith('/soup_release_qa'));
const output=process.argv[2];assert(output);
const soakSeconds=Number(process.argv[3]||0);
const quantiles=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)]};};
const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
async function main(){
  await ensureSchema();const report={observedAt:new Date().toISOString(),node:process.version,database:db.client.config.client,algorithms:[]};
  const date=n=>new Date(Date.UTC(2000,0,n*2+1)).toISOString().slice(0,10);
  let playable;
  for(const count of [700,5000])for(const width of [1,8,0]){
    const rows=Array.from({length:count},(_,i)=>({id:i+1,nickname:`P${i+1}`,age:25,nationality:'',team:'',career:{personKey:`p:${i}`,page:'https://example.com',sourceRevision:'qa',observedAt:'2026-10-24',aliases:[],locked:false,tenures:width?[Math.floor(i/width)-1,Math.floor(i/width)].filter(n=>n>=0).map(n=>({teamId:`T${n}`,team:`T${n}`,game:'csgo',start:date(n),end:date(n+1),precision:'day',status:'active',rawDates:'fixture',source:'https://example.com',verified:false})):[]}}));
    const start=performance.now(),data=buildGraph(rows),buildMs=performance.now()-start,index=graphIndex(data);
    const timings=[];let deals=0;
    if(width){const questions=selectQuestions({data,index},'hard',3);for(let seed=1;seed<=1000;seed++){const q=questions[seed%3],t=performance.now(),state=createRound(index,q,'limited',seed,0,180);assert(shortestPath(index,q.start,q.end,new Set([q.start,q.end,...state.hand])));timings.push(performance.now()-t);deals++;}}
    report.algorithms.push({nodes:count,kind:width===0?'disconnected':width===1?'sparse':'dense',edges:data.edges.length,buildMs,pairs:Object.fromEntries(Object.entries(data.pairs).map(([k,v])=>[k,v.length])),deals,dealMs:deals?quantiles(timings):null});
    if(count===700&&width===8)playable=data;
  }
  await db('card_graphs').insert({version:playable.version,source_revision:0,payload:JSON.stringify(playable),created_at:Date.now()});
  await db('card_catalog').where({id:1}).update({enabled:true,graph_version:playable.version});
  const workers=[],creation=[];
  for(let room=0;room<100;room++){
    const owners=[0,1].map(i=>({key:`g:bench-${room}-${i}`,userId:null,name:`P${i}`}));
    const start=performance.now(),variant=room%2?'limited':'unlimited';
    const {id}=await createMatch(owners[0],'friend',variant,'normal',300,randomUUID());creation.push(performance.now()-start);
    await joinMatch((await readView(id,owners[0])).code,owners[1]);
    for(const o of owners)await controlMatch(id,o,'ready',randomUUID());await controlMatch(id,owners[0],'start',randomUUID());
    const row=await db('card_matches').where({id}).first(),m=JSON.parse(row.payload);m.dueAt=Date.now()-1;await db('card_matches').where({id}).update({payload:JSON.stringify(m),due_at:m.dueAt});await advanceById(id);
    for(const owner of owners)workers.push({id,owner,view:await readView(id,owner)});
  }
  const latencies=[],bytes=[],byCommand={},began=performance.now();
  await Promise.all(workers.map(async(worker,index)=>{
    for(let step=0;step<10;step++){
      await sleep(began+index*5+step*1000-performance.now());const v=worker.view;
      if(v.current.locked)break;
      let command={type:'reorder',board:v.current.board};
      const graph=await loadGraph(v.graphVersion);
      if(step===0){const route=shortestPath(graph.index,v.question.start,v.question.end,v.variant==='limited'?new Set([v.question.start,v.question.end,...v.current.hand]):undefined);command={type:'play',playerId:route[1],index:0};}
      else if(step===1&&v.variant==='limited'&&v.current.token&&v.current.hand.length)command={type:'swap',playerId:v.current.hand[0]};
      else if(step===3&&v.variant==='limited'&&v.current.token)command={type:'refresh'};
      else if(step===9&&v.current.board.length)command={type:'remove',playerId:v.current.board[0]};
      else if(step%2===0){
        const chain=[v.question.start,...v.current.board,v.question.end],pool=v.variant==='limited'?v.current.hand:graph.data.players.map(p=>p.id).filter(id=>!chain.includes(id));
        outer:for(let i=0;i<chain.length-1;i++)for(const playerId of pool)if(graph.index.get(chain[i])?.has(playerId)||graph.index.get(chain[i+1])?.has(playerId)){command={type:'play',playerId,index:i};break outer;}
      }
      const start=performance.now();worker.view=await commandMatch(worker.id,worker.owner,{requestId:randomUUID(),revision:v.revision,phaseRevision:v.phaseRevision,command});const elapsed=performance.now()-start;latencies.push(elapsed);(byCommand[command.type]??=[]).push(elapsed);bytes.push(Buffer.byteLength(JSON.stringify(worker.view)));
    }
  }));
  report.capacity={scope:'application-service (not HTTP or Socket latency)',rooms:100,players:200,commandsPerPlayerPerSecond:1,commands:latencies.length,elapsedMs:performance.now()-began,commandMs:quantiles(latencies),byCommand:Object.fromEntries(Object.entries(byCommand).map(([key,values])=>[key,quantiles(values)])),creationMs:quantiles(creation),receiptBytes:quantiles(bytes)};
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report.capacity));
  if(soakSeconds){
    const versions=[];for(let i=0;i<12;i++){const version=require('node:crypto').createHash('sha256').update(`soak-${i}`).digest('hex');versions.push(version);await db('card_graphs').insert({version,source_revision:0,payload:JSON.stringify({...playable,version}),created_at:Date.now()});}
    const started=Date.now(),samples=[];let iterations=0;
    while(Date.now()-started<soakSeconds*1000){
      await loadGraph(versions[iterations%versions.length]);
      const owner={key:`g:soak-${iterations}`,userId:null,name:'Soak'},m=await createMatch(owner,'practice','limited','normal',180,randomUUID()),v=await readView(m.id,owner);
      await commandMatch(m.id,owner,{requestId:randomUUID(),revision:v.revision,phaseRevision:v.phaseRevision,command:{type:'lock'}});await settle(m.id);
      if(iterations%30===0){global.gc?.();samples.push({seconds:(Date.now()-started)/1000,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});}
      iterations++;await sleep(1000);
    }
    report.soak={seconds:(Date.now()-started)/1000,iterations,versions:12,configuredCacheBound:8,samples};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log('PASS completed bounded-version soak');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.destroy());
