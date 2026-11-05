// Disposable PostgreSQL + two application processes only. Never accepts live DBs.
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {pollState}=require('./production-poll.cjs');
const req=createRequire('/app/server/dist/index.js');
const {db}=req('./db/knex.js'),{config}=req('./config.js');
const {browserFingerprint}=req('./services/pow.js');
const {buildGraph}=req('./card-link/graphs.js');
const {graphIndex,shortestPath}=req('@friberg/card-link-core');
const jwt=req('jsonwebtoken');
const WebSocket=createRequire(createRequire(req.resolve('socket.io')).resolve('engine.io'))('ws');
assert.equal(new URL(process.env.DB_URL).pathname,'/soup_release_qa');
const sockets=[],workers=[],received=[],windows=new Map();
const agent='card-load-qa',sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
const q=values=>{const a=[...values].sort((x,y)=>x-y);return {n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],max:a.at(-1)};};
function headers(i){
 const ip=`192.0.2.${i+1}`;
 return {Cookie:`csgofriberg_guest=${jwt.sign({key:`card-load-${i}`,typ:'guest'},config.jwtSecret,{expiresIn:'1h'})}; csgofriberg_pow=${jwt.sign({typ:'pow',fp:browserFingerprint(agent,ip),jti:randomUUID(),difficulty:config.powDifficulty},config.jwtSecret,{expiresIn:'1h'})}`,
  'User-Agent':agent,'X-Forwarded-For':ip,'X-Forwarded-Proto':'https',Origin:'https://soup-release-qa.invalid','Content-Type':'application/json'};
}
async function call(i,path,body){
 const response=await fetch(`http://${i%2?'app2':'app'}:3000/api/card-link${path}`,{method:body===undefined?'GET':'POST',headers:headers(i),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
}
async function watch(i,id){
 const socket=new WebSocket(`ws://${i%2?'app2':'app'}:3000/socket.io/?EIO=4&transport=websocket`,{headers:headers(i)});sockets.push(socket);
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('load watch timeout')),15000);
  socket.on('error',e=>{clearTimeout(timer);reject(e);});
  socket.on('message',bytes=>{
   try{
    const packet=String(bytes);
    if(packet==='2')socket.send('3');
    else if(packet.startsWith('0'))socket.send('40');
    else if(packet.startsWith('40'))socket.send(`421${JSON.stringify(['card-link:watch',{id}])}`);
    else if(packet.startsWith('431')){clearTimeout(timer);const [ack]=JSON.parse(packet.slice(3));assert(ack.ok,JSON.stringify(ack));resolve();}
    else if(packet.startsWith('42')){
     const [event,payload]=JSON.parse(packet.slice(2));if(!event.startsWith('card-link:'))return;
     assert(payload.players.every(p=>!('hand' in p)&&!('board' in p)));
     const size=Buffer.byteLength(packet),key=`${id}:${Math.floor(Date.now()/1000)}`;
     received.push(size);windows.set(key,(windows.get(key)||0)+size);
    }
   }catch(e){clearTimeout(timer);reject(e);process.exitCode=1;}
  });
 });
}
async function main(){
 const day=n=>new Date(Date.UTC(2000,0,n*2+1)).toISOString().slice(0,10);
 const source=Array.from({length:700},(_,i)=>({id:i+10000,nickname:`Load${i}`,age:25,nationality:'',team:'',career:{personKey:`load:${i}`,page:'https://example.invalid',sourceRevision:'fixture',observedAt:'2026-11-04',aliases:[],locked:false,
  tenures:[Math.floor(i/8)-1,Math.floor(i/8)].filter(n=>n>=0).map(n=>({teamId:`load:${n}`,team:`Load ${n}`,game:'csgo',start:day(n),end:day(n+1),precision:'day',status:'active',rawDates:'fixture',source:'https://example.invalid',verified:false}))}}));
 const data=buildGraph(source);
 // Exercise the real child-process builder while both application processes
 // are warm and serving subscribed rooms. The old gate built graphs only in
 // this unrestricted test driver, outside the application's memory budget.
 for(let offset=0;offset<source.length;offset+=100){
  const batch=source.slice(offset,offset+100);
  await db('players').insert(batch.map(({career,...p})=>p));
  await db('card_careers').insert(batch.map(p=>({player_id:p.id,revision:1,payload:JSON.stringify({...p.career,
   tenures:[...p.career.tenures,...Array.from({length:11},(_,i)=>({...p.career.tenures[0],teamId:`private:${p.id}:${i}`,team:`Private ${i}`,start:`${1980+i}-01-01`,end:`${1981+i}-01-01`}))]})})));
 }
 const original=await db('card_catalog').where({id:1}).first();
 await db('card_graphs').insert({version:data.version,source_revision:0,payload:JSON.stringify(data),created_at:Date.now()});
 await db('card_catalog').where({id:1}).update({enabled:true,graph_version:data.version});
 const index=graphIndex(data),creation=[],warm=[];
 for(let room=0;room<100;room++){
  const a=room*2,b=a+1,variant=room%2?'limited':'unlimited',t=performance.now();
  const {id}=await call(a,'/matches',{scene:'friend',variant,difficulty:'normal',duration:300,requestId:randomUUID()});
  (room?warm:creation).push(performance.now()-t);
  const view=await call(a,`/matches/${id}`);await call(b,'/join',{code:view.code});
  await Promise.all([watch(a,id),watch(b,id)]);
  for(const i of [a,b])await call(i,`/matches/${id}/control`,{action:'ready',requestId:randomUUID()});
  await call(a,`/matches/${id}/control`,{action:'start',requestId:randomUUID()});
  workers.push({i:a,id},{i:b,id});
 }
 // Keep the real 3-second preparation and online presence workers active.
 for(const w of workers){w.view=await pollState(()=>call(w.i,`/matches/${w.id}`),v=>v.status==='playing');assert.equal(w.view.status,'playing',JSON.stringify({status:w.view.status,dueAt:w.view.dueAt,now:Date.now()}));}
 const buildJob=await req('./card-link/buildJobs.js').queueBuild();
 const latency=[],receiptBytes=[],types={},started=performance.now();
 await Promise.all(workers.map(async(w,offset)=>{
  for(let step=0;step<10;step++){
   await sleep(started+offset*5+step*1000-performance.now());const v=w.view;
   assert(!v.current.locked);let command={type:'reorder',board:v.current.board};
   if(step===0){const route=shortestPath(index,v.question.start,v.question.end,v.variant==='limited'?new Set([v.question.start,v.question.end,...v.current.hand]):undefined);command={type:'play',playerId:route[1],index:0};}
   else if(step===1&&v.variant==='limited')command={type:'swap',playerId:v.current.hand[0]};
   else if(step===3&&v.variant==='limited'&&v.current.token)command={type:'refresh'};
   else if(step===9&&v.current.board.length)command={type:'remove',playerId:v.current.board[0]};
   else if(step%2===0){
    const chain=[v.question.start,...v.current.board,v.question.end],pool=v.variant==='limited'?v.current.hand:data.players.map(p=>p.id).filter(id=>!chain.includes(id));
    outer:for(let j=0;j<chain.length-1;j++)for(const playerId of pool)if(index.get(chain[j])?.has(playerId)||index.get(chain[j+1])?.has(playerId)){command={type:'play',playerId,index:j};break outer;}
   }
   const t=performance.now();w.view=await call(w.i,`/matches/${w.id}/commands`,{requestId:randomUUID(),revision:v.revision,phaseRevision:v.phaseRevision,command});
   latency.push(performance.now()-t);receiptBytes.push(Buffer.byteLength(JSON.stringify(w.view)));types[command.type]=(types[command.type]||0)+1;
  }
 }));
 await sleep(1200);
 const build=await pollState(()=>db('card_build_jobs').where({id:buildJob.id}).first(),job=>['completed','failed'].includes(job.status),{timeoutMs:60000});
 assert.equal(build.status,'completed',JSON.stringify(build));
 console.log('PASS background graph build inside constrained application while 100 rooms stay subscribed');
 const report={scope:'two-app HTTP + subscribed Socket + online workers; container LAN',rooms:100,players:200,commands:latency.length,commandsPerPlayerPerSecond:1,elapsedMs:performance.now()-started,commandMs:q(latency),warmCreationMs:q(warm),coldCreationMs:creation[0],commandTypes:types,httpReceiptBytes:q(receiptBytes),socketPacketBytes:q(received),socketRoomSecondBytes:q([...windows.values()])};
 console.log(JSON.stringify(report));assert.equal(latency.length,2000);assert(received.length>0);assert(report.commandMs.p95<=150);assert(report.commandMs.p99<=300);assert(report.warmCreationMs.p95<=300);
 for(const w of workers)await call(w.i,`/matches/${w.id}/control`,{action:'leave',requestId:randomUUID()});
 await db('card_catalog').where({id:1}).update({enabled:original.enabled,graph_version:original.graph_version});
 await db('card_careers').whereIn('player_id',source.map(p=>p.id)).delete();
 await db('players').whereIn('id',source.map(p=>p.id)).delete();
 console.log('PASS two-app 100-room/200-player HTTP and Socket load, private broadcasts and response budgets');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{for(const s of sockets)s.close();await db.destroy();});
