// Teams collapses line breaks in plain messages. Extended Markdown retains
// paragraphs; escaped punctuation keeps commands and quoted reports literal.
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages
export function teamsMessage(text) {
  const escaped=Array.from(text,character=>{
    const code=character.codePointAt(0);
    const punctuation=code>=33&&code<=47||code>=58&&code<=64||code>=91&&code<=96||code>=123&&code<=126;
    return punctuation?'\\'+character:character;
  }).join('').replace(/\r\n?/g,'\n').replace(/\n/g,'  \n');
  const message={type:'message',text:escaped,textFormat:'extendedmarkdown'};
  // Reserve space for SDK metadata below Microsoft's 80 KB guidance. Escaping
  // very repetitive text can expand its encoded size; retain its original
  // literal text in that case, without truncating the message.
  return Buffer.byteLength(JSON.stringify(message),'utf16le')<=64*1024?message:{type:'message',text,textFormat:'plain'};
}
