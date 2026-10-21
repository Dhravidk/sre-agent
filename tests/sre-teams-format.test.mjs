import test from 'node:test';
import assert from 'node:assert/strict';
import {teamsMessage} from '../src/sre/teams-format.mjs';

test('Teams formatting keeps command placeholders, mentions and quoted markup literal',()=>{
  const message=teamsMessage('join <incident-id>\nQuoted: <at>owner</at> ![image](https://example.test/x) **approved** _done_ `deploy`');
  assert.equal(message.textFormat,'extendedmarkdown');
  assert.ok(message.text.includes('join \\<incident\\-id\\>'));
  assert.ok(message.text.includes('\\<at\\>owner\\<\\/at\\>'));
  assert.ok(message.text.includes('\\!\\[image\\]\\(https\\:\\/\\/example\\.test\\/x\\)'));
  assert.ok(!message.text.includes('**approved**'));
  assert.ok(!message.text.includes('<at>'));
});

test('Teams formatting preserves multilingual text and explicit paragraph and line breaks',()=>{
  const message=teamsMessage('EU responders\r\n\r\n東京 — 解析中\nOwner: Priya');
  assert.equal(message.textFormat,'extendedmarkdown');
  assert.ok(message.text.includes('EU responders  \n  \n東京 — 解析中  \nOwner\\: Priya'));
  assert.ok(!message.text.includes('\r'));
});

test('format expansion falls back to complete literal text within the native envelope budget',()=>{
  for(const text of ['<'.repeat(13000),'\n'.repeat(13000),'漢'.repeat(4000)]) {
    const message=teamsMessage(text);
    assert.ok(Buffer.byteLength(JSON.stringify(message),'utf16le')<=64*1024);
    if(message.textFormat==='plain')assert.equal(message.text,text);
  }
  assert.equal(teamsMessage('<'.repeat(13000)).textFormat,'plain');
});
