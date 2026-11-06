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
  if (phase === 'password-reset') {
    const { initRedis, closeRedis } = requireServer('./redis.js');
    const password = requireServer('./services/password.js');
    const mailer = requireServer('./services/emailVerification.js');
    const mails = [];
    mailer.sendEmail = async (...args) => { mails.push(args); };
    const recovery = requireServer('./services/passwordReset.js');
    await initRedis();
    try {
      const email = `recovery-${randomUUID()}@example.com`;
      const username = `qa-${randomUUID().slice(0, 16)}`;
      const [user] = await db('users').insert({ username, email,
        email_verified_at: new Date(), password_hash: await password.hashPassword('Before-reset-password') }).returning('id');
      assert.equal(await recovery.reservePasswordReset(email), true);
      assert.equal(await recovery.reservePasswordReset(email), false);
      await recovery.issuePasswordReset(email);
      assert.equal(mails.length, 1); assert.equal(mails[0][0], email);
      assert(!/https?:|\.online/.test(mails[0][2]));
      const code = mails[0][2].match(/\b\d{6}\b/)[0];
      const results = await Promise.all([
        recovery.resetPassword(email, code, 'After-reset-password'),
        recovery.resetPassword(email, code, 'After-reset-password'),
      ]);
      assert.deepEqual(results.filter(Boolean), [{ userId: user.id, username }]);
      const updated = await db('users').where({ id: user.id }).first();
      assert.equal(updated.token_version, 1);
      assert.equal(await password.verifyPassword('After-reset-password', updated.password_hash), true);
      assert.equal(await recovery.resetPassword(email, code, 'Repeated-password'), null);
      console.log('PASS PostgreSQL password reset, Redis cooldown, code-only mocked mail, concurrent single consumption and token revocation');
    } finally { await closeRedis(); await password.closePasswordWorkers(); }
    return;
  }
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
  if (phase === 'location') {
    const { initRedis, redis, redisKey, closeRedis } = requireServer('./redis.js');
    const { encodeReplay, decodeReplay } = requireServer('./location/replayStorage.js');
    const { saveRoom } = requireServer('./location/rooms.js');
    const { retryResult } = requireServer('./location/resultOutbox.js');
    const { uploadAsset } = requireServer('./location/assets.js');
    await initRedis();
    try {
      const id = 'qa-' + randomUUID();
      const map = JSON.parse((await db('location_maps').first('payload')).payload);
      const asset = await uploadAsset(await requireServer('sharp')({ create: { width: 400, height: 400, channels: 3, background: '#336699' } }).png().toBuffer(), 'question');
      for (const host of ['app', 'app2']) {
        const response = await fetch(`http://${host}:3000${asset.url}`, { signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200); assert((await response.arrayBuffer()).byteLength > 0);
      }
      const question = { id, version: 1, mapId: map.id, mapVersion: map.version, floorId: map.floors[0].id, capturePointId: id,
        u: .5, v: .5, tier: 'easy', status: 'draft', imageUrl: asset.url, thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash,
        capturedAt: new Date().toISOString(), build: 'ISOLATED QA', source: 'Disposable production acceptance' };
      const payload = JSON.stringify(question);
      await db('location_questions').insert({ id, image_hash: asset.hash, payload });
      assert.equal((await db('location_questions').where({ id }).first()).point_id, id);
      // Only the dedicated migration process runs DDL. Repeated migration was exercised before app startup.
      const snapshot = { question, map };
      const record = { gameId: id, refs: [snapshot, snapshot] };
      assert.deepEqual(await decodeReplay(await encodeReplay(record)), record);
      assert.deepEqual(await decodeReplay(JSON.stringify(record)), record);
      const room = { id, gameId: id, host: 'g:qa-a', difficulty: 'easy', duration: 60, status: 'finished', round: 5,
        questions: Array(5).fill(snapshot), maps: [map], startsAt: null, endsAt: null, nextAt: null, revision: 1, createdAt: Date.now(),
        players: ['a', 'b'].map(key => ({ identity: { key: `g:qa-${key}`, userId: null, name: key }, socketId: key, ready: true,
          connected: false, retired: false, disconnectAt: null, guesses: Array(5).fill(null), currentGuess: null, requests: {} })) };
      await db('location_result_outbox').insert({ game_id: id, payload: JSON.stringify(room), attempts: 0, due_at: Date.now() + 60000 });
      await saveRoom(room);
      await redis().del(redisKey(`location:outbox:${id}`));
      await retryResult(id);
      const deadline = Date.now() + 30000;
      while (Number((await db('location_results').where({ game_id: id }).count({ count: '*' }).first()).count) !== 2) {
        if (Date.now() > deadline) throw new Error('LOCATION_SETTLEMENT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const rows = await db('location_results').where({ game_id: id });
      const { replay, answerGame, readGame, submitDaily } = requireServer('./location/games.js');
      for (const row of rows) {
        const decoded = await decodeReplay(row.payload);
        assert.equal(decoded.results.length, 5);
        const visible = await replay(id, decoded.owner);
        assert(!JSON.stringify(visible).includes('g:qa-'));
        assert(visible.participants.some(p => p.key === visible.myKey));
      }
      // A committed SQL result must survive a failed Redis final-state save.
      // Exercise the actual PostgreSQL codec and read through both application instances.
      const { saveGame, writeState } = requireServer('./location/store.js');
      for (const mode of ['random', 'daily']) {
        const gameId = randomUUID(), guestKey = `qa-final-${gameId}`;
        const owner = { key: `g:${guestKey}`, userId: null, name: 'QA' };
        const guess = { mapId: map.id, floorId: question.floorId, u: .5, v: .5 };
        const game = { id: gameId, owner, mode, difficulty: 'easy', date: mode === 'daily' ? '2001-01-02' : null,
          status: mode === 'daily' ? 'ready' : 'playing', questions: Array(5).fill(snapshot), maps: [map],
          guesses: Array(mode === 'daily' ? 5 : 4).fill(guess), requests: {}, version: mode === 'daily' ? 5 : 4,
          scoringVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 1800000 };
        await saveGame(game);
        const input = { ...guess, requestId: randomUUID(), round: 5, version: 4 };
        const client = Object.getPrototypeOf(redis()), multi = client.multi;
        let failed = false;
        client.multi = function(...args) {
          const batch = multi.apply(this, args), exec = batch.exec;
          batch.exec = async function(...values) {
            if (!failed) { failed = true; throw new Error('QA_FINAL_SAVE_FAILED'); }
            return exec.apply(this, values);
          };
          return batch;
        };
        try {
          await assert.rejects(() => mode === 'daily' ? submitDaily(gameId, owner) : answerGame(gameId, owner, input), /QA_FINAL_SAVE_FAILED/);
          assert(failed);
        } finally { client.multi = multi; }
        const final = await readGame(gameId, owner);
        assert.equal(final.status, 'finished'); assert.equal(final.totalScore, 25000);
        assert.deepEqual(await answerGame(gameId, owner, { ...input, requestId: randomUUID(), u: 0 }), final);
        await redis().del(redisKey(`location:game:${gameId}`));
        const jwt = requireServer('jsonwebtoken');
        const cookie = jwt.sign({ key: guestKey, typ: 'guest' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const { config } = requireServer('./config.js');
        const { browserFingerprint } = requireServer('./services/pow.js');
        const agent = 'location-finalization-qa', ip = '192.0.2.198';
        const proof = jwt.sign({ typ: 'pow', fp: browserFingerprint(agent, ip), jti: randomUUID(), difficulty: config.powDifficulty }, config.jwtSecret, { expiresIn: '1h' });
        for (const host of ['app', 'app2']) {
          const response = await fetch(`http://${host}:3000/api/location/games/${gameId}`, {
            headers: { Cookie: `csgofriberg_guest=${cookie}; csgofriberg_pow=${proof}`,
              'User-Agent': agent, 'X-Forwarded-For': ip, 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(15000) });
          assert.equal(response.status, 200); assert.deepEqual(await response.json(), final);
        }
      }
      await closeRedis();
      await assert.rejects(() => writeState('qa-required', 1), /REDIS_UNAVAILABLE/);
      await initRedis();
      assert.equal(await redis().get(redisKey('location:qa-required')), null);
      console.log('PASS PostgreSQL solo/daily committed-result recovery after Redis failure, two-app reads, private replay and required-Redis rejection');
      assert.equal((await db('location_questions').where({ id }).first()).payload, payload);
      const { createApiToken } = requireServer('./services/apiTokens.js');
      const { createPlayerChangeSubmission } = requireServer('./services/playerChangeSubmissions.js');
      const [admin] = await db('users').insert({ username: 'submission-qa-admin', password_hash: 'unused', role: 'admin' }).returning('id');
      const token = await createApiToken(admin.id, 'isolated QA', 1);
      assert.deepEqual(token.scopes, ['players:read', 'changes:submit']);
      const player = await db('players').first();
      const input = { players: [{ playerId: player.id, changes: { team: 'QA pending' }, expected: { team: player.team } }] };
      const receipts = await Promise.all([1, 2, 3].map(() => createPlayerChangeSubmission(input, token, 'qa-run-1')));
      assert.equal(new Set(receipts.map(r => r.submissionId)).size, 1);
      await assert.rejects(() => createPlayerChangeSubmission({ players: [{ playerId: player.id, changes: { team: 'different' } }] }, token, 'qa-run-1'), /IDEMPOTENCY_KEY_REUSED/);
      console.log('PASS PostgreSQL projections, compact/legacy replay, durable submission deduplication, two-instance settlement and shared assets');
    } finally { await closeRedis(); }
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
