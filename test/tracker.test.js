import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const source=readFileSync(new URL('../public/tracker.js',import.meta.url),'utf8');
function tracker(gpc=false){
  const calls=[],storage=new Map(),window={};
  const location={href:'https://store.example/products?email=private@example.com&utm_source=launch&signal_click=signed-token#private',origin:'https://store.example',pathname:'/products'};
  vm.runInNewContext(source,{window,URL,location,navigator:{globalPrivacyControl:gpc},document:{currentScript:{src:'https://collector.example/tracker.js',dataset:{site:'pk_test'}}},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},crypto:{randomUUID},fetch:(url,options)=>{calls.push({url,options});return Promise.resolve({});}});
  return {api:window.Signal,calls,storage};
}
test('tracker remains idle and creates no identifier before permission',()=>{
  const t=tracker();t.api.track();assert.equal(t.api.getSubjectId(),null);assert.equal(t.calls.length,0);assert.equal(t.storage.size,0);
  t.api.consent({collection:false});assert.equal(t.calls.length,0);
});
test('tracker strips URL query/fragment, passes signed attribution separately, and revokes cleanly',()=>{
  const t=tracker();t.api.consent({collection:true,noticeVersion:'v1'});assert.equal(t.calls.length,1);assert.equal(t.storage.size,1);
  const body=JSON.parse(t.calls[0].options.body);assert.equal(body.url,'https://store.example/products');assert.equal(body.attribution,'signed-token');assert.equal(body.source,'launch');assert.ok(!JSON.stringify(body).includes('private@example.com'));assert.equal(body.subjectId,t.api.getSubjectId());
  t.api.revoke();assert.equal(t.storage.size,0);assert.equal(t.api.getSubjectId(),null);t.api.track();assert.equal(t.calls.length,1);
});
test('Global Privacy Control prevents both collection and subject creation',()=>{
  const t=tracker(true);t.api.consent({collection:true,noticeVersion:'v1'});assert.equal(t.calls.length,0);assert.equal(t.storage.size,0);assert.equal(t.api.getSubjectId(),null);
});
