import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { normalizeConsumer, normalizeEmail, parseCSV } from '../server/consumers.js';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'signal-consumers-'));
  const app = createApp({ dataDir, worker: false, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, method = 'GET', payload, token = 'local-demo-only', headers = {}) {
    const response = await fetch(base + route, { method, redirect: 'manual', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text(), headers: response.headers };
  }
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, base, call };
}
async function contact(c, email = 'morgan@example.com', extra = {}, source = { type: 'crm', name: 'Customer CRM' }) {
  const result = await c.call('/api/consumers', 'POST', { contact: { email, name: 'Morgan Lane', ...extra }, source });
  assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
  return result.data.consumer;
}
async function visit(c, subjectId = randomUUID()) {
  const site = (await c.call('/api/sites', 'POST', { name: 'Customer site', origin: 'https://store.example.com' })).data;
  const accepted = await c.call('/collect?site=' + site.public_key, 'POST', {
    subjectId, eventId: randomUUID(), url: site.origin + '/request-quote', consent: { collection: true, noticeVersion: 'v1' },
  }, null, { Origin: site.origin });
  assert.equal(accepted.status, 202);
  return { ...accepted.data, site, subjectId };
}
const csv = 'email,name,phone,city,updated_at,external_id\r\nmorgan@example.com,"Lane, Morgan",(202) 555-0120,Austin,2026-01-01T00:00:00Z,crm-1\r\n';

