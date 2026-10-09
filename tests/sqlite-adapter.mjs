import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
// Real local SQLite with a D1-shaped adapter, not Cloudflare D1 deployment evidence.
export function localDb() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema-fixture.sql',import.meta.url),'utf8'));
  function prepare(sql,args=[]) {
    return {bind(...next){return prepare(sql,next);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},sql,args};
  }
  return {prepare,sqlite,setClock(now){sqlite.function('julianday',{varargs:true},()=>now()/86400000+2440587.5);},async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push({meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}});sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
