"use client";

export type Piece = { player: number; type: string } | null;

const COLS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

export const PIECE_EMOJI: Record<string, string> = {
  ROCK: "✊",
  PAPER: "✋",
  SCISSORS: "✌️",
};

const PIECE_LABEL: Record<string, string> = {
  ROCK: "ĐẤM",
  PAPER: "LÁ",
  SCISSORS: "KÉO",
};

function PieceToken({ piece, size }: { piece: NonNullable<Piece>; size: number }) {
  const isP1 = piece.player === 1;

  // P1 dùng xanh #253B80 chuẩn global, P2 dùng đỏ đô #b91c1c
  const bg = isP1 ? "#253B80" : "#b91c1c";
  const borderColor = isP1 ? "#1d2e66" : "#991b1b";
  const labelColor = "#ffe066";

  const emojiSize = Math.round(size * 0.42);
  const labelSize = Math.round(size * 0.18);
  const borderPx = Math.max(1, Math.round(size * 0.05));

  return (
    <div
      style={{
        width: size,
        height: size,
        // Khung thẳng (khối quân cờ hình vuông bo cạnh rất nhẹ)
        borderRadius: "2px",
        background: bg,
        border: `${borderPx}px solid ${borderColor}`,
        boxShadow: isP1
          ? "0 2px 4px rgba(37,59,128,0.35)"
          : "0 2px 4px rgba(185,28,28,0.35)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        flexShrink: 0,
      }}
      title={`P${piece.player} ${piece.type}`}
    >
      <span style={{ fontSize: emojiSize, lineHeight: 1, marginTop: 1 }}>
        {PIECE_EMOJI[piece.type]}
      </span>
      <span
        style={{
          fontSize: labelSize,
          lineHeight: 1,
          color: labelColor,
          fontWeight: 700,
          fontFamily: "monospace",
          letterSpacing: "0.02em",
          marginTop: 1,
        }}
      >
        {PIECE_LABEL[piece.type]}
      </span>
    </div>
  );
}

