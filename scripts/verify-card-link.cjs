// Disposable production-container acceptance. Never mount the real database.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { pollState } = require('./production-poll.cjs');
const requireServer = createRequire('/app/server/dist/index.js');
const { db } = requireServer('./db/knex.js');
const { config } = requireServer('./config.js');
const { browserFingerprint } = requireServer('./services/pow.js');
const jwt = requireServer('jsonwebtoken');
const WebSocket = createRequire(createRequire(requireServer.resolve('socket.io')).resolve('engine.io'))('ws');
const sockets = [];
const { loadGraph, buildCandidate, publishGraph } = requireServer('./card-link/graphs.js');
const { submitCareer, reviewCareer } = requireServer('./card-link/careers.js');
const { shortestPath } = requireServer('@friberg/card-link-core');
assert.equal(new URL(process.env.DB_URL).pathname, '/soup_release_qa');
const agent = 'card-link-container-qa', ip = '192.0.2.199';
const cookie = index => `csgofriberg_guest=${jwt.sign({key:`card-container-${index}`,typ:'guest'},config.jwtSecret,{expiresIn:'1h'})}; csgofriberg_pow=${jwt.sign({typ:'pow',fp:browserFingerprint(agent,ip),jti:randomUUID(),difficulty:config.powDifficulty},config.jwtSecret,{expiresIn:'1h'})}`;
async function request(host,index,path,body) {
  const response=await fetch(`http://${host}:3000/api/card-link${path}`,{
    method:body===undefined?'GET':'POST',headers:{Cookie:cookie(index),'User-Agent':agent,'X-Forwarded-For':ip,'X-Forwarded-Proto':'https',Origin:'https://soup-release-qa.invalid','Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000),
  });
  const data=await response.json();request.lastServerDate=response.headers.get('date');assert.equal(response.status,200,JSON.stringify(data));return data;
}
async function watch(host, index, id) {
  const socket = new WebSocket(`ws://${host}:3000/socket.io/?EIO=4&transport=websocket`, {
    headers: { Cookie: cookie(index), 'User-Agent': agent, 'X-Forwarded-For': ip, Origin: 'https://soup-release-qa.invalid' },
  });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CARD_WATCH_TIMEOUT')), 15000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('message', bytes => {
      const packet = String(bytes);
      if (packet === '2') socket.send('3');
      else if (packet.startsWith('0')) socket.send('40');
      else if (packet.startsWith('40')) socket.send(`421${JSON.stringify(['card-link:watch', { id }])}`);
      else if (packet.startsWith('431')) {
        clearTimeout(timer);
        const [ack] = JSON.parse(packet.slice(3));
        if (ack.ok) resolve(); else reject(new Error(JSON.stringify(ack)));
      }
    });
  });
}
async function main() {
  if(process.argv[2]==='resume'){
    const saved=JSON.parse(fs.readFileSync('/app/location-assets/card-qa.json','utf8'));
    await Promise.all([watch('app2', 0, saved.id), watch('app2', 1, saved.id)]);
    const restored=await request('app2',0,`/matches/${saved.id}`);
    assert.deepEqual(restored.current,saved.view.current);
    assert.deepEqual(await request('app2',0,`/matches/${saved.id}/commands`,saved.input),saved.receipt);
    assert.equal(Number((await db('card_requests').where({scope:`command:${saved.id}:g:card-container-0`,request_id:saved.input.requestId}).count('* as n').first()).n),1);
    for(const i of [0,1])await request('app2',i,`/matches/${saved.id}/control`,{action:'leave',requestId:randomUUID()});
    const {settle}=requireServer('./card-link/settlement.js');await Promise.all([settle(saved.id),settle(saved.id)]);
    assert.equal(Number((await db('card_participants').where({match_id:saved.id}).count('* as n').first()).n),2);
    console.log('PASS card cross-instance recovery after app loss; immutable receipt; exactly-once PostgreSQL settlement');return;
  }
  // Real PostgreSQL round trip for exported manual dates and crawler no-ops.
  const {exportPlayers}=requireServer('./services/playerExport.js');
  const {importPlayers,playerImportSchema}=requireServer('./services/playerMutations.js');
  const [fixture]=await db('players').insert({nickname:'career-export-qa',nationality:'Sweden',age:25}).returning('id');
  const fixtureId=Number(fixture.id);
  await db('player_difficulties').insert({player_id:fixtureId,difficulty_key:'normal'});
  const source={personKey:'qa:career-export',page:'https://example.com/career',sourceRevision:'qa',observedAt:'2026-10-24',aliases:[],locked:false,
    tenures:[{teamId:'export-qa',team:'Export QA',game:'csgo',start:'2013-12-31',end:'2014-06-20',precision:'year',status:'active',rawDates:'2013 — 2014-06-20',source:'https://example.com/career',verified:false}]};
  let submitted=await submitCareer({playerId:fixtureId,expectedRevision:0,career:source},'qa',randomUUID());
  await reviewCareer(submitted.id,true,1);
  const edited=structuredClone(source);
  Object.assign(edited.tenures[0],{start:'2013-05-31',precision:'month',manual:{fields:['start','precision'],source:'https://www.hltv.org/player/1/qa',checkedAt:'2026-10-24',note:'QA fixture'}});
  submitted=await submitCareer({playerId:fixtureId,expectedRevision:1,career:edited},'admin:1',randomUUID());
  await reviewCareer(submitted.id,true,1);
  const savedCareer=await db('card_careers').where({player_id:fixtureId}).first();
  const exported=(await exportPlayers()).find(p=>p.playerId===fixtureId);
  assert.equal(exported.career.tenures[0].start,'2013-05-31');
  assert.equal(exported.career.tenures[0].sourceSnapshot.start,'2013-12-31');
  await importPlayers(playerImportSchema.parse({players:[exported]}).players,1);
  assert.equal((await submitCareer({playerId:fixtureId,expectedRevision:2,career:source},'qa',randomUUID())).status,'unchanged');
  assert.deepEqual(await db('card_careers').where({player_id:fixtureId}).first(),savedCareer);
  console.log('PASS PostgreSQL career JSON round trip and protected month retention on crawler replay');
  const day=n=>new Date(Date.UTC(2010,0,n*3+1)).toISOString().slice(0,10);
  for(let i=0;i<32;i++){
    const [player]=await db('players').insert({nickname:`card-qa-${i}`,nationality:'Sweden',age:25}).returning('id');
    const career={personKey:`qa:${i}`,page:`https://example.com/${i}`,sourceRevision:'qa',observedAt:'2026-10-24',aliases:[],locked:false,
      tenures:[i-1,i].filter(n=>n>=0&&n<31).map(n=>({teamId:`qa:${n}`,team:`QA ${n}`,game:'csgo',start:day(n),end:day(n+1),precision:'day',status:'active',rawDates:'fixture',source:`https://example.com/${i}`,verified:false}))};
    const review=await submitCareer({playerId:Number(player.id),expectedRevision:0,career},'qa',randomUUID());await reviewCareer(review.id,true,1);
  }
  const built=await buildCandidate();await publishGraph(built.version);
  await verifyLaunchFixes(built.version);
  const {settle: settleSolo}=requireServer('./card-link/settlement.js');
  for (const variant of ['limited','unlimited']) for (const duration of [0,120]) {
    const solo=await request('app',2,'/matches',{scene:'practice',variant,difficulty:'easy',duration,requestId:randomUUID()});
    const state=await request('app2',2,`/matches/${solo.id}`);
    assert.equal(state.duration,duration);
    assert.equal(state.current.deadline,duration===0?null:state.current.startedAt+duration*1000);
    assert.equal(state.expiresAt,state.current.startedAt+1800000);
    assert.equal(state.dueAt,state.current.deadline??state.expiresAt);
    await request('app2',2,`/matches/${solo.id}/control`,{action:'leave',requestId:randomUUID()});
    await settleSolo(solo.id);
  }
  const careerStats=await request('app',2,'/stats?variant=limited');
  assert.equal(careerStats.personal.games,2);assert.equal(careerStats.personal.solved,0);
  const careerList=await request('app2',2,'/replays?variant=limited&scene=practice&page=1');
  assert.equal(careerList.items.length,2);assert.equal(careerList.hasNext,false);
  assert(!JSON.stringify(careerList).includes('g:card-container'));
  assert.equal((await request('app2',3,'/replays?variant=limited')).items.length,0);
  console.log('PASS PostgreSQL timed/untimed solo settings and private career statistics/replays');
  // Room expiry is persisted and enforced across the two production processes.
  for (const scene of ['practice','daily']) {
    const solo=await request('app',4,'/matches',{scene,variant:'unlimited',difficulty:'normal',duration:0,requestId:randomUUID()});
    let state=await request('app2',4,`/matches/${solo.id}`);
    assert.equal(state.current.deadline,null);assert.equal(state.duration,0);
    const cutoff=state.expiresAt;
    if(scene==='daily') assert.equal(cutoff,Date.parse(`${state.day}T00:00:00+08:00`)+86400000);
    const graph=await loadGraph(state.graphVersion), path=shortestPath(graph.index,state.question.start,state.question.end);
    const input={requestId:randomUUID(),revision:state.revision,phaseRevision:state.phaseRevision,command:{type:'play',playerId:path[1],index:0}};
    state=await request('app',4,`/matches/${solo.id}/commands`,input);
    if(scene==='daily') assert.equal(state.expiresAt,cutoff);
    else assert(state.expiresAt>cutoff);
    assert.equal((await request('app2',4,`/matches/${solo.id}`)).expiresAt,state.expiresAt);
    const raw=await db('card_matches').where({id:solo.id}).first(), m=JSON.parse(raw.payload);
    m.expiresAt=Date.now()-1;m.dueAt=m.expiresAt;
    await db('card_matches').where({id:solo.id}).update({due_at:m.dueAt,payload:JSON.stringify(m)});
    const expired = await request('app2',4,`/matches/${solo.id}`);
    assert.equal(expired.status,'finished');assert.equal(expired.current.stoppedAt,m.expiresAt);
    assert.equal((await request('app',4,`/matches/${solo.id}`)).current.stoppedAt,expired.current.stoppedAt);
    await Promise.all([settleSolo(solo.id),settleSolo(solo.id)]);
    assert.equal(Number((await db('card_results').where({match_id:solo.id}).count('* as n').first()).n),1);
  }
  console.log('PASS PostgreSQL solo idle renewal, untimed daily midnight cutoff and cross-instance expiry settlement');
  const formal=await request('app',5,'/matches',{scene:'daily',variant:'limited',difficulty:'normal',duration:0,requestId:randomUUID()});
  const formalView=await request('app2',5,`/matches/${formal.id}`);
  await request('app2',5,`/matches/${formal.id}/control`,{action:'leave',requestId:randomUUID()});
  await settleSolo(formal.id);
  const formalResult=(await db('card_results').where({match_id:formal.id}).first()).payload;
  const reopened=await Promise.all(['app','app2'].map(host=>request(host,5,'/matches',{scene:'daily',variant:'limited',difficulty:'normal',duration:0,requestId:randomUUID()})));
  assert.equal(reopened[0].id,reopened[1].id);assert.notEqual(reopened[0].id,formal.id);
  const replayId=reopened[0].id;
  let dailyView=await request('app2',5,`/matches/${replayId}`);
  assert.equal(dailyView.dailyPractice,true);assert.equal(dailyView.status,'playing');assert.equal(dailyView.current.hand.length,7);
  assert.deepEqual(dailyView.question,formalView.question);assert.equal(dailyView.expiresAt,formalView.expiresAt);
  const dailyGraph=await loadGraph(dailyView.graphVersion);
  // Simulate a previously persisted blocked hand in disposable PostgreSQL only.
  const recoveryMatch=JSON.parse((await db('card_matches').where({id:replayId}).first()).payload);
  const recoveryQuestion=recoveryMatch.questions[0];
  const blocked=recoveryQuestion.pool.find(pid=>!dailyGraph.index.get(recoveryQuestion.start)?.has(pid)&&!dailyGraph.index.get(recoveryQuestion.end)?.has(pid));
  assert(blocked);
  const recoverySeat=JSON.parse((await db('card_seats').where({match_id:replayId}).first()).payload);
  Object.assign(recoverySeat.current,{board:[],hand:[blocked],deck:recoveryQuestion.pool.filter(pid=>pid!==blocked),discarded:[],token:0});
  await db('card_seats').where({match_id:replayId}).update({payload:JSON.stringify(recoverySeat)});
  const rescueInput={requestId:randomUUID(),revision:dailyView.revision,phaseRevision:dailyView.phaseRevision,command:{type:'play',playerId:blocked,index:0}};
  const rescued=await Promise.all(['app','app2'].map(host=>request(host,5,`/matches/${replayId}/commands`,rescueInput)));
  assert.deepEqual(rescued[0],rescued[1]);dailyView=rescued[0];
  assert.equal(dailyView.current.refreshes,1);assert.equal(dailyView.current.token,0);assert.equal(dailyView.current.locked,false);
  assert.equal(dailyView.expiresAt,formalView.expiresAt);
  assert.deepEqual((await request('app2',5,`/matches/${replayId}`)).current,dailyView.current);
  console.log('PASS rejected play rescues unsolvable hand once across PostgreSQL instances without spending credit');
  const dailyPath=shortestPath(dailyGraph.index,dailyView.question.start,dailyView.question.end,new Set([dailyView.question.start,dailyView.question.end,...dailyView.current.hand]));
  assert(dailyPath);
  for(const playerId of dailyPath.slice(1,-1)) dailyView=await request('app2',5,`/matches/${replayId}/commands`,{requestId:randomUUID(),revision:dailyView.revision,phaseRevision:dailyView.phaseRevision,command:{type:'play',playerId,index:dailyView.current.board.length}});
  assert(dailyView.current.best);
  const lockedDaily = await request('app',5,`/matches/${replayId}/commands`,{requestId:randomUUID(),revision:dailyView.revision,phaseRevision:dailyView.phaseRevision,command:{type:'lock'}});
  assert(Number.isFinite(lockedDaily.current.stoppedAt));
  assert.equal((await request('app2',5,`/matches/${replayId}`)).current.stoppedAt,lockedDaily.current.stoppedAt);
  assert.equal(lockedDaily.current.best.elapsed,dailyView.current.best.elapsed);
  console.log('PASS persisted round stop time across instances for lock and expiry; score time unchanged');
  await settleSolo(replayId);
  assert.equal((await db('card_results').where({match_id:formal.id}).first()).payload,formalResult);
  assert.equal(Number((await db('card_daily_attempts').where({match_id:replayId}).count('* as n').first()).n),0);
  const {claimCardResults}=requireServer('./card-link/claims.js');
  const {dailyLeaderboard}=requireServer('./card-link/leaderboard.js');
  const [bestUser]=await db('users').insert({username:'card-best-qa',password_hash:'unused'}).returning('id');
  await claimCardResults('card-container-5',Number(bestUser.id));
  const retryScore=await db('card_participants').where({match_id:replayId}).first();
  let dailyRanks=await dailyLeaderboard('limited',dailyView.day);
  assert.equal(dailyRanks.length,1);assert.equal(dailyRanks[0].hops,Number(retryScore.hops));
  assert.equal(dailyRanks[0].elapsed,Number(retryScore.elapsed));
  // The original failed run cannot disqualify a solved retry; worse later scores
  // cannot replace it, even when they are faster but take more hops.
  const worseId=randomUUID();
  await db('card_results').insert({match_id:worseId,created_at:Date.now(),payload:'{}'});
  await db('card_participants').insert({...retryScore,match_id:worseId,hops:Number(retryScore.hops)+1,elapsed:0});
  assert.deepEqual(await dailyLeaderboard('limited',dailyView.day),dailyRanks);
  console.log('PASS PostgreSQL daily best across retries and guest claim; one account entry and no worse overwrite');
  console.log('PASS daily limited replay after leaving, concurrent resume, full legal hand play and immutable formal attempt');
  const {id}=await request('app',0,'/matches',{scene:'friend',variant:'limited',difficulty:'normal',duration:180,requestId:randomUUID()});
  let view=await request('app',0,`/matches/${id}`);
  await request('app2',1,'/join',{code:view.code});
  await Promise.all([watch('app', 0, id), watch('app2', 1, id)]);
  for(const i of [0,1])await request(i?'app2':'app',i,`/matches/${id}/control`,{action:'ready',requestId:randomUUID()});
  await request('app',0,`/matches/${id}/control`,{action:'start',requestId:randomUUID()});
  const preparations=[];
  view = await pollState(async () => {
    const began=Date.now();
    const current=await request('app',0,`/matches/${id}`);
    preparations.push({began,ended:Date.now(),serverDate:request.lastServerDate,status:current.status});
    return current;
  }, current => current.status === 'playing');
  if (view.status !== 'playing') {
    const stalled = JSON.parse((await db('card_matches').where({ id }).first()).payload);
    console.error('CARD_PREPARATION_TIMEOUT', JSON.stringify({ id, now: Date.now(), status: stalled.status,
      dueAt: stalled.dueAt, revision: stalled.revision, scene:stalled.scene, viewStatus: view.status, viewDueAt: view.dueAt, preparations }));
  }
  assert.equal(view.status,'playing');
  const graph=await loadGraph(view.graphVersion);
  const route=shortestPath(graph.index,view.question.start,view.question.end,new Set([view.question.start,view.question.end,...view.current.hand]));assert(route);
  const input={requestId:randomUUID(),revision:view.revision,phaseRevision:view.phaseRevision,command:{type:'play',playerId:route[1],index:0}};
  const receipts=await Promise.all(['app','app2'].map(host=>request(host,0,`/matches/${id}/commands`,input)));assert.deepEqual(receipts[0],receipts[1]);
  const opponent=await request('app2',1,`/matches/${id}`);assert(opponent.players.every(p=>!('hand' in p)&&!('board' in p)));assert(!JSON.stringify(opponent).includes('g:card-container'));
  view=await request('app2',0,`/matches/${id}`);assert.equal(view.current.token,1);assert.equal(view.current.hand.length,7);
  fs.writeFileSync('/app/location-assets/card-qa.json',JSON.stringify({id,input,view,receipt:receipts[0]}));
  console.log('PASS card additive career review, publication, guaranteed deal, two-app commands and private views');
}
async function verifyLaunchFixes(originalVersion) {
  const {signToken}=requireServer('./middleware/auth.js');
  const {createMatchIn}=requireServer('./card-link/matches.js');
  const {transaction,lockRow}=requireServer('./card-link/transaction.js');
  const {settle}=requireServer('./card-link/settlement.js');
  const {cancelQueue}=requireServer('./card-link/matchmaking.js');
  const {updatePlayer}=requireServer('./services/playerMutations.js');
  const users=[];
  for(let i=0;i<2;i++) {
    const [u]=await db('users').insert({username:`release-${randomUUID().slice(0,20)}`,password_hash:'fixture-only',role:i===0?'admin':'user',email:`${randomUUID()}@example.invalid`,email_verified_at:db.fn.now()}).returning('*');
    users.push({...u,key:`u:${u.id}`,userId:Number(u.id),name:`R${i}`});
  }
  async function call(host,user,path,body,expected=200) {
    const response=await fetch(`http://${host}:3000/api${path}`,{method:body===undefined?'GET':'POST',
      headers:{Cookie:`${cookie(30)}; csgofriberg_session=${signToken(user)}`,'User-Agent':agent,'X-Forwarded-For':ip,'X-Forwarded-Proto':'https',Origin:'https://soup-release-qa.invalid','Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
  }
  for(const path of ['/card-link/stats?variant=bad','/card-link/replays?page=1.5','/card-link/history?page=Infinity','/card-link/leaderboard?variant=bad','/card-link/daily-leaderboard?day=bad','/admin/card-link/reviews?page=-1'])
    assert.equal((await call('app',users[0],path,undefined,400)).code,'VALIDATION_FAILED');
  const {exportPlayers}=requireServer('./services/playerExport.js');
  const sample=(await exportPlayers()).find(p=>p.career && p.difficulties.length);
  const unchanged=await db('players').where({id:sample.playerId}).first();
  for(const input of [{...sample,career:null,playerId:sample.playerId+100000,age:40},{...sample,nickname:'stale-export-name'}])
    assert.equal((await call('app',users[0],'/admin/players/import',{players:[input]},409)).code,'PLAYER_TARGET_MISMATCH');
  assert.deepEqual(await db('players').where({id:sample.playerId}).first(),unchanged);
  assert.equal(await db('players').where({nickname:'stale-export-name'}).first(),undefined);
  console.log('PASS PostgreSQL stable import identity, atomic rejection and HTTP query validation');
  const bitmap=await requireServer('sharp')({create:{width:4000,height:4000,channels:3,background:'#558866'}}).png().toBuffer();
  const upload=async()=>{
    const response=await fetch('http://app:3000/api/admin/location/assets?purpose=radar',{method:'POST',
      headers:{Cookie:`${cookie(30)}; csgofriberg_session=${signToken(users[0])}`,'User-Agent':agent,'X-Forwarded-For':ip,'X-Forwarded-Proto':'https',Origin:'https://soup-release-qa.invalid','Content-Type':'image/png'},body:bitmap,signal:AbortSignal.timeout(30000)});
    const asset=await response.json();
    if(response.status===429){assert.equal(asset.code,'LOCATION_BUSY');return 429;}
    assert.equal(response.status,200,JSON.stringify(asset));assert.equal(asset.width,4000);assert.equal(asset.height,4000);
    assert.equal((await fetch(`http://app2:3000${asset.url}`)).status,200);
    return 200;
  };
  const uploaded=await Promise.all([upload(),upload()]);assert(uploaded.includes(200));
  for(const status of uploaded)if(status===429)assert.equal(await upload(),200);
  console.log('PASS concurrent 16-megapixel radar upload backpressure, retry and cross-instance reads: '+uploaded.join(','));
  const graph=await loadGraph(originalVersion);
  // Persist a failed finalization atomically so application workers cannot race
  // fixture setup and settle the match before the barrier is exercised.
  const ended=await transaction(async trx=>{
    await lockRow(trx,'card_catalog',{id:1});
    const m=await createMatchIn(trx,users.map(({key,userId,name})=>({key,userId,name})),'ranked','limited','normal',180,graph);
    m.status='finished';m.dueAt=null;m.revision++;
    await trx('card_matches').where({id:m.id}).update({status:m.status,due_at:null,revision:m.revision,payload:JSON.stringify(m)});
    await trx('card_reservations').where({match_id:m.id}).delete();
    await trx('card_outbox').insert({match_id:m.id,attempts:10,due_at:Date.now()+600000,error:'fixture failure'});return m;
  });
  for(const host of ['app','app2']) assert.equal((await call(host,users[0],'/card-link/queue',{variant:'limited'},409)).code,'CARD_SETTLEMENT_PENDING');
  assert.equal((await call('app2',users[0],'/card-link/queue',{variant:'unlimited'})).queued,true);await cancelQueue(users[0]);
  await Promise.all([settle(ended.id),settle(ended.id)]);
  assert.equal((await db('card_rating_ledger').where({match_id:ended.id})).length,2);
  assert.equal((await call('app2',users[0],'/card-link/queue',{variant:'limited'})).queued,true);await cancelQueue(users[0]);
  await call('app',users[0],'/admin/card-link/enabled',{scenes:{ranked:false}});
  assert.equal((await call('app2',users[1],'/card-link/queue',{variant:'limited'},503)).code,'CARD_SCENE_DISABLED');
  assert.equal((await call('app2',users[0],'/card-link/config')).scenes.practice,true);
  await call('app',users[1],'/admin/card-link/enabled',{scenes:{ranked:true}},403);
  await call('app',users[0],'/admin/card-link/enabled',{scenes:{ranked:true}});
  const target=graph.data.players[0],old=await db('players').where({id:target.id}).first();
  const before=await buildCandidate();await updatePlayer(target.id,{age:old.age+1});
  assert.equal((await call('app2',users[0],'/admin/card-link/publish',{version:before.version},409)).code,'CARD_GRAPH_STALE');
  const next=await buildCandidate();
  await call('app',users[0],'/admin/card-link/rollback',{version:next.version,expectedVersion:originalVersion,reason:'candidate'},409);
  await call('app',users[0],'/admin/card-link/publish',{version:next.version});
  await call('app2',users[0],'/admin/card-link/rollback',{version:originalVersion,expectedVersion:originalVersion,reason:'stale pointer'},409);
  await call('app2',users[0],'/admin/card-link/rollback',{version:originalVersion,expectedVersion:next.version,reason:'verified rollback'});
  assert.equal((await db('card_catalog').where({id:1}).first()).graph_version,originalVersion);
  const state=await call('app',users[0],'/admin/card-link/graphs');
  assert(state.events.some(e=>e.action==='rollback'));assert(state.monitoring.metrics);
  await updatePlayer(target.id,{age:old.age});await publishGraph((await buildCandidate()).version);
  console.log('PASS PostgreSQL two-app pending-Elo barrier, scene controls, admin authorization, source invalidation and audited graph rollback');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async () => {
  sockets.forEach(socket => socket.close());
  await db.destroy();
});
