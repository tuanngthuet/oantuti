import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { seedUsers, seedAgents } from './test-seed-fixtures.mjs';
test('produces exactly ten users, one admin, two distinct agents per user', () => {
  const users = seedUsers(Array.from({ length: 10 }, () => 'test-hash'));
  const agents = seedAgents(users);
  expect(users).toHaveLength(10); expect(users.filter(u => u.is_admin)).toHaveLength(1);
  expect(agents).toHaveLength(20); expect(new Set(agents.map(a => a.code)).size).toBe(20);
  for (const user of users) expect(agents.filter(a => a.username === user.username).map(a => a.version)).toEqual([1, 2]);
  const result = spawnSync('python3', ['-B', '-c', `import sys,json
for code in json.loads(sys.argv[1]):
 scope={};exec(compile(code,'test-agent','exec'),scope)
 for player in [1,2]:
  moves=[dict(from_col=1,from_row=2,to_col=2,to_row=3,is_capture=False),dict(from_col=3,from_row=4,to_col=4,to_row=5,is_capture=True)]
  assert scope['agent']({'valid_moves':moves,'current_player':player},{}) in moves
 assert scope['agent']({'valid_moves':[],'current_player':1},{}) is None
print('PASS all 20 agents select a legal move')`, JSON.stringify(agents.map(a => a.code))], { encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
});
