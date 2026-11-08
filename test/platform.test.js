import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { locationMatches } from '../server/geo.js';
import { validateGeofence, resolveIdentity } from '../server/providers.js';

const token='local-demo-only';
async function setup(t,options={}){
  const dir=await mkdtemp(path.join(tmpdir(),'signal-test-'));
  const app=createApp({dataDir:dir,worker:false,...options});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(route,method='GET',data,headers={},auth=token)=>{
    const response=await fetch(base+route,{method,redirect:'manual',headers:{...(auth?{Authorization:`Bearer ${auth}`} :{}),...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
    const type=response.headers.get('content-type')||'';
    return {status:response.status,data:type.includes('application/json')?await response.json():await response.text(),headers:response.headers};
  };
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,base,call};
}
const adInput={name:'Local campaign',headline:'Meet your next favorite.',description:'Your neighborhood, connected.',landingUrl:'https://store.example.com/offers',color:'#1b5c49',cpm:5,totalBudget:1,dailyBudget:1};
async function campaign(ctx,input={}){const created=await ctx.call('/api/ads/campaigns','POST',{...adInput,...input});assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;assert.equal((await ctx.call('/api/ads/campaigns/'+id,'PATCH',{status:'active'})).status,200);return id;}
async function site(ctx){const result=await ctx.call('/api/sites','POST',{name:'Store',origin:'https://store.example.com'});assert.equal(result.status,201);return result.data;}
const event=(s,subject=randomUUID())=>({subjectId:subject,eventId:randomUUID(),url:s.origin+'/products?email=must-not-be-stored',source:'direct',consent:{collection:true,noticeVersion:'v1'}});
async function collect(ctx,s,input,headers={}){return ctx.call('/collect?site='+s.public_key,'POST',input,{Origin:s.origin,...headers},null);}
const person={id:'licensed-record-123',name:'Test Person',email:'person@example.com',phone:'+12025550120',city:'Austin, TX',scope:'person',confidence:.97,evidence:'Test provider evidence',provider:'Test adapter'};
const providers={resolveIdentity:async()=>({...person}),validateContact:async()=>({email:'valid',phone:'valid',provider:'Test validator'})};

test('dashboard requires authentication; login creates HttpOnly session',async t=>{
  const c=await setup(t);
  assert.equal((await c.call('/api/state','GET',null,{},null)).status,401);
  assert.equal((await c.call('/api/login','POST',{token:'wrong'},{},null)).status,401);
  const r=await c.call('/api/login','POST',{token},{},null);
  assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await c.call('/api/state','GET',null,{Cookie:r.headers.get('set-cookie').split(';')[0]},null)).status,200);
  assert.equal((await c.call('/api/demo','POST',{}, {Origin:'https://attacker.example'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const request=http.request(c.base+'/health',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(hostStatus,403);
});
test('six demo visits complete with two simulated offers, household hold, opt-out, and no-match',async t=>{
  const c=await setup(t);const r=await c.call('/api/demo','POST',{});assert.equal(r.status,202,JSON.stringify(r.data));
  for(let i=0;i<6;i++)await c.app.processJob();
  const s=(await c.call('/api/state')).data;
  assert.equal(s.visitors.length,6);assert.equal(s.offers.filter(o=>o.status==='simulated_sent').length,2);
  assert.equal(s.visitors.filter(v=>v.status==='suppressed').length,1);assert.equal(s.visitors.filter(v=>v.status==='unmatched').length,1);
  assert.equal(s.offers.filter(o=>o.status==='blocked').length,2);
  assert.equal(c.app.db.prepare('SELECT count(*) n FROM jobs WHERE payload IS NOT NULL').get().n,0);
  assert.ok(s.visitors.every(v=>!('subject_key' in v)));
});
test('collector rejects missing permission, GPC, mismatched origins, and deduplicates events',async t=>{
  const c=await setup(t),s=await site(c),input=event(s);
  assert.equal((await collect(c,s,{...input,consent:{collection:false}})).data.accepted,false);
  assert.equal((await collect(c,s,input,{'Sec-GPC':'1'})).data.accepted,false);
  assert.equal((await collect(c,s,input,{Origin:'https://wrong.example'})).status,403);
  assert.equal((await collect(c,s,input)).status,202);
  assert.equal((await collect(c,s,input)).data.duplicate,true);
  const stored=c.app.db.prepare('SELECT * FROM events').get();assert.equal(stored.page,'/products');assert.equal(stored.campaign_id,null);
  const payload=c.app.db.prepare('SELECT payload FROM jobs').get().payload;assert.ok(!payload.includes('127.0.0.1'));assert.ok(!payload.includes(input.subjectId));
  await c.app.processJob();assert.equal((await c.call('/api/state')).data.visitors[0].status,'unmatched');
});
test('workspaces cannot read, suppress, or target one another’s records',async t=>{
  const c=await setup(t),s=await site(c),f=await c.call('/api/geofences','POST',{name:'Store',provider:'native',category:'retail',shape:'radius',lat:30,lng:-97,radiusKm:1,dailyBudget:20});
  const accepted=await collect(c,s,event(s));
  const w=(await c.call('/api/workspaces','POST',{name:'Other client'})).data;
  const other=(route,method='GET',data)=>c.call(route,method,data,{},w.token);
  assert.equal((await other('/api/state')).data.sites.length,0);
  assert.equal((await other('/api/visitors/'+accepted.data.visitorId)).status,404);
  assert.equal((await other('/api/visitors/'+accepted.data.visitorId+'/suppress','POST',{})).status,404);
  assert.equal((await other('/api/geofences/'+f.data.id+'/export')).status,404);
  assert.equal((await other('/api/ads/campaigns','POST',{...adInput,geofenceId:f.data.id})).status,400);
  assert.equal((await other('/api/workspaces','POST',{name:'Unauthorized provisioning'})).status,403);
});
test('contact match stays held without permission and becomes ready after bound consent',async t=>{
  const c=await setup(t,{providers}),s=await site(c),input=event(s);await collect(c,s,input);await c.app.processJob();
  let state=(await c.call('/api/state')).data;assert.equal(state.offers[0].status,'blocked');assert.match(state.offers[0].reason,/consent receipt/);
  const receipt=(await c.call('/api/consent','POST',{siteId:s.id,subjectId:input.subjectId,email:person.email,emailMarketing:true,noticeVersion:'v1',source:'First-party signup form'})).data.receipt;
  await collect(c,s,{...input,eventId:randomUUID(),consent:{...input.consent,emailReceipt:receipt}});await c.app.processJob();
  state=(await c.call('/api/state')).data;assert.equal(state.offers.length,1);assert.equal(state.offers[0].status,'ready');
  assert.equal((await c.call('/api/offers/'+state.offers[0].id+'/deliver','POST',{})).status,409);
  await c.call('/api/visitors/'+state.visitors[0].id+'/suppress','POST',{});
  assert.equal((await c.call('/api/offers/'+state.offers[0].id+'/deliver','POST',{})).status,409);
  assert.equal((await collect(c,s,{...input,eventId:randomUUID()})).data.accepted,false);
});
test('wrong-contact consent and household identity never qualify for offers',async t=>{
  const c=await setup(t,{providers:{...providers,resolveIdentity:async()=>({...person,scope:'household'})}}),s=await site(c),input=event(s);
  const receipt=(await c.call('/api/consent','POST',{siteId:s.id,subjectId:input.subjectId,email:'different@example.com',emailMarketing:true,noticeVersion:'v1',source:'Signup'})).data.receipt;
  await collect(c,s,{...input,consent:{...input.consent,emailReceipt:receipt}});await c.app.processJob();
  const o=(await c.call('/api/state')).data.offers[0];assert.equal(o.status,'blocked');assert.match(o.reason,/household/);assert.match(o.reason,/consent receipt/);
});
test('erasure removes records and prevents later re-append',async t=>{
  const c=await setup(t,{providers}),s=await site(c),input=event(s);const result=await collect(c,s,input);await c.app.processJob();
  assert.equal((await c.call('/api/visitors/'+result.data.visitorId,'DELETE',{})).status,200);
  assert.equal((await c.call('/api/state')).data.visitors.length,0);
  assert.equal(c.app.db.prepare('SELECT count(*) n FROM events').get().n,0);
  assert.equal(c.app.db.prepare('SELECT count(*) n FROM offers').get().n,0);
  assert.equal((await collect(c,s,{...input,eventId:randomUUID()})).data.accepted,false);
});
test('ad request reservations enforce budgets under concurrent load; replayed pixels do not double count',async t=>{
  const c=await setup(t);await campaign(c,{cpm:1000,totalBudget:1,dailyBudget:1});
  const responses=await Promise.all(Array.from({length:8},()=>c.call('/api/ads/sandbox','POST',{})));
  const ads=responses.map(r=>r.data.ad).filter(Boolean);assert.equal(ads.length,1);
  await Promise.all(Array.from({length:4},()=>c.call(ads[0].impressionPath)));
  const state=(await c.call('/api/state')).data;assert.equal(state.advertising.campaigns[0].impressions,1);assert.equal(state.advertising.campaigns[0].spent_micros,1000000);
  assert.equal((await c.call('/api/ads/sandbox','POST',{})).data.ad,null);
  const click=await c.call(ads[0].clickPath);assert.equal(click.status,302);assert.match(click.headers.get('location'),/^https:\/\/store\.example\.com\/offers\?signal_click=/);
  await c.call(ads[0].clickPath);assert.equal((await c.call('/api/state')).data.advertising.campaigns[0].clicks,1);
  assert.equal((await c.call('/ads/impression?token=forged')).status,403);
});
test('publisher origin and location quality control delivery; frame allows only registered embedding origin',async t=>{
  const c=await setup(t);const fence=(await c.call('/api/geofences','POST',{name:'Store',provider:'native',category:'retail',shape:'radius',lat:30.2672,lng:-97.7431,radiusKm:1,dailyBudget:20})).data;
  await campaign(c,{geofenceId:fence.id});
  const p=(await c.call('/api/ads/placements','POST',{name:'Publisher',origin:'https://publisher.example.com'})).data;
  const route='/ads/request?placement='+p.public_key,location={lat:30.2672,lng:-97.7431,accuracyMeters:10,source:'gps',timestamp:Date.now()};
  assert.equal((await c.call(route,'POST',{}, {Origin:'https://wrong.example'},null)).status,403);
  assert.equal((await c.call(route,'POST',{location},{Origin:'https://publisher.example.com'},null)).data.ad,null);
  const data={location,consent:{location:true,noticeVersion:'v1'}};
  assert.equal((await c.call(route,'POST',data,{Origin:'https://publisher.example.com','Sec-GPC':'1'},null)).data.ad,null);
  const served=await c.call(route,'POST',data,{Origin:'https://publisher.example.com'},null);assert.ok(served.data.ad);
  const frame=await c.call(served.data.ad.framePath);assert.equal(frame.status,200);assert.equal(frame.headers.get('x-frame-options'),null);assert.match(frame.headers.get('content-security-policy'),/frame-ancestors https:\/\/publisher.example.com/);
  assert.equal((await c.call('/api/geofences/'+fence.id,'DELETE',{})).status,409);
});
test('signed click attribution links a permitted website visit to its owned campaign',async t=>{
  const c=await setup(t),s=await site(c);const id=await campaign(c);const ad=(await c.call('/api/ads/sandbox','POST',{})).data.ad;
  await c.call(ad.impressionPath);const click=await c.call(ad.clickPath);const attribution=new URL(click.headers.get('location')).searchParams.get('signal_click');
  await collect(c,s,{...event(s),attribution});
  const e=c.app.db.prepare('SELECT * FROM events').get();assert.equal(e.campaign_id,id);assert.equal(e.ad_click_id,ad.id);assert.equal(e.source,'owned-ad');
  assert.equal((await c.call('/api/state')).data.advertising.campaigns[0].attributed_visits,1);
});
test('eligible live delivery is idempotent and unsubscribe immediately suppresses contacts',async t=>{
  let delivered=0,payload;const c=await setup(t,{providers:{...providers,deliver:async(_url,_key,input)=>{delivered++;payload=input;return {accepted:true};}},config:{delivery:true,outreachUrl:'https://gateway.example/send',outreachKey:'test',postalAddress:'123 Example St, Test City, NY 10001'}});
  const s=await site(c),input=event(s);const receipt=(await c.call('/api/consent','POST',{siteId:s.id,subjectId:input.subjectId,email:person.email,emailMarketing:true,noticeVersion:'v1',source:'Signup'})).data.receipt;
  await collect(c,s,{...input,consent:{...input.consent,emailReceipt:receipt}});await c.app.processJob();const o=(await c.call('/api/state')).data.offers[0];
  assert.equal((await c.call('/api/offers/'+o.id+'/deliver','POST',{})).status,200);assert.equal(delivered,1);
  assert.equal((await c.call('/api/offers/'+o.id+'/deliver','POST',{})).status,409);assert.equal(delivered,1);
  assert.match(payload.text,/Advertisement/);assert.match(payload.text,/123 Example St/);assert.ok(payload.unsubscribeUrl);
  const u=new URL(payload.unsubscribeUrl);assert.equal((await c.call(u.pathname+u.search,'POST',null,{},null)).status,200);
  assert.equal((await c.call('/api/state')).data.visitors[0].status,'suppressed');
});
test('radius and polygon tests account for uncertainty, GPS source, and freshness',()=>{
  const at=Date.now(),location={lat:30,lng:-97,accuracyMeters:10,source:'gps',timestamp:at};
  const radius={shape:'radius',lat:30,lng:-97,radiusKm:.1};assert.equal(locationMatches(radius,location,at),true);
  assert.equal(locationMatches(radius,{...location,accuracyMeters:101},at),false);
  assert.equal(locationMatches(radius,{...location,source:'ip'},at),false);
  assert.equal(locationMatches(radius,{...location,timestamp:at-300001},at),false);
  assert.equal(locationMatches(radius,{...location,lat:30.00085},at),false);
  const polygon={shape:'polygon',coordinates:[[-97.01,29.99],[-96.99,29.99],[-96.99,30.01],[-97.01,30.01],[-97.01,29.99]]};
  assert.equal(locationMatches(polygon,location,at),true);assert.equal(locationMatches(polygon,{...location,lng:-97.00999},at),false);
});
test('geofence plans reject malformed geometry and too-small Google radii',()=>{
  const base={name:'Fence',provider:'native',category:'retail',dailyBudget:10,shape:'polygon'};
  assert.throws(()=>validateGeofence({...base,coordinates:[[0,0],[1,0],[0,0]]}),/4–500/);
  assert.throws(()=>validateGeofence({...base,coordinates:[[0,0],[1,0],[1,1],[0,1]]}),/Close/);
  assert.throws(()=>validateGeofence({...base,coordinates:[[0,0],[0,0],[0,0],[0,0]]}),/distinct/);
  assert.throws(()=>validateGeofence({...base,provider:'google_radius',shape:'radius',lat:30,lng:-97,radiusKm:.1}),/1–500/);
  assert.throws(()=>validateGeofence({...base,category:'medical'}),/commercial/);
});

test('provider failures retry without exposing upstream bodies and eventually erase encrypted input',async t=>{
  let attempts=0;const c=await setup(t,{providers:{resolveIdentity:async()=>{attempts++;throw Error('Secret upstream body must never be logged');}}});const s=await site(c);await collect(c,s,event(s));
  for(let i=0;i<3;i++){c.app.db.prepare("UPDATE jobs SET available=0 WHERE status='queued'").run();await c.app.processJob();}
  const job=c.app.db.prepare('SELECT * FROM jobs').get();assert.equal(attempts,3);assert.equal(job.status,'failed');assert.equal(job.payload,null);assert.ok(!job.error.includes('Secret'));assert.equal((await c.call('/api/state')).data.visitors[0].status,'error');
});
test('suppression during an in-flight lookup prevents a late identity append',async t=>{
  let release;const resolved=new Promise(r=>{release=r;});const c=await setup(t,{providers:{...providers,resolveIdentity:()=>resolved}}),s=await site(c);const visitor=(await collect(c,s,event(s))).data.visitorId;
  const pending=c.app.processJob();await c.call('/api/visitors/'+visitor+'/suppress','POST',{});release({...person});await pending;
  const v=(await c.call('/api/state')).data.visitors[0];assert.equal(v.status,'suppressed');assert.equal(v.person,null);assert.equal(c.app.db.prepare('SELECT count(*) n FROM offers').get().n,0);
});
test('self-intersecting polygon input is rejected',()=>{
  assert.throws(()=>validateGeofence({name:'Crossed',provider:'native',category:'retail',dailyBudget:10,shape:'polygon',coordinates:[[0,0],[4,4],[0,4],[4,0],[2,-1],[0,0]]}),/intersect/);
});
