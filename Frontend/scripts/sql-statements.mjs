// Split migrations without splitting quoted strings or PostgreSQL function bodies.
export function splitSql(source) {
  const statements = [];
  let start = 0, quote = '', dollar = '', line = false, block = 0, hasSql = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) {
      if (c === '/' && next === '*') { block++; i++; }
      else if (c === '*' && next === '/') { block--; i++; }
      continue;
    }
    if (dollar) { if (source.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ''; } continue; }
    if (quote) { if (c === quote) { if (next === quote) i++; else quote = ''; } continue; }
    if (c === '-' && next === '-') { line = true; i++; continue; }
    if (c === '/' && next === '*') { block = 1; i++; continue; }
    if (c === ';') {
      if (hasSql) statements.push(source.slice(start, i).trim());
      start = i + 1; hasSql = false; continue;
    }
    if (!/\s/.test(c)) hasSql = true;
    if (c === "'" || c === '"') quote = c;
    else if (c === '$') {
      const match = source.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/);
      if (match) { dollar = match[0]; i += dollar.length - 1; }
    }
  }
  if (quote || dollar || block) throw new Error('Unterminated SQL literal or comment');
  if (hasSql) statements.push(source.slice(start).trim());
  return statements;
}
