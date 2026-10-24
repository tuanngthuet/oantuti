import type { MoveEntry } from './match-callback';

type Piece = { player: number; type: string };
export const DRAW_MOVE_LIMIT = 200;
export const DRAW_PENALTY = { minimum: 4, materialWeight: 16, distanceWeight: 12, maximum: 32 } as const;
const beats: Record<string, string> = { ROCK: 'SCISSORS', SCISSORS: 'PAPER', PAPER: 'ROCK' };

export function initialRatingBoard(): (Piece | null)[] {
  const board: (Piece | null)[] = Array(81).fill(null);
  function place(player: number, type: string, positions: string[]) {
    for (const pos of positions) board[(Number(pos[1])-1)*9+pos.charCodeAt(0)-97] = {player,type};
  }
  place(1,'SCISSORS',['c5','d4','e3']); place(1,'PAPER',['b5','c4','d3','e2']); place(1,'ROCK',['b4','c3','d2']);
  place(2,'SCISSORS',['e7','f6','g5']); place(2,'PAPER',['e8','f7','g6','h5']); place(2,'ROCK',['f8','g7','h6']);
  return board;
}

export function boardDrawPenalties(board: (Piece | null)[]) {
  if (board.length !== 81) throw new Error('Invalid board');
  const counts = [0,0,0], distances = [0,0,0];
  board.forEach((piece,index) => {
    if (!piece) return;
    const goal = piece.player === 1 ? 8 : 0;
    counts[piece.player]++;
    // King-like movement: Chebyshev distance gives minimum moves to the enemy base.
    distances[piece.player] += Math.max(Math.abs(index%9-goal),Math.abs(Math.floor(index/9)-goal));
  });
  if (!counts[1] || !counts[2] || counts[1]>10 || counts[2]>10) throw new Error('Invalid drawn position');
  function player(one: number, other: number) {
    const averageDistance = distances[one]/counts[one];
    const penalty = Math.round(DRAW_PENALTY.minimum + DRAW_PENALTY.materialWeight*counts[other]/10
      + DRAW_PENALTY.distanceWeight*averageDistance/8);
    return { penalty, ownPieces:counts[one], opponentPieces:counts[other], averageDistance };
  }
  return { agent1:player(1,2), agent2:player(2,1) };
}

// Derive the final board from a complete legal replay, never trust worker-provided
// penalties/counts. Both executor types use this identical server-side policy.
export function evaluateDraw(moves: MoveEntry[]) {
  if (moves.length !== DRAW_MOVE_LIMIT) throw new Error('A rated draw requires a complete 200-ply replay; upgrade the worker');
  const board = initialRatingBoard();
  const ordered = [...moves].sort((a,b) => a.move_number-b.move_number);
  for (const [index,move] of ordered.entries()) {
    if (move.move_number !== index+1 || move.player !== index%2+1) throw new Error('Invalid draw replay sequence');
    if ([move.from_col,move.from_row,move.to_col,move.to_row].some(v => !Number.isInteger(v) || v<0 || v>8)) throw new Error('Invalid draw coordinates');
    const from = move.from_row*9+move.from_col, to = move.to_row*9+move.to_col;
    const piece = board[from], captured = board[to];
    if (!piece || piece.player!==move.player || from===to
        || Math.max(Math.abs(move.from_col-move.to_col),Math.abs(move.from_row-move.to_row))!==1
        || (captured && (captured.player===piece.player || beats[piece.type]!==captured.type))
        || (move.piece_type!=null && move.piece_type!==piece.type)
        || (move.captured_type??null)!==(captured?.type??null)) throw new Error('Illegal move in draw replay');
    board[to] = piece; board[from] = null;
    const goal = piece.player===1 ? 80 : 0;
    if (to===goal || [1,2].some(p => ['ROCK','PAPER','SCISSORS'].some(t => !board.some(x => x?.player===p && x.type===t)))) {
      throw new Error('Draw replay contains a winning position');
    }
  }
  return boardDrawPenalties(board);
}
