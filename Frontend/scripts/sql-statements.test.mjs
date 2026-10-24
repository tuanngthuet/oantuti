import { test } from 'vitest';
import assert from 'node:assert/strict';
import { splitSql } from './sql-statements.mjs';
test('preserves dollar bodies, comments and quoted semicolons', () => {
  const statements = splitSql(`-- comment;\nSELECT 'it''s; fine'; /* outer; /* nested; */ */
    CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RETURN 'ok;'; END; $body$;
    SELECT "column;name"; -- trailing;`);
  assert.equal(statements.length, 3);
  assert.ok(statements[1].includes("RETURN 'ok;'; END;"));
  assert.equal(splitSql('/* nothing; */ -- nothing;').length, 0);
  assert.throws(() => splitSql('SELECT $$missing;'), /Unterminated/);
});