test('consumer normalization preserves email identity and does not claim verification', () => {
  assert.equal(normalizeEmail(' Morgan+quote@Example.com '), 'morgan+quote@example.com');
  const n = normalizeConsumer({ email: 'a@example.com', phone: '(202) 555-0120', country: 'us' });
  assert.equal(n.fields.phone, '+12025550120'); assert.equal(n.fields.country, 'US');
  assert.throws(() => normalizeConsumer({ email: 'a@example.com', phone: 'call me now' }), /Phone/);
  assert.throws(() => normalizeConsumer({ email: 'bad' }), /valid email/);
  assert.throws(() => normalizeConsumer({ email: 'a@example.com' }, { observedAt: '2099-01-01' }), /future/);
});
test('CSV parser supports BOM, CRLF, commas, escaped quotes, multiline values and rejects malformed columns', () => {
  const result = parseCSV('\uFEFFemail,name,other\r\na@example.com,"A, ""B""\nC",ignored\r\n');
  assert.equal(result.records[0].name, 'A, "B"\nC'); assert.deepEqual(result.ignoredHeaders, ['other']);
  assert.throws(() => parseCSV('email,email_address\na@example.com,b@example.com'), /duplicate/);
  assert.throws(() => parseCSV('email,name\na@example.com'), /columns/);
  assert.throws(() => parseCSV('email,name\na@example.com,"open'), /unclosed/);
});
test('import preview is read-only; identical timestamped imports are idempotent', async t => {
  const c = await setup(t); const input = { format: 'csv', sourceName: 'Customer CRM', content: csv };
  const preview = await c.call('/api/consumers/import-preview', 'POST', input);
  assert.equal(preview.status, 200); assert.equal(preview.data.newContacts, 1); assert.equal(preview.data.issues.length, 0);
  assert.equal((await c.call('/api/state')).data.consumers.length, 0);
  assert.equal((await c.call('/api/consumers/import', 'POST', input)).data.created, 1);
  const repeated = await c.call('/api/consumers/import', 'POST', input);
  assert.equal(repeated.status, 201); assert.equal(repeated.data.unchanged, 1);
  const state = (await c.call('/api/state')).data;
  assert.equal(state.consumers.length, 1); assert.equal(state.visitors.length, 0); assert.equal(state.offers.length, 0);
  assert.equal(state.consumers[0].phone, '+12025550120'); assert.equal(state.consumers[0].verification, 'not_verified_by_import');
});
test('invalid and duplicate import rows prevent all writes', async t => {
  const c = await setup(t); const input = { format: 'json', sourceName: 'CRM', content: JSON.stringify([{ email: 'valid@example.com' }, { email: 'invalid' }]) };
  const preview = await c.call('/api/consumers/import-preview', 'POST', input); assert.equal(preview.data.issues.length, 1);
  assert.equal((await c.call('/api/consumers/import', 'POST', input)).status, 400);
  assert.equal((await c.call('/api/consumers')).data.consumers.length, 0);
  input.content = JSON.stringify([{ email: 'a@example.com' }, { email: ' A@EXAMPLE.COM ' }]);
  assert.equal((await c.call('/api/consumers/import', 'POST', input)).status, 400);
});
test('newer first-party fields survive old or lower-authority CRM updates; missing fields are appended', async t => {
  const c = await setup(t); const original = await contact(c, 'a@example.com', { phone: '+12025550121' }, { type: 'form', name: 'Quote form', observedAt: '2026-02-01T00:00:00Z' });
  const old = await c.call('/api/consumers', 'POST', { contact: { email: original.email, name: 'Old Name', phone: '+12025550122', city: 'Austin' }, source: { type: 'crm', name: 'Legacy CRM', observedAt: '2026-01-01T00:00:00Z' } });
  assert.equal(old.data.conflicts, 2); assert.equal(old.data.consumer.name, 'Morgan Lane'); assert.equal(old.data.consumer.phone, '+12025550121'); assert.equal(old.data.consumer.city, 'Austin');
  assert.equal(old.data.consumer.provenance.phone.name, 'Quote form'); assert.equal(old.data.consumer.provenance.city.name, 'Legacy CRM');
  await c.call('/api/consumers', 'POST', { contact: { email: original.email, phone: '+12025550123' }, source: { type: 'crm', name: 'New CRM', observedAt: '2026-03-01T00:00:00Z' } });
  assert.equal((await c.call('/api/consumers/' + original.id)).data.consumer.phone, '+12025550121');
});
test('one external CRM record cannot silently become a different email identity', async t => {
  const c = await setup(t); await contact(c, 'a@example.com', {}, { type: 'crm', name: 'CRM', recordId: 'id-1' });
  assert.equal((await c.call('/api/consumers', 'POST', { contact: { email: 'b@example.com' }, source: { type: 'crm', name: 'CRM', recordId: 'id-1' } })).status, 409);
  assert.equal((await c.call('/api/consumers')).data.consumers.length, 1);
});
test('first-party association enriches locally, cancels anonymous work, and keeps permission separate', async t => {
  let identityCalls = 0;
  const c = await setup(t, { providers: { resolveIdentity: async () => { identityCalls++; return null; } } });
  const customer = await contact(c); const v = await visit(c);
  const identified = await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id });
  assert.equal(identified.status, 200); assert.equal(identified.data.emailPermissionRecorded, false);
  await c.app.processJob();
  const state = (await c.call('/api/state')).data, person = state.visitors[0].person;
  assert.equal(identityCalls, 0); assert.equal(person.method, 'customer_provided'); assert.equal(person.confidence, null); assert.equal(person.consumerId, customer.id);
  assert.equal(state.offers[0].status, 'blocked'); assert.match(state.offers[0].reason, /consent receipt/); assert.match(state.offers[0].reason, /validation/); assert.ok(!state.offers[0].reason.includes('90%'));
});
test('authenticated form capture upserts contact and only explicit permission plus validation makes offer ready', async t => {
  const c = await setup(t, { providers: { resolveIdentity: async () => { throw Error('Graph must not be called'); }, validateContact: async () => ({ email: 'valid', phone: 'unknown' }) } });
  const v = await visit(c);
  const identified = await c.call('/api/identify', 'POST', { siteId: v.site.id, subjectId: v.subjectId, contact: { email: 'quote@example.com', name: 'Quote Customer' }, source: { type: 'form', name: 'Request quote form' }, consent: { emailMarketing: true, noticeVersion: 'marketing-v2' } });
  assert.equal(identified.status, 200, JSON.stringify(identified.data)); await c.app.processJob();
  let state = (await c.call('/api/state')).data; assert.equal(state.consumers.length, 1); assert.equal(state.offers[0].status, 'ready');
  await c.call('/collect?site=' + v.site.public_key, 'POST', { subjectId: v.subjectId, eventId: randomUUID(), url: v.site.origin + '/thanks', consent: { collection: true, noticeVersion: 'v1', emailReceipt: null } }, null, { Origin: v.site.origin });
  state = (await c.call('/api/state')).data; assert.equal(state.visitors[0].consent.emailReceipt, true);
});
test('invalid form permission rolls back profile, association and queued replacement work', async t => {
  const c = await setup(t), v = await visit(c);
  const r = await c.call('/api/identify', 'POST', { visitorId: v.visitorId, contact: { email: 'a@example.com' }, source: { type: 'form', name: 'Form' }, consent: { emailMarketing: true } });
  assert.equal(r.status, 400); assert.equal((await c.call('/api/consumers')).data.consumers.length, 0);
  assert.equal(c.app.db.prepare('SELECT count(*) n FROM consumer_links').get().n, 0);
});
test('existing session association cannot silently switch consumers', async t => {
  const c = await setup(t), a = await contact(c, 'a@example.com'), b = await contact(c, 'b@example.com'), v = await visit(c);
  assert.equal((await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: a.id })).status, 200);
  assert.equal((await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: b.id })).status, 409);
  assert.equal(c.app.db.prepare('SELECT consumer_id FROM consumer_links').get().consumer_id, a.id);
});
test('first-party consumer and session operations remain isolated by workspace and require authentication', async t => {
  const c = await setup(t), customer = await contact(c), v = await visit(c);
  const other = (await c.call('/api/workspaces', 'POST', { name: 'Other client' })).data.token;
  assert.equal((await c.call('/api/consumers/' + customer.id, 'GET', undefined, other)).status, 404);
  assert.equal((await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id }, other)).status, 404);
  assert.equal((await c.call('/api/consumers', 'POST', { email: 'a@example.com' }, null)).status, 401);
  assert.equal((await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id }, null)).status, 401);
});
test('consumer suppression blocks all associated sessions and cannot be undone by importing', async t => {
  const c = await setup(t), customer = await contact(c), a = await visit(c), b = await visit(c);
  for (const v of [a,b]) await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id });
  assert.equal((await c.call('/api/consumers/' + customer.id + '/suppress', 'POST', {})).status, 200);
  const state = (await c.call('/api/state')).data; assert.ok(state.visitors.every(v => v.status === 'suppressed')); assert.ok(state.jobs.every(j => j.status === 'cancelled'));
  assert.equal((await c.call('/api/consumers', 'POST', { email: customer.email })).status, 409);
});
test('consumer erasure removes associated history, visits and pending work and prevents re-import', async t => {
  const c = await setup(t), customer = await contact(c), v = await visit(c); await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id });
  assert.equal((await c.call('/api/consumers/' + customer.id, 'DELETE', {})).status, 200);
  const state = (await c.call('/api/state')).data; assert.equal(state.consumers.length, 0); assert.equal(state.visitors.length, 0); assert.equal(state.jobs.length, 0);
  for (const table of ['consumer_history', 'consumer_links', 'consumer_source_refs']) assert.equal(c.app.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal((await c.call('/api/consumers', 'POST', { email: customer.email })).status, 409);
});
test('updated local data requires an offer refresh and stale in-flight validation cannot overwrite it', async t => {
  let release; const validation = new Promise(r => { release = r; });
  const c = await setup(t, { providers: { validateContact: () => validation } }), customer = await contact(c), v = await visit(c);
  await c.call('/api/identify', 'POST', { visitorId: v.visitorId, consumerId: customer.id });
  const pending = c.app.processJob();
  await c.call('/api/consumers/' + customer.id, 'PATCH', { name: 'Corrected Customer' });
  release({ email: 'valid', phone: 'unknown' }); await pending;
  assert.equal(c.app.db.prepare('SELECT count(*) n FROM offers').get().n, 0);
  assert.match(c.app.db.prepare("SELECT error FROM jobs WHERE status='queued'").get().error, /changed/);
  assert.equal((await c.call('/api/visitors/' + v.visitorId + '/enrich', 'POST', {})).status, 202);
  await c.app.processJob();
  assert.equal((await c.call('/api/state')).data.visitors[0].person.name, 'Corrected Customer');
});

