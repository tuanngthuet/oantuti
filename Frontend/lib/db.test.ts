import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { transport, tag } = vi.hoisted(() => {
  const transport = { queries: [] as unknown[], results: [] as unknown[] };
  const tag = Object.assign(vi.fn(() => Promise.resolve([{ id: 1 }])), {
    transaction: vi.fn(async (fn: (query: (strings: TemplateStringsArray, ...values: unknown[]) => unknown) => unknown[]) => {
      transport.queries = fn((strings, ...values) => ({ text: strings.join("?"), values }));
      return transport.results;
    }),
  });
  return { transport, tag };
});
vi.mock("@neondatabase/serverless", () => ({ neon: () => tag, neonConfig: {} }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  vi.stubEnv("DATABASE_SCHEMA", "ott_e2e_test");
});
afterEach(() => vi.unstubAllEnvs());

it("sets search_path in the same transaction as each tagged query", async () => {
  transport.results = [[{ set_config: "ott_e2e_test" }], [{ id: 7 }]];
  const { sql } = await import("./db");
  expect(await sql`SELECT id FROM users`).toEqual([{ id: 7 }]);
  expect(transport.queries).toHaveLength(2);
  expect(transport.queries[0]).toEqual({ text: "SELECT set_config('search_path', ?, true)", values: ["ott_e2e_test"] });
});

it("keeps transaction result positions unchanged for callback callers", async () => {
  transport.results = [[{ set_config: "ott_e2e_test" }], [{ id: 7 }], [{ id: 8 }]];
  const { sqlTransaction } = await import("./db");
  expect(await sqlTransaction(txn => [txn`SELECT 7`, txn`SELECT 8`])).toEqual([[{ id: 7 }], [{ id: 8 }]]);
  expect(transport.queries).toHaveLength(3);
});

it("rejects unsafe schema configuration before executing queries", async () => {
  vi.stubEnv("DATABASE_SCHEMA", "public,other");
  await expect(import("./db")).rejects.toThrow("DATABASE_SCHEMA");
  expect(tag).not.toHaveBeenCalled();
});

it("preserves the default database path when no schema override is configured", async () => {
  vi.stubEnv("DATABASE_SCHEMA", "");
  const { sql } = await import("./db");
  expect(await sql`SELECT id FROM users`).toEqual([{ id: 1 }]);
  expect(tag.transaction).not.toHaveBeenCalled();
});
