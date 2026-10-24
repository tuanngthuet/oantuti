/** Public rendering contract; never expose arbitrary engine internals or source fields. */
export function cleanDisplay(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_RECORD');
 const v=value as Record<string,unknown>;
 if(!Array.isArray(v.board)||v.board.length!==81)throw Error('INVALID_RECORD');
 const board=v.board.map(p=>{
  if(p===null)return null;
  if(!p||typeof p!=='object'||![1,2].includes(p.player)||!['ROCK','PAPER','SCISSORS'].includes(p.type))throw Error('INVALID_RECORD');
  return {player:p.player as number,type:p.type as string};
 });
 const cells=(raw:unknown,bonus:boolean)=>{
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>81)throw Error('INVALID_RECORD');
  return raw.map(c=>{
   if(!c||typeof c!=='object'||!Number.isInteger(c.col)||!Number.isInteger(c.row)||c.col<0||c.col>8||c.row<0||c.row>8)throw Error('INVALID_RECORD');
   if(bonus&&c.points!==undefined&&(typeof c.points!=='number'||!Number.isFinite(c.points)))throw Error('INVALID_RECORD');
   return bonus?{col:c.col as number,row:c.row as number,points:(c.points??0) as number}:{col:c.col as number,row:c.row as number};
  });
 };
 const scores:Record<string,number>={'1':0,'2':0};
 if(v.scores!==undefined){
  if(!v.scores||typeof v.scores!=='object'||Array.isArray(v.scores))throw Error('INVALID_RECORD');
  for(const key of ['1','2']){const n=(v.scores as Record<string,unknown>)[key]??0;if(typeof n!=='number'||!Number.isFinite(n))throw Error('INVALID_RECORD');scores[key]=n;}
 }
 return {board,terrain:cells(v.terrain,false),bonus_cells:cells(v.bonus_cells,true),scores};
}
