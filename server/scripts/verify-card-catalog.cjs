// Audit current approved data and generated questions. Publish only explicitly,
// after every validation; old graph payloads and existing matches are immutable.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {db}=require('../dist/db/knex');
const {careerSchema}=require('../dist/card-link/careers');
const {effectiveTenures}=require('../dist/card-link/tenures');
const {buildGraph,buildCandidate,publishGraph,selectQuestions}=require('../dist/card-link/graphs');
const {graphIndex,shortestPath,createRound}=require('@friberg/card-link-core');
if(!process.env.DB_URL||!process.argv[2])throw Error('Explicit DB_URL and report path required');
async function main(){
 const rows=(await db('players as p').join('card_careers as c','p.id','c.player_id').where('p.is_enabled',true).select('p.id','p.nickname','p.age','p.nationality','p.team','c.payload')).map(r=>({...r,id:Number(r.id),career:careerSchema.parse(JSON.parse(r.payload))}));
 const catalog=await db('card_catalog').where({id:1}).first();
 const old=catalog.graph_version?JSON.parse((await db('card_graphs').where({version:catalog.graph_version}).first()).payload):null;
 const data=buildGraph(rows),index=graphIndex(data);
 const byPerson=new Map();
 for(const r of rows){const list=byPerson.get(r.career.personKey)??[];list.push(r);byPerson.set(r.career.personKey,list);}
 const intervals=new Map();
 for(const list of byPerson.values())intervals.set(Math.min(...list.map(r=>r.id)),effectiveTenures(list.flatMap(r=>r.career.tenures)));
 for(const edge of data.edges){
  assert(edge.a!==edge.b);assert(edge.evidence.length);
  for(const e of edge.evidence){
   assert(e.start<e.end);
   for(const id of [edge.a,edge.b])assert(intervals.get(id).some(t=>t.team===e.team&&t.start<=e.start&&t.end>=e.end&&(['active','loan'].includes(t.status)||(['trial','standin'].includes(t.status)&&t.verified))));
  }
 }
 let pairs=0,hands=0;
 const pairCounts={},diversity={};
 for(const difficulty of ['easy','normal','hard']){
  const bounds=difficulty==='easy'?[2,2]:difficulty==='normal'?[3,3]:[4,5];
  const candidates=data.pairs[difficulty];assert(candidates.length>=3);
  const unique=new Set();
  for(const [start,end] of candidates){const key=[start,end].sort((a,b)=>a-b).join(':');assert(!unique.has(key));unique.add(key);const route=shortestPath(index,start,end);assert(route&&route.length-1>=bounds[0]&&route.length-1<=bounds[1]);pairs++;}
  pairCounts[difficulty]=candidates.length;
  let repeated=0;
  for(let n=0;n<100;n++){
   const qs=selectQuestions({data,index},difficulty,3);
   if(new Set(qs.flatMap(q=>[q.start,q.end])).size<6)repeated++;
   for(const q of qs)for(let k=0;k<10;k++){
    const s=createRound(index,q,'limited',n*100+k+1,0,180);
    assert(shortestPath(index,q.start,q.end,new Set([q.start,q.end,...s.hand])));
    const cards=[...s.hand,...s.deck];assert.equal(new Set(cards).size,q.pool.length);assert.equal(cards.length,q.pool.length);hands++;
   }
  }
  diversity[difficulty]={matches:100,repeatedEndpointPlayers:repeated};
 }
 const key=e=>`${e.a}:${e.b}`,before=new Set(old?.edges.map(key)),after=new Set(data.edges.map(key));
 const report={observedAt:new Date().toISOString(),sourceRevision:Number(catalog.revision),version:data.version,previousVersion:catalog.graph_version,players:data.players.length,edges:data.edges.length,pairCounts,checkedPairs:pairs,checkedHands:hands,endpointDiversity:diversity,addedEdges:data.edges.filter(e=>!before.has(key(e))),removedEdges:(old?.edges??[]).filter(e=>!after.has(key(e))),published:false};
 if(process.argv.includes('--publish')){const built=await buildCandidate();assert.equal(built.version,data.version,'Data changed during validation');await publishGraph(data.version);report.published=true;}
 fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,addedEdges:report.addedEdges.length,removedEdges:report.removedEdges.length},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.destroy());
