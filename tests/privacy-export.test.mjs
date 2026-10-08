import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSourceIssues} from '../scripts/public-source-policy.mjs';
test('privacy policy accepts reserved examples and retains mandatory licence attribution',()=>{
 assert.deepEqual(publicSourceIssues('owner@example.com dev@fixture.test https://your-site.example.com'),[]);
 assert.deepEqual(publicSourceIssues('Maintainer <'+['author','upstream.org'].join('@')+'>','vendor/LICENSE'),[]);
});
test('privacy policy rejects private emails, deployment hosts, IDs, paths and personal repository templates',()=>{
 const privateValues=[['person','operator.org'].join('@'),'https://private.'+'operator.chatgpt.site','appgprj_'+ 'a'.repeat(32),['','Users','private','source',''].join('/'),['https:','','github.com','operator','chatgpt-web-ui-network-access'].join('/')];
 for(const value of privateValues)assert.ok(publicSourceIssues(value).length);
});
