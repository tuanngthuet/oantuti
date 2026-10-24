import { neon, neonConfig } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable");
}

neonConfig.fetchConnectionCache = true;

const _sql = neon(process.env.DATABASE_URL);
const databaseSchema = process.env.DATABASE_SCHEMA;
if (databaseSchema && !/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error("DATABASE_SCHEMA must be a lowercase SQL identifier");
}

// Detect connection-level errors worth retrying
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message + (err.cause instanceof Error ? err.cause.message : "");
  return (
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("connecting to database")
  );
}

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isConnectionError(err) || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// Wrap sql tagged-template so every call auto-retries on timeout
export const sql = new Proxy(_sql, {
  apply(target, thisArg, args) {
    return retry(async () => {
      const query = Reflect.apply(target, thisArg, args);
      if (!databaseSchema) return await query;
      // Neon HTTP does not preserve session settings between requests. Set the
      // schema inside the same transaction as each query; never fall back to public.
      const results = await _sql.transaction(txn => [
        txn`SELECT set_config('search_path', ${databaseSchema}, true)`, query,
      ]);
      return results[1];
    });
  },
}) as typeof _sql;

// Also export a manual withRetry for cases that need it explicitly
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  return retry(fn, attempts);
}

/**
 * sqlTransaction — chạy nhiều queries trong một Postgres transaction.
 *
 * Dùng _sql.transaction() trực tiếp (không qua retry Proxy) vì:
 * - Neon HTTP transaction không thể retry từng query riêng lẻ
 * - Toàn bộ transaction sẽ được retry ở tầng caller nếu cần
 *
 * Usage:
 *   const [r1, r2] = await sqlTransaction(txn => [
 *     txn`UPDATE ... RETURNING id`,
 *     txn`INSERT INTO ...`,
 *   ]);
 *
 * Nếu bất kỳ query nào throw, toàn bộ transaction ROLLBACK.
 */
export async function sqlTransaction(
  fn: Parameters<typeof _sql.transaction<false, false>>[0],
): Promise<unknown[]> {
  if (!databaseSchema) return _sql.transaction(fn) as Promise<unknown[]>;
  const results = await _sql.transaction(txn => [
    txn`SELECT set_config('search_path', ${databaseSchema}, true)`,
    ...(typeof fn === "function" ? fn(txn) : fn),
  ]);
  return results.slice(1);
}
