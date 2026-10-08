import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SOFTWARE_VERSION} from '../lib/version.mjs';
test('package and MCP software versions cannot drift',()=>{
 assert.equal(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,SOFTWARE_VERSION);
 assert.match(readFileSync(new URL('../lib/mcp-handler.mjs',import.meta.url),'utf8'),/serverInfo:\{name:'youtube-transcripts',version:SOFTWARE_VERSION\}/);
});
