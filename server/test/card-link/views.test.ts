import { describe, expect, it } from "vitest";
import { createRound, graphIndex, type GraphData } from "@friberg/card-link-core";
import { matchView } from "../../src/card-link/views";
import type { Match, Seat, SeatRow } from "../../src/card-link/types";
const evidence = [{team:"Frozen team",start:"2020-01-01",end:"2021-02-01",sources:["https://example.com/source"]}];
const data: GraphData = {version:"frozen",players:[1,2,3,4,5].map(id => ({id,nickname:`Player ${id}`,aliases:[],nationality:"",team:""})),pairs:{easy:[],normal:[],hard:[]},edges:[
  {a:1,b:2,evidence},{a:2,b:4,evidence},{a:1,b:3,evidence},{a:3,b:4,evidence},{a:2,b:3,evidence},
]};
const graph = {data,index:graphIndex(data)};
const question = {graphVersion:"frozen",start:1,end:4,pool:[2,3,5]};
const match: Match = {id:"match",code:null,host:"me",scene:"friend",variant:"unlimited",difficulty:"easy",status:"playing",revision:1,round:0,questions:[question],duration:180,dueAt:180000,day:null,createdAt:0,rulesVersion:1};
function row(key:string, board:number[]): SeatRow {
  const seat: Seat = {owner:{key,name:key,userId:null},ready:true,retired:false,results:[],current:{...createRound(graph.index,question,"unlimited",1,0,180),board}};
  return {match_id:match.id,identity_key:key,revision:1,payload:JSON.stringify(seat)};
}
describe("private connected-card evidence",()=>{
  it.each(['roundOver', 'finished'] as const)('reveals shortest-route evidence after %s even without a successful player', status => {
    const view = matchView({...match, status}, [row('me', [])], 'me', graph);
    expect(view.solution).toEqual([1, 2, 4]);
    expect(view.evidence).toEqual([data.edges[0], data.edges[1]]);
    expect(view.evidence[0].evidence).toEqual(evidence);
  });
  it('combines example and saved-path evidence without leaking unrelated edges', () => {
    const mine = row('me', []);
    const seat = JSON.parse(mine.payload) as Seat;
    seat.results = [{path:[1,3,4],elapsed:1000}];
    mine.payload = JSON.stringify(seat);
    const view = matchView({...match,status:'finished'}, [mine], 'me', graph);
    expect(view.evidence).toEqual(data.edges.slice(0,4));
    const restricted = matchView({...match,status:'finished',questions:[{...question,pool:[3]}]}, [row('me',[])], 'me', graph);
    expect(restricted.solution).toEqual([1,3,4]);
    expect(restricted.evidence).toEqual(data.edges.slice(2,4));
  });
  it("exposes frozen evidence only for the viewer's established adjacent links",()=>{
    const view=matchView(match,[row("me",[2]),row("opponent",[3])],"me",graph);
    expect(view.connections).toEqual([data.edges[0],data.edges[1]]);
    expect(view.connections[0].evidence).toEqual(evidence);
    expect(view.solution).toBeNull();
    expect(view.evidence).toEqual([]);
  });
  it("does not reveal disconnected, removed or merely available links",()=>{
    expect(matchView(match,[row("me",[5])],"me",graph).connections).toEqual([]);
    expect(matchView(match,[row("me",[])],"me",graph).connections).toEqual([]);
    expect(matchView({...match,status:"waiting"},[row("me",[2])],"me",graph).connections).toEqual([]);
  });
});
