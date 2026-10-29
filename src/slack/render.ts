/** Markdown → Slack mrkdwn at the delivery boundary. No HTML, lookup or mention synthesis. */
export const SLACK_REPLY_MAX_BYTES = 16_000;
export const SLACK_REPLY_MAX_PARTS = 5;
export const SLACK_REPLY_TRUNCATED = '\n\n[Reply shortened for Slack. Ask for the remaining detail.]';
type Part = { text:string; kind:'text'|'atomic'|'code' };
const bytes = (text:string) => Buffer.byteLength(text, 'utf8');
// Preserve only Slack's three text entities; never turn escaped markup into an active mention.
const escape = (text:string) => text.replace(/&(?!amp;|lt;|gt;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const part = (text:string, kind:Part['kind']='text'):Part => ({text,kind});
const slackEntity = /^<(?:@[UW][A-Z0-9]+(?:\|[^<>\n]+)?|#[CG][A-Z0-9]+(?:\|[^<>\n]+)?|https?:\/\/[^<>\s|]+(?:\|[^<>\n]+)?|mailto:[^<>\s|]+(?:\|[^<>\n]+)?)>$/;

function linkEnd(text:string,start:number):number {
  let depth=1;
  for(let i=start;i<text.length;i++) {
    if(/\s/.test(text[i]!))return -1;
    if(text[i]==='\\'&&/[()\\]/.test(text[i+1]??'')){i++;continue;}
    if(text[i]==='(')depth++;
    else if(text[i]===')'&&--depth===0)return i;
  }
  return -1;
}

function inline(text:string,heading=false):Part[] {
  const result:Part[] = [], emphasis = new Map<string,number>();
  // Protect code, existing Slack entities and URLs before changing emphasis. In particular,
  // asterisks/underscores in URL paths and code are not formatting instructions.
  const tokens = /(`+)([^`\n]*?)\1|<[^>\n]+>|\[([^\]\n]+)\]\((https?:\/\/)|https?:\/\/[^\s<>]+|\*\*|__|~~/g;
  let cursor=0;
  for(let match; (match=tokens.exec(text))!==null;) {
    let value=match[0];const index=match.index;
    if(index>cursor)result.push(part(escape(text.slice(cursor,index))));
    if(match[1])result.push(part('`'+escape(match[2]!)+'`','atomic'));
    else if(match[3]!==undefined) {
      // Only http(s) links are converted. Labels are plain text, never Slack entity syntax.
      const start=index+value.length-match[4]!.length,end=linkEnd(text,start);
      if(end<0)result.push(part(escape(value)));
      else {
        const label=escape(match[3]).replace(/\|/g,'¦');
        const destination=text.slice(start,end).replace(/\\([()\\])/g,'$1');
        result.push(part('<'+escape(destination).replace(/\|/g,'%7C')+'|'+label+'>','atomic'));
        value=text.slice(index,end+1);tokens.lastIndex=end+1;
      }
    } else if(value.startsWith('<'))result.push(part(slackEntity.test(value)?value:escape(value),'atomic'));
    else if(value.startsWith('http'))result.push(part(escape(value),'atomic'));
    else {
      const prior=emphasis.get(value);
      if(prior===undefined) {emphasis.set(value,result.length);result.push(part(value));}
      else {const marker=value==='~~'?'~':heading?'':'*';result[prior]!.text=marker;result.push(part(marker));emphasis.delete(value);}
    }
    cursor=index+value.length;
  }
  if(cursor<text.length)result.push(part(escape(text.slice(cursor))));
  return result;
}

/** Split table cells without interpreting a pipe inside code, a Slack link or an escaped pipe. */
function cells(line:string):string[] {
  const result:string[]=[];let cell='',i=0,delimiters=0;
  while(i<line.length) {
    if(line[i]==='\\'&&line[i+1]==='|'){cell+='|';i+=2;continue;}
    if(line[i]==='`') {
      const marker=line.slice(i).match(/^`+/)![0], end=line.indexOf(marker,i+marker.length);
      if(end>=0){cell+=line.slice(i,end+marker.length);i=end+marker.length;continue;}
    }
    if(line[i]==='<') {
      const end=line.indexOf('>',i+1);
      if(end>=0){cell+=line.slice(i,end+1);i=end+1;continue;}
    }
    if(line[i]==='|'){result.push(cell.trim());cell='';delimiters++;}else cell+=line[i];
    i++;
  }
  result.push(cell.trim());
  if(line.trimStart().startsWith('|'))result.shift();
  if(line.trimEnd().endsWith('|')&&!line.trimEnd().endsWith('\\|'))result.pop();
  return delimiters?result:[];
}

function markdown(text:string):Part[] {
  const lines=text.replace(/\r\n?/g,'\n').split('\n'), result:Part[]=[];
  const appendLine=(parts:Part[])=>{if(result.length)result.push(part('\n'));result.push(...parts);};
  for(let i=0;i<lines.length;i++) {
    const line=lines[i]!, fence=line.match(/^ {0,3}(`{3,}|~{3,})[^`]*$/);
    if(fence) {
      const marker=fence[1]!,body:string[]=[];
      for(i++;i<lines.length;i++) {
        const close=lines[i]!.trim();
        if(close.length>=marker.length&&[...close].every(c=>c===marker[0]))break;
        body.push(lines[i]!);
      }
      // Slack has no language tag; keep the code, and close even a model's unfinished fence.
      appendLine([part('```\n'+escape(body.join('\n')).replace(/```/g,'``\u200b`')+'\n```','code')]);
      continue;
    }
    const header=cells(line),separator=cells(lines[i+1]??'');
    if(header.length>=2&&separator.length===header.length&&separator.every(cell=>/^:?-{3,}:?$/.test(cell))) {
      let rows=0;i++;
      while(i+1<lines.length) {
        const row=cells(lines[i+1]!);if(row.length!==header.length)break;
        const rendered:Part[]=[part('• ')];
        row.forEach((value,column)=>{if(column)rendered.push(part(' · '));rendered.push(...inline(header[column]!),part(': '),...inline(value));});
        appendLine(rendered);rows++;i++;
      }
      if(!rows)appendLine(inline(header.join(' · ')));
      continue;
    }
    const heading=line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if(heading) {
      // One bold span is enough for the whole heading, including already-formatted titles.
      let title=heading[1]!,outer:RegExpMatchArray|null;
      while((outer=title.match(/^(\*\*|__|\*|_)(.+)\1$/))!==null)title=outer[2]!;
      appendLine([part('*'),...inline(title,true),part('*')]);
    }
    else appendLine(inline(line));
  }
  return result;
}

function prefix(text:string,limit:number):string {
  let result='',used=0;
  // Entity and Unicode scalar boundaries matter after escaping has expanded the text.
  for(const match of text.matchAll(/&(?:amp|lt|gt);|[\s\S]/gu)) {
    const size=bytes(match[0]);if(used+size>limit)break;result+=match[0];used+=size;
  }
  return result;
}

export function renderSlackReply(text:string):string {
  // Replace malformed UTF-16 rather than persisting a hash for bytes Slack cannot represent.
  const parts=markdown(text.toWellFormed()),rendered=parts.map(p=>p.text).join('');
  if(bytes(rendered)<=SLACK_REPLY_MAX_BYTES)return rendered;
  let result='',remaining=SLACK_REPLY_MAX_BYTES-bytes(SLACK_REPLY_TRUNCATED);
  for(const item of parts) {
    const size=bytes(item.text);
    if(size<=remaining){result+=item.text;remaining-=size;continue;}
    if(item.kind==='text')result+=prefix(item.text,remaining);
    else if(item.kind==='code'&&remaining>=8)result+='```\n'+prefix(item.text.slice(4,-4),remaining-8)+'\n```';
    // Links, mentions and inline code are atomic; never emit half of a Slack control sequence.
    break;
  }
  return result.trimEnd()+SLACK_REPLY_TRUNCATED;
}

/** Complete conversation answers, bounded to five messages. No silent truncation of saved history. */
export function renderSlackReplyParts(text:string):string[] {
  const output:string[]=[];let current='';
  const flush=()=>{if(current){output.push(current);current='';if(output.length>SLACK_REPLY_MAX_PARTS)throw new Error('slack_reply_parts_limit');}};
  const appendText=(value:string)=>{
    while(value){
      let fit=prefix(value,SLACK_REPLY_MAX_BYTES-bytes(current));
      if(!fit){flush();continue;}
      // Prefer a line/word boundary when that does not waste most of a message.
      if(fit.length<value.length){const boundary=Math.max(fit.lastIndexOf('\n'),fit.lastIndexOf(' '));if(boundary>fit.length/2)fit=fit.slice(0,boundary+1);}
      current+=fit;value=value.slice(fit.length);if(value)flush();
    }
  };
  for(const raw of markdown(text.toWellFormed())){
    const item=raw.kind==='atomic'&&bytes(raw.text)>SLACK_REPLY_MAX_BYTES&&raw.text.startsWith('`')&&raw.text.endsWith('`')
      ?part('```\n'+raw.text.slice(1,-1)+'\n```','code'):raw;
    if(bytes(item.text)<=SLACK_REPLY_MAX_BYTES-bytes(current)){current+=item.text;continue;}
    if(item.kind==='code'){
      // Close and reopen fences in each message; never split a Unicode scalar or an escaped entity.
      let body=item.text.slice(4,-4);
      if(!body){flush();current=item.text;continue;}
      while(body){
        if(SLACK_REPLY_MAX_BYTES-bytes(current)<16)flush();
        const fit=prefix(body,SLACK_REPLY_MAX_BYTES-bytes(current)-8);
        current+='```\n'+fit+'\n```';body=body.slice(fit.length);if(body)flush();
      }
    }else if(item.kind==='atomic'&&bytes(item.text)<=SLACK_REPLY_MAX_BYTES){flush();current=item.text;}
    else {
      // Oversized links/inline code cannot stay atomic: render their literal escaped syntax.
      appendText(item.kind==='atomic'?escape(item.text):item.text);
    }
  }
  flush();if(!output.length)throw new Error('slack_reply_empty');return output;
}
