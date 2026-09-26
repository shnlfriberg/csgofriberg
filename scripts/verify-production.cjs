// Run only inside the disposable containers created by verify-production.sh.
// Uses runtime dependencies from the production image; never needs local secrets.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const requireServer = createRequire('/app/server/dist/index.js');
const { db } = requireServer('./db/knex.js');
const { modifiedSha256, hasLeadingZeroBits } = requireServer('./services/pow.js');
const { createClient } = requireServer('redis');

assert.equal(process.env.REDIS_PREFIX, 'soup-release-qa:');
assert.equal(new URL(process.env.DB_URL).pathname, '/soup_release_qa');

async function main() {
  const phase = process.argv[2];
  if (phase === 'legacy') {
    assert.equal(Number((await db('games').count('* as n').first()).n), 0);
    const player = await db('players').first();
    await db.schema.alterTable('games', t => {
      for (const name of ['variant', 'question_count', 'soup_events', 'answer_snapshot']) t.dropColumn(name);
    });
    await db('games').insert({session_id:'release-qa-legacy', target_player_id:player.id, mode:'easy', status:'won', guess_count:3, guesses:'[]', finished_at:db.fn.now()});
    console.log('PASS prepared legacy schema and classic record in isolated PostgreSQL');
    return;
  }
  if (phase === 'migration') {
    const game = await db('games').where({session_id:'release-qa-legacy'}).first();
    assert.equal(game.variant,'classic'); assert.equal(game.status,'won'); assert.equal(game.guess_count,3);
    assert.equal(game.question_count,0); assert.equal(game.soup_events,null); assert.equal(game.answer_snapshot,null);
    assert.equal(Number((await db('games').count('* as n').first()).n),1);
    console.log('PASS empty/legacy/repeated PostgreSQL migrations preserve classic result');
    return;
  }
  assert.equal(phase,'http');
  const origin='https://soup-release-qa.invalid';
  const cookies=new Map();
  async function request(path, body, overrides={}) {
    const response=await fetch(`http://app:3000${path}`, {
      method:body===undefined?'GET':'POST',
      headers:{'User-Agent':'soup-release-qa','Origin':origin,'X-Forwarded-Proto':'https','X-Forwarded-For':'192.0.2.10','Content-Type':'application/json',Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...overrides},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(15000),
    });
    for(const cookie of response.headers.getSetCookie()) {
      const [pair]=cookie.split(';'); const i=pair.indexOf('='); cookies.set(pair.slice(0,i),pair.slice(i+1));
      assert.match(cookie,/HttpOnly/i); assert.match(cookie,/Secure/i); assert.match(cookie,/SameSite=Strict/i);
    }
    return response;
  }
  const health=await request('/api/health'); assert.equal(health.status,200); assert.equal((await health.json()).redis,'up');
  const deep=await request('/turtle-soup/beginner'); assert.equal(deep.status,200); assert.equal(deep.headers.get('cache-control'),'no-cache');
  const html=await deep.text(); assert.match(html,/<div id="root">/);
  const asset=html.match(/src="(\/assets\/[^" ]+\.js)"/); assert(asset);
  const js=await request(asset[1]); assert.equal(js.status,200); assert.match(js.headers.get('cache-control'),/immutable/);
  assert.equal((await request('/assets/absent-release-qa.js')).status,404);
  console.log('PASS production static assets, SPA deep link and cache headers');
  assert.equal((await request('/api/auth/session',{})).status,428);
  const challengeResponse=await request('/api/pow/challenge',{}); assert.equal(challengeResponse.status,200);
  assert.equal(challengeResponse.headers.get('cache-control'),'no-store');
  const challenge=await challengeResponse.json(); const bytes=Buffer.from(challenge.challenge,'base64url');
  let nonce=0n; while(!hasLeadingZeroBits(modifiedSha256(bytes,nonce),challenge.difficulty)) nonce++;
  const verified=await request('/api/pow/verify',{id:challenge.id,nonce:String(nonce)}); assert.equal(verified.status,200);
  assert.equal(verified.headers.get('cache-control'),'no-store');
  const session=await request('/api/auth/session',{}); assert.equal(session.status,200);
  assert.equal((await session.json()).authenticated,false);
  assert(cookies.has('csgofriberg_guest')); assert(cookies.has('csgofriberg_pow'));
  assert.equal((await request('/api/auth/session',{}, {'X-Forwarded-For':'192.0.2.11'})).status,428);
  assert.equal((await request('/api/auth/session',{}, {Origin:'https://untrusted.invalid'})).status,403);
  console.log('PASS real PoW, secure identity cookies, trusted proxy fingerprint and origin rejection');
  const start=await request('/api/game/start',{mode:'beginner',variant:'turtle-soup'}); assert.equal(start.status,200);
  let view=await start.json(); const id=view.gameId; assert.equal(view.questionCount,0);
  assert.equal(view.maxQuestions,24); assert.equal(view.remainingQuestions,24); assert.equal(view.guessUnlocked,true);
  const redis=createClient({url:process.env.REDIS_URL}); await redis.connect();
  try {
    const saved=JSON.parse(await redis.get(`${process.env.REDIS_PREFIX}single:game:${id}`));
    assert.equal(saved.id,id); assert.equal(saved.userId,null);
    const question={requestId:randomUUID(),version:0,field:'age',value:25};
    for(let i=0;i<2;i++) { const r=await request(`/api/game/${id}/question`,question);assert.equal(r.status,200);view=await r.json();assert.equal(view.questionCount,1); }
    assert.equal((await request(`/api/game/${id}/question`,{...question,requestId:randomUUID()})).status,409);
    const second=await request(`/api/game/${id}/question`,{requestId:randomUUID(),version:1,field:'isActive',value:true});
    assert.equal(second.status,200); assert.equal((await second.json()).questionCount,2);
    const guess=await request(`/api/game/${id}/guess`,{requestId:randomUUID(),version:2,playerId:saved.targetPlayerId});
    assert.equal(guess.status,200); const won=await guess.json(); assert.equal(won.status,'won');
    assert.equal(won.remainingQuestions,21); assert.equal(won.guessCount,1);
    const record=await db('games').where({session_id:id}).first();
    await db('players').where({id:saved.targetPlayerId}).update({nickname:`qa-renamed-${saved.targetPlayerId}`,age:99});
    const replay=await request(`/api/stats/games/${record.id}/replay`); assert.equal(replay.status,200);
    const replayData=await replay.json(); assert.deepEqual(replayData.answer,won.answer); assert.deepEqual(replayData.events,won.events);
    const summary=await request('/api/stats/me?variant=turtle-soup'); const stats=await summary.json();
    assert.equal(summary.status,200); assert.equal(stats.personal.totalGames,1); assert.equal(stats.personal.avgGuesses,3);
    console.log('PASS PostgreSQL soup settlement, request deduplication, 409 and immutable snapshot replay');
    const username='release-qa-user'; const password=randomUUID();
    const [user]=await db('users').insert({username,password_hash:requireServer('bcryptjs').hashSync(password,8)}).returning('id');
    const login=await request('/api/auth/login',{username,password}); assert.equal(login.status,200);
    assert(cookies.has('csgofriberg_session')); assert(cookies.has('csgofriberg_refresh'));
    const auth=await request('/api/auth/me'); assert.equal((await auth.json()).user.id,user.id);
    const claim=await request('/api/auth/claim',{}); assert.equal(claim.status,200); assert.equal((await claim.json()).claimed,1);
    const claimed=await request('/api/stats/me?variant=turtle-soup'); assert.equal((await claimed.json()).personal.avgGuesses,3);
    const oldSession=cookies.get('csgofriberg_session');
    assert.equal((await request('/api/auth/logout',{})).status,200);
    assert.equal((await request('/api/auth/me',undefined,{Cookie:`csgofriberg_session=${oldSession}; csgofriberg_pow=${cookies.get('csgofriberg_pow')}`})).status,401);
    console.log('PASS production login, secure auth cookies, guest claim and logout token invalidation');
  } finally {await redis.quit();}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.destroy());
