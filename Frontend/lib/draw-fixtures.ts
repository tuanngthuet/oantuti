import type { MoveEntry } from './match-callback';
// Legal non-capturing cycle used by callback/engine regression tests.
export function passiveDrawHistory(length=200): MoveEntry[] {
  const cycle=[[1,3,0,3],[7,5,8,5],[0,3,1,3],[8,5,7,5]];
  return Array.from({length},(_,index)=>{
    const [fc,fr,tc,tr]=cycle[index%4];
    return {move_number:index+1,player:index%2+1,from_col:fc,from_row:fr,to_col:tc,to_row:tr,
      from_pos:`${'abcdefghi'[fc]}${fr+1}`,to_pos:`${'abcdefghi'[tc]}${tr+1}`,piece_type:null,captured_type:null};
  });
}