test('customer record changes block stale live delivery; refreshed first-party offers can send without a fabricated score', async t => {
  let payload, sends=0;
  const c=await setup(t,{providers:{validateContact:async()=>({email:'valid',phone:'unknown'}),deliver:async(_url,_key,input)=>{payload=input;sends++;return {accepted:true};}},config:{delivery:true,outreachUrl:'https://delivery.example/send',outreachKey:'test',postalAddress:'123 Example Street, Test City, NY 10001'}});
  const customer=await contact(c),v=await visit(c);
  await c.call('/api/identify','POST',{visitorId:v.visitorId,consumerId:customer.id,consent:{emailMarketing:true,noticeVersion:'v1'}});await c.app.processJob();
  const offer=(await c.call('/api/state')).data.offers[0];assert.equal(offer.status,'ready');
  await c.call('/api/consumers/'+customer.id,'PATCH',{name:'Updated Customer'});
  assert.equal((await c.call('/api/offers/'+offer.id+'/deliver','POST',{})).status,409);assert.equal(sends,0);
  await c.call('/api/visitors/'+v.visitorId+'/enrich','POST',{});await c.app.processJob();
  assert.equal((await c.call('/api/offers/'+offer.id+'/deliver','POST',{})).status,200);assert.equal(sends,1);
  const unsubscribe=new URL(payload.unsubscribeUrl);
  assert.equal((await c.call(unsubscribe.pathname+unsubscribe.search,'POST',undefined,null)).status,200);
  assert.equal((await c.call('/api/consumers/'+customer.id)).data.consumer.status,'suppressed');
});
test('erasure also removes unlinked visits carrying a consent receipt for the same email', async t=>{
  const c=await setup(t),customer=await contact(c),v=await visit(c);
  const receipt=(await c.call('/api/consent','POST',{siteId:v.site.id,subjectId:v.subjectId,email:customer.email,emailMarketing:true,noticeVersion:'v1',source:'Form'})).data.receipt;
  await c.call('/collect?site='+v.site.public_key,'POST',{subjectId:v.subjectId,eventId:randomUUID(),url:v.site.origin+'/',consent:{collection:true,noticeVersion:'v1',emailReceipt:receipt}},null,{Origin:v.site.origin});
  await c.call('/api/consumers/'+customer.id,'DELETE',{});
  assert.equal((await c.call('/api/state')).data.visitors.length,0);
});
