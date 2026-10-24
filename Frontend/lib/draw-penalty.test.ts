import {expect,it} from 'vitest';
import {boardDrawPenalties,evaluateDraw,initialRatingBoard} from './draw-penalty';
import {passiveDrawHistory} from './draw-fixtures';

it('charges both passive players after exactly 200 legal plies',()=>{
  const result=evaluateDraw(passiveDrawHistory());
  expect(result.agent1.penalty).toBe(29);expect(result.agent2.penalty).toBe(29);
  expect(result.agent1.opponentPieces).toBe(10);
});
it('charges less after reducing the opponent material',()=>{
  const full=initialRatingBoard(),reduced=initialRatingBoard();
  const kept=new Set<string>();
  reduced.forEach((p,i)=>{if(p?.player===2){if(kept.has(p.type))reduced[i]=null;else kept.add(p.type);}});
  expect(boardDrawPenalties(reduced).agent1.penalty).toBeLessThan(boardDrawPenalties(full).agent1.penalty);
});
it('charges less for own pieces close to the enemy base, independently for each side',()=>{
  const far=initialRatingBoard(),near=initialRatingBoard();
  near.forEach((p,i)=>{if(p?.player===1)near[i]=null;});
  near[79]={player:1,type:'ROCK'};near[71]={player:1,type:'PAPER'};near[70]={player:1,type:'SCISSORS'};
  const a=boardDrawPenalties(far),b=boardDrawPenalties(near);
  expect(b.agent1.penalty).toBeLessThan(a.agent1.penalty);
  expect(b.agent1.averageDistance).toBe(1);
});
it('uses symmetric distances to i9 and a1',()=>{
  const board=initialRatingBoard();board[80]=board[28];board[28]=null;
  const flipped=[...board].reverse().map(p=>p?{...p,player:3-p.player}:null);
  expect(boardDrawPenalties(board).agent1.penalty).toBe(boardDrawPenalties(flipped).agent2.penalty);
});
it('rejects short, duplicated, out-of-turn and illegal draw replays',()=>{
  expect(()=>evaluateDraw(passiveDrawHistory(150))).toThrow('200');
  for(const mutation of [(m:ReturnType<typeof passiveDrawHistory>)=>{m[1].move_number=1;},
    (m:ReturnType<typeof passiveDrawHistory>)=>{m[1].player=1;},
    (m:ReturnType<typeof passiveDrawHistory>)=>{m[0].to_col=7;}]){
    const moves=passiveDrawHistory();mutation(moves);expect(()=>evaluateDraw(moves)).toThrow();
  }
});
