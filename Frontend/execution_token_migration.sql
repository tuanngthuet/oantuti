-- execution_token_migration.sql
-- Chạy trong Neon SQL Editor để thêm execution token vào rated_matches và friendly_matches.
--
-- execution_token:  UUID cấp cho worker khi callback "started" thành công.
--                   Chỉ worker nắm token này mới được finalize match.
--                   NULL = chưa có worker nào được cấp quyền.
-- execution_worker: delivery_id của worker instance đang giữ quyền chạy.
--                   Dùng để phân biệt khi cùng machine restart và claim lại.

-- ── rated_matches ─────────────────────────────────────────────────────────────
ALTER TABLE rated_matches
  ADD COLUMN IF NOT EXISTS execution_token  TEXT,
  ADD COLUMN IF NOT EXISTS execution_worker TEXT;

-- Index để tìm match bị stuck (có token nhưng chưa finalize)
CREATE INDEX IF NOT EXISTS rated_matches_execution_token_idx
  ON rated_matches(execution_token)
  WHERE execution_token IS NOT NULL AND status = 'running';

-- ── friendly_matches ──────────────────────────────────────────────────────────
ALTER TABLE friendly_matches
  ADD COLUMN IF NOT EXISTS execution_token  TEXT,
  ADD COLUMN IF NOT EXISTS execution_worker TEXT;

CREATE INDEX IF NOT EXISTS friendly_matches_execution_token_idx
  ON friendly_matches(execution_token)
  WHERE execution_token IS NOT NULL AND status = 'running';
