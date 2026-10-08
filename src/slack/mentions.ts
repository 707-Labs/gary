/** Slack user IDs grant the mention trigger; display labels never grant identity. */
export function classifySlackUserMentions(text:string,userId:string):{canonical:boolean;labeled:boolean} {
  const found={canonical:false,labeled:false};
  if(!/^[UW][A-Z0-9]{5,32}$/.test(userId))return found;
  for(let start=text.indexOf('<');start!==-1;){
    const end=text.indexOf('>',start+1);if(end===-1)return found;
    // Consume each whole angle construct, so a nested/spoofed token cannot match inside it.
    const token=text.slice(start+1,end);
    const match=/^@([UW][A-Z0-9]{5,32})(?:\|([^<>|\x00-\x1f\x7f]{1,80}))?$/.exec(token);
    if(match?.[1]===userId){
      if(match[2]===undefined)found.canonical=true;
      else if(match[2].trim().length>0)found.labeled=true;
    }
    start=text.indexOf('<',end+1);
  }
  return found;
}
export function hasSlackUserMention(text:string,userId:string):boolean {
  const found=classifySlackUserMentions(text,userId);return found.canonical||found.labeled;
}
