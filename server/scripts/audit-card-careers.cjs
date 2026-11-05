// Read-only consistency/quality audit. DB_URL is mandatory; never repairs data.
const fs = require('node:fs');
const { db } = require('../dist/db/knex');
const { careerSchema } = require('../dist/card-link/careers');
if (!process.env.DB_URL || !process.argv[2]) throw Error('Explicit DB_URL and output path required');
async function main() {
  const rows = await db('players as p').leftJoin('card_careers as c','p.id','c.player_id').select('p.id','p.nickname','p.is_enabled','c.payload');
  const indexed = await db('card_career_tenures');
  const indexes = new Map(indexed.map(t=>[`${t.player_id}:${t.ordinal}`,t]));
  const issues = [], precision = {}, counts = {players:rows.length,careers:0,tenures:0};
  for (const row of rows) {
    const add = (kind, ordinals=[], detail='') => issues.push({playerId:Number(row.id),nickname:row.nickname,enabled:Boolean(row.is_enabled),kind,ordinals,detail});
    if (!row.payload) { add('missing_career'); continue; }
    const parsed = careerSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success) { add('invalid_schema'); continue; }
    counts.careers++;
    const c = parsed.data;
    c.tenures.forEach((t,i)=>{
      counts.tenures++; precision[t.precision]=(precision[t.precision]??0)+1;
      const ix=indexes.get(`${row.id}:${i}`);
      if (!ix || ix.person_key!==c.personKey || ix.team_id!==t.teamId || ix.start_date!==t.start || ix.end_date!==t.end || JSON.stringify(careerSchema.shape.tenures.element.parse(JSON.parse(ix.payload)))!==JSON.stringify(t)) add('index_mismatch',[i]);
      indexes.delete(`${row.id}:${i}`);
      if (!t.start || !t.end || !['day','month'].includes(t.precision)) add('date_gap',[i],t.team);
      if (t.start && t.end && t.start>=t.end) add(t.precision==='day' && t.start>t.end?'reversed_exact_dates':'empty_interval',[i],t.team);
      if (t.status==='unknown') add('unknown_role',[i],t.team);
      if (t.manual && !t.sourceSnapshot) add('manual_without_source_snapshot',[i],t.team);
      if (t.status!=='active' || !t.start || !t.end || t.start>=t.end) return;
      c.tenures.slice(0,i).forEach((u,j)=>{
        if(u.status==='active'&&u.teamId!==t.teamId&&u.start&&u.end&&Math.max(0,Date.parse(u.start),Date.parse(t.start))<Math.min(Date.parse(u.end),Date.parse(t.end)))
          add('overlapping_active_teams',[j,i],`${u.team} / ${t.team}`);
      });
    });
  }
  for (const key of indexes.keys()) issues.push({kind:'orphan_index',key});
  const report={observedAt:new Date().toISOString(),...counts,precision,issueCounts:issues.reduce((a,x)=>(a[x.kind]=(a[x.kind]??0)+1,a),{}),issues};
  fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,issues:undefined}));
  if(issues.some(x=>['invalid_schema','index_mismatch','orphan_index'].includes(x.kind))) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.destroy());
