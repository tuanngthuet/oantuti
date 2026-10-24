import { createHash } from 'node:crypto';
import { pythonLanguage } from '@codemirror/lang-python';

/** Keep indentation, comments and string contents; never normalize ambiguous syntax. */
export function normalizeAgentCode(code: string): string {
  const source=code.replace(/\r\n?/g,'\n');
  const strings:{from:number;to:number}[]=[];
  let invalid=false;
  pythonLanguage.parser.parse(source).iterate({enter(node){
    if(node.type.isError)invalid=true;
    if(node.name==='String'||node.name==='FormatString'){strings.push({from:node.from,to:node.to});return false;}
  }});
  if(invalid)return source;
  let offset=0;
  const lines=source.split('\n').map(line=>{
    const clean=line.replace(/[ \t]+$/,'');
    const start=offset+clean.length,end=offset+line.length;
    const protectedSpace=strings.some(s=>s.from<end&&s.to>start);
    offset+=line.length+1;
    return protectedSpace?line:clean;
  });
  while(lines.length&&lines[0]==='')lines.shift();
  while(lines.length&&lines[lines.length-1]==='')lines.pop();
  return lines.join('\n');
}
export function agentCodeIdentity(code:string){
  const normalized=normalizeAgentCode(code);
  return {normalized,fingerprint:createHash('sha256').update(normalized,'utf8').digest('hex')};
}
