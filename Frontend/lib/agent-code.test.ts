import {expect,it} from 'vitest';
import {agentCodeIdentity,normalizeAgentCode} from './agent-code';
it('normalizes line endings, outer blank lines and safe trailing spaces',()=>{
 expect(normalizeAgentCode('\r\ndef agent():  \r\n    return 1\t\r\n\r\n')).toBe('def agent():\n    return 1');
});
it('preserves indentation, comments and actual string contents',()=>{
 const a='def agent():\n    s = """hello  \nworld  \n"""\n    return s';
 expect(normalizeAgentCode(a)).toBe(a);
 expect(agentCodeIdentity(a).fingerprint).not.toBe(agentCodeIdentity(a.replace('world  ','world ')).fingerprint);
 expect(agentCodeIdentity('def agent():\n    return 1').fingerprint).not.toBe(agentCodeIdentity('def agent():\n  return 1').fingerprint);
 expect(agentCodeIdentity('# a\ndef agent(): return 1').fingerprint).not.toBe(agentCodeIdentity('# b\ndef agent(): return 1').fingerprint);
});
it('does not trim ambiguous/unterminated Python strings',()=>{
 const code='def agent():\n    s = """hello  \nworld  ';
 expect(normalizeAgentCode(code)).toBe(code);
});