function BoardCell({
  piece,
  col,
  row,
  isLastFrom,
  isLastTo,
  cellSize,
  obstacle=false,
  bonus,
}: {
  piece: Piece;
  col: number;
  row: number;
  isLastFrom: boolean;
  isLastTo: boolean;
  cellSize: number;
  obstacle?: boolean;
  bonus?: number;
}) {
  // Bàn cờ caro màu giấy nhám sáng
  const isLight = (col + row) % 2 === 0;
  let bg = isLight ? "#ffffff" : "#ece7e2";

  // Nước đi trước đó
  if (isLastFrom) bg = "rgba(37, 59, 128, 0.18)";
  if (isLastTo) bg = "rgba(16, 185, 129, 0.22)";

  // Căn cứ i9 (col=8,row=8) và a1 (col=0,row=0)
  const isBase = (col === 8 && row === 8) || (col === 0 && row === 0);
  const isP1base = col === 8 && row === 8;
  const isP2base = col === 0 && row === 0;

  const baseBorderColor = isP1base
    ? "#253B80"
    : isP2base
    ? "#b91c1c"
    : "transparent";

  const pieceSize = Math.round(cellSize * 0.78);

  return (
    <div
      style={{
        width: cellSize,
        height: cellSize,
        background: bg,
        border: isBase
          ? `2px dashed ${baseBorderColor}`
          : "1px solid #ded8d3",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    >
      {obstacle&&<span title="Chướng ngại" style={{position:'absolute',inset:2,background:'#475569',color:'white',display:'grid',placeItems:'center'}}>■</span>}
      {bonus!==undefined&&<span title="Ô cộng điểm" style={{position:'absolute',top:1,left:2,color:'#854d0e',fontSize:11,zIndex:1}}>★{bonus}</span>}
      {/* Icon căn cứ */}
      {isBase && !piece && (
        <span
          style={{
            fontSize: cellSize * 0.22,
            opacity: 0.6,
            color: isP1base ? "#253B80" : "#b91c1c",
            position: "absolute",
            top: 2,
            right: 3,
            fontWeight: "bold",
          }}
        >
          ★
        </span>
      )}
      {/* Nhãn căn cứ */}
      {isBase && !piece && (
        <span
          style={{
            fontSize: cellSize * 0.18,
            color: isP1base ? "#253B80" : "#b91c1c",
            fontFamily: "monospace",
            fontWeight: 700,
            opacity: 0.8,
            position: "absolute",
            bottom: 2,
            left: 3,
          }}
        >
          {isP1base ? "i9" : "a1"}
        </span>
      )}
      {piece && <PieceToken piece={piece} size={pieceSize} />}
    </div>
  );
}

export function GameBoard({
  board,
  lastMove,
  terrain=[],
  bonusCells=[],
}: {
  board: Piece[];
  terrain?: {col:number;row:number}[];
  bonusCells?: {col:number;row:number;points?:number}[];
  lastMove?: { from_col: number; from_row: number; to_col: number; to_row: number } | null;
}) {
  const CELL = 56;
  const totalW = CELL * 9;
  const labelW = 20;

  return (
    <div className="w-full overflow-x-auto" style={{ userSelect: "none" }}>
      <div style={{ display: "inline-block", minWidth: totalW + labelW * 2 }}>
        {/* Nhãn cột trên */}
        <div style={{ display: "flex", marginLeft: labelW }}>
          {COLS.map((c) => (
            <div
              key={c}
              style={{
                width: CELL,
                textAlign: "center",
                fontSize: 11,
                color: "#596172",
                fontFamily: "monospace",
                fontWeight: 700,
                paddingBottom: 3,
              }}
            >
              {c}
            </div>
          ))}
        </div>

        {/* Các hàng bàn cờ — hàng 9 trên, hàng 1 dưới */}
        {Array.from({ length: 9 }, (_, i) => 8 - i).map((row) => (
          <div key={row} style={{ display: "flex", alignItems: "center" }}>
            {/* Nhãn hàng trái */}
            <div
              style={{
                width: labelW,
                textAlign: "right",
                paddingRight: 4,
                fontSize: 11,
                color: "#596172",
                fontFamily: "monospace",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {row + 1}
            </div>

            {/* Các ô cờ */}
            {Array.from({ length: 9 }, (_, col) => {
              const idx = row * 9 + col;
              return (
                <BoardCell
                  key={col}
                  piece={board[idx] ?? null}
                  col={col}
                  row={row}
                  isLastFrom={lastMove?.from_col === col && lastMove?.from_row === row}
                  isLastTo={lastMove?.to_col === col && lastMove?.to_row === row}
                  obstacle={terrain.some(c=>c.col===col&&c.row===row)}
                  bonus={bonusCells.find(c=>c.col===col&&c.row===row)?.points}
                  cellSize={CELL}
                />
              );
            })}

            {/* Nhãn hàng phải */}
            <div
              style={{
                width: labelW,
                textAlign: "left",
                paddingLeft: 4,
                fontSize: 11,
                color: "#596172",
                fontFamily: "monospace",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {row + 1}
            </div>
          </div>
        ))}

        {/* Nhãn cột dưới */}
        <div style={{ display: "flex", marginLeft: labelW }}>
          {COLS.map((c) => (
            <div
              key={c}
              style={{
                width: CELL,
                textAlign: "center",
                fontSize: 11,
                color: "#596172",
                fontFamily: "monospace",
                fontWeight: 700,
                paddingTop: 3,
              }}
            >
              {c}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tái tạo bàn cờ sau mỗi nước đi */
export function applyMove(
  board: Piece[],
  move: { from_col: number; from_row: number; to_col: number; to_row: number }
): Piece[] {
  const next = [...board];
  const fromIdx = move.from_row * 9 + move.from_col;
  const toIdx = move.to_row * 9 + move.to_col;
  next[toIdx] = next[fromIdx];
  next[fromIdx] = null;
  return next;
}

/** Làm phẳng mảng 2D thành 1D */
export function flattenBoard(board2d: Piece[][]): Piece[] {
  const flat: Piece[] = Array(81).fill(null);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      flat[r * 9 + c] = board2d[r]?.[c] ?? null;
  return flat;
}

/** Đếm số lượng quân cờ còn lại */
export function getPieceCounts(board: Piece[]): Record<number, Record<string, number>> {
  const counts: Record<number, Record<string, number>> = {
    1: { ROCK: 0, PAPER: 0, SCISSORS: 0 },
    2: { ROCK: 0, PAPER: 0, SCISSORS: 0 },
  };
  for (const p of board) {
    if (p) counts[p.player][p.type]++;
  }
  return counts;
}
