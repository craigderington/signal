import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures, resolveIdentity, validateContact, validateGeofence, geojson, gateway } from './providers.js';
import { createAdEngine } from './ads.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const parse = value => JSON.parse(value);
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const emailValid = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length < 255;
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createApp(options = {}) {
  const localDemo = options.localDemo ?? (!process.env.ADMIN_TOKEN && process.env.NODE_ENV !== 'production');
  const config = {
    localDemo, adminToken: options.adminToken || process.env.ADMIN_TOKEN || 'local-demo-only',
    identityUrl: process.env.IDENTITY_URL, identityKey: process.env.IDENTITY_KEY,
    validationUrl: process.env.VALIDATION_URL, validationKey: process.env.VALIDATION_KEY,
    providerName: process.env.IDENTITY_PROVIDER_NAME || 'Licensed identity gateway',
    outreachUrl: process.env.OUTREACH_URL, outreachKey: process.env.OUTREACH_KEY,
    delivery: process.env.ENABLE_DELIVERY === 'true', postalAddress: process.env.SENDER_POSTAL_ADDRESS || '',
    ...options.config,
  };
  const identityResolver = options.providers?.resolveIdentity || resolveIdentity;
  const contactValidator = options.providers?.validateContact || validateContact;
  const deliveryGateway = options.providers?.deliver || gateway;
  if (localDemo && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '127.0.0.1')) throw new Error('Demo authentication is allowed only on loopback');
  if (!localDemo && config.adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters');
  const dataDir = options.dataDir || path.resolve(process.env.DATA_DIR || '.data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  let secret = options.secret || process.env.DATA_SECRET;
  if (!secret && !localDemo) throw new Error('DATA_SECRET is required outside local demo mode');
  if (!secret) {
    const secretFile = path.join(dataDir, 'secret');
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(48).toString('hex'), { mode: 0o600 });
    secret = readFileSync(secretFile, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('DATA_SECRET must contain at least 32 characters');
  const cryptKey = createHash('sha256').update(secret).digest();
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const opaque = (scope, value) => createHmac('sha256', secret).update(`${scope}:${value}`).digest('hex');
  const seal = payload => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', cryptKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
  };
  const unseal = encrypted => {
    const [iv, tag, body] = encrypted.split('.').map(s => Buffer.from(s, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', cryptKey, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
  };
  const token = payload => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${body}.${sign(body)}`; };
  const verify = encoded => {
    if (typeof encoded !== 'string' || encoded.length > 4000) return null;
    const parts = encoded.split('.'); if (parts.length !== 2) return null;
    const [body, signature] = parts;
    if (!body || !signature) return null;
    const expected = sign(body);
    if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
    try { const p = parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
  };
  const dbFile = path.join(dataDir, 'signal.sqlite');
  const db = new DatabaseSync(dbFile);
  chmodSync(dbFile, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,origin TEXT NOT NULL,public_key TEXT UNIQUE NOT NULL,demo INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,site_id TEXT NOT NULL,subject_key TEXT NOT NULL,status TEXT NOT NULL,person TEXT,validation TEXT,consent TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,UNIQUE(site_id,subject_key));
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,site_id TEXT NOT NULL,visitor_id TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,page TEXT NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(site_id,event_key));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,visitor_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL,error TEXT,created TEXT NOT NULL,completed TEXT);
    CREATE TABLE IF NOT EXISTS campaigns(workspace_id TEXT PRIMARY KEY,name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,visitor_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,reason TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,elapsed_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS suppressions(workspace_id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,value));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS geofences(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,plan TEXT NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visitors_workspace ON visitors(workspace_id,last_seen);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,available);
    CREATE INDEX IF NOT EXISTS events_visitor ON events(visitor_id,created);
    PRAGMA user_version=1;`);
  const eventColumns = db.prepare('PRAGMA table_info(events)').all().map(c=>c.name);
  if (!eventColumns.includes('campaign_id')) db.exec('ALTER TABLE events ADD COLUMN campaign_id TEXT');
  if (!eventColumns.includes('ad_click_id')) db.exec('ALTER TABLE events ADD COLUMN ad_click_id TEXT');
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const audit = (workspace, action, detail) => run('INSERT INTO audit VALUES(?,?,?,?,?)', randomUUID(), workspace, action, detail, now());
  const transaction = callback => { db.exec('BEGIN IMMEDIATE'); try { const r = callback(); db.exec('COMMIT'); return r; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  // The configured token authenticates only the bootstrap workspace; others use distinct tokens.
  const existing = get('SELECT id FROM workspaces WHERE id=?', 'default');
  if (!existing) run('INSERT INTO workspaces VALUES(?,?,?)', 'default', 'Your workspace', hash(config.adminToken));
  else run('UPDATE workspaces SET token_hash=? WHERE id=?', hash(config.adminToken), 'default');
  function initCampaign(workspace) {
    run('INSERT OR IGNORE INTO campaigns VALUES(?,?,?,?,?)', workspace, 'Welcome offer', 'A little something for you, {{firstName}}', 'Hi {{firstName}},\n\nThanks for exploring our website. We would love to help you find the right fit. Reply to this email to claim your complimentary consultation.\n\nThe team', 1);
  }
  initCampaign('default');
  // Pending encrypted work survives restart; completed payloads are erased.
  run("UPDATE jobs SET status='queued' WHERE status='processing'");
  run("UPDATE offers SET status='delivery_uncertain',reason='Server restarted during delivery. Reconcile with delivery provider before retrying.' WHERE status='sending'");
  const limiters = new Map();
  function rate(key, maximum, window = 60000) {
    const t = Date.now(); let entry = limiters.get(key);
    if (!entry || entry.reset < t) entry = { count: 0, reset: t + window };
    entry.count++; limiters.set(key, entry);
    if (limiters.size > 10000) { for (const [k,v] of limiters) if (v.reset < t) limiters.delete(k); if (limiters.size > 10000) limiters.delete(limiters.keys().next().value); }
    if (entry.count > maximum) fail(429, 'Too many requests; try again shortly');
  }
  const suppressed = (workspace, kind, value) => Boolean(get('SELECT 1 FROM suppressions WHERE workspace_id=? AND kind=? AND value=?', workspace, kind, opaque(workspace, value)));
  function suppress(workspace, visitor) {
    run('INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)', workspace, 'subject', visitor.subject_key, now());
    if (visitor.person) { const p = parse(visitor.person); if (p.email) run('INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)', workspace, 'email', opaque(workspace, p.email.toLowerCase()), now()); }
    run("UPDATE visitors SET status='suppressed' WHERE id=? AND workspace_id=?", visitor.id, workspace);
    run("UPDATE offers SET status='blocked',reason='Contact opted out or was suppressed' WHERE visitor_id=? AND status NOT IN ('sent','simulated_sent','sending','delivery_uncertain')", visitor.id);
    run("UPDATE jobs SET status='cancelled',payload=NULL WHERE visitor_id=? AND status IN ('queued','processing')", visitor.id);
  }
  async function body(req) {
    let chunks = ''; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 24000) fail(413, 'Request is too large'); chunks += chunk; }
    try { const value = JSON.parse(chunks); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'Expected a JSON object'); return value; } catch (error) { if (error.status) throw error; fail(400, 'Invalid JSON'); }
  }
  function workspace(req) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) return get('SELECT * FROM workspaces WHERE token_hash=?', hash(bearer));
    const sid = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('signal_session='))?.slice(15);
    return sid ? get('SELECT w.* FROM workspaces w JOIN sessions s ON s.workspace_id=w.id WHERE s.id=? AND s.expires>?', hash(sid), Date.now()) : null;
  }
  function ipOf(req) {
    const socketIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
    return process.env.TRUSTED_PROXY_IP === socketIp ? text(req.headers['x-real-ip'], 64) || socketIp : socketIp;
  }
  function consentReceipt(workspaceId, siteId, input, demo = false) {
    if (!emailValid(input.email) || typeof input.subjectId !== 'string' || input.subjectId.length < 8 || input.subjectId.length > 120 || input.emailMarketing !== true || !text(input.noticeVersion, 100) || !text(input.source, 200)) fail(400, 'Consent requires email, subjectId, emailMarketing=true, noticeVersion and source');
    return token({ purpose: 'email_consent', workspaceId, siteId, subject: opaque(workspaceId, input.subjectId), email: input.email.toLowerCase(), notice: input.noticeVersion, source: input.source, demo, recordedAt: now(), exp: Date.now() + 30 * 86400000 });
  }
  function acceptEvent(site, input, req, demo = false) {
    if (input.consent?.collection !== true || !text(input.consent?.noticeVersion, 100) || input.gpc === true || req.headers['sec-gpc'] === '1') return { accepted: false, reason: 'Consent absent or privacy opt-out enabled' };
    if (typeof input.subjectId !== 'string' || input.subjectId.length < 8 || input.subjectId.length > 120 || typeof input.eventId !== 'string' || input.eventId.length < 8 || input.eventId.length > 120) fail(400, 'subjectId and eventId must contain 8–120 characters');
    const subjectKey = opaque(site.workspace_id, input.subjectId);
    if (get('SELECT 1 FROM suppressions WHERE workspace_id=? AND kind=? AND value=?', site.workspace_id,'subject',subjectKey)) return { accepted: false, reason: 'Visitor suppressed' };
    const duplicate = get('SELECT id FROM events WHERE site_id=? AND event_key=?', site.id, input.eventId);
    if (duplicate) return { accepted: true, duplicate: true, eventId: duplicate.id };
    let page;
    try { const u = new URL(input.url); if (u.origin !== site.origin) fail(400, 'Event URL does not match registered site'); page = u.pathname.slice(0, 300); } catch (error) { if (error.status) throw error; fail(400,'Invalid page URL'); }
    const consent = { collection: true, noticeVersion: text(input.consent.noticeVersion, 100), recordedAt: now(), emailReceipt: typeof input.consent.emailReceipt === 'string' ? input.consent.emailReceipt.slice(0, 4000) : null };
    const found = get('SELECT * FROM visitors WHERE site_id=? AND subject_key=?',site.id,subjectKey);
    const visitorId = found?.id || randomUUID(); const eventId = randomUUID(); const timestamp = now();
    const pending = get("SELECT 1 FROM jobs WHERE visitor_id=? AND status IN ('queued','processing')",visitorId);
    const receiptChanged = found && consent.emailReceipt && consent.emailReceipt !== parse(found.consent).emailReceipt;
    const shouldResolve = !pending && (!found || found.status === 'unmatched' || found.status === 'error' || Boolean(receiptChanged));
    const attributed = verify(input.attribution);
    const click = attributed?.purpose === 'attribution' && attributed.workspaceId === site.workspace_id ? get("SELECT campaign_id,id FROM ad_ledger WHERE id=? AND workspace_id=? AND status='shown' AND click_at IS NOT NULL",attributed.ledgerId,site.workspace_id) : null;
    const payload = { ip: ipOf(req), subjectId: input.subjectId, siteId: site.id, timestamp, collectionConsent: { collection: true, noticeVersion: consent.noticeVersion }, demo, fixture: input.fixture || 0 };
    transaction(() => {
      if (!found) run('INSERT INTO visitors VALUES(?,?,?,?,?,?,?,?,?,?)',visitorId,site.workspace_id,site.id,subjectKey,'queued',null,null,JSON.stringify(consent),timestamp,timestamp);
      else run('UPDATE visitors SET last_seen=?,consent=? WHERE id=?',timestamp,JSON.stringify(consent),visitorId);
      run('INSERT INTO events(id,workspace_id,site_id,visitor_id,event_key,kind,page,source,created,campaign_id,ad_click_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',eventId,site.workspace_id,site.id,visitorId,input.eventId,input.kind === 'impression' ? 'impression' : 'pageview',page,click ? 'owned-ad' : text(input.source,100) || 'direct',timestamp,click?.campaign_id || null,click?.id || null);
      if (shouldResolve) {
        run("UPDATE visitors SET status='queued' WHERE id=?",visitorId);
        run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),site.workspace_id,visitorId,eventId,seal(payload),'queued',0,Date.now(),null,timestamp,null);
      }
    });
    return { accepted: true, eventId, visitorId };
  }
  let workerBusy = false;
  let closing = false;
  async function processJob() {
    if (workerBusy || closing) return;
    const job = get("SELECT * FROM jobs WHERE status='queued' AND available<=? ORDER BY created LIMIT 1", Date.now());
    if (!job) return;
    workerBusy = true;
    run("UPDATE jobs SET status='processing',attempts=attempts+1 WHERE id=?",job.id);
    try {
      const payload = unseal(job.payload);
      const site = get('SELECT * FROM sites WHERE id=?',payload.siteId);
      const person = await identityResolver(payload,config);
      let visitor = get('SELECT * FROM visitors WHERE id=?',job.visitor_id);
      if (!visitor || visitor.status === 'suppressed' || get('SELECT status FROM jobs WHERE id=?',job.id)?.status === 'cancelled') return;
      if (!person) {
        run("UPDATE visitors SET status='unmatched' WHERE id=?",visitor.id);
        audit(job.workspace_id,'Identity lookup',payload.demo || config.identityUrl ? 'No match returned' : 'No licensed provider configured; visitor remains anonymous');
      } else {
        if (person.email && suppressed(job.workspace_id,'email',person.email.toLowerCase())) {
          const cleanConsent={...parse(visitor.consent),emailReceipt:null};
          run("UPDATE visitors SET status='suppressed',person=NULL,validation=NULL,consent=? WHERE id=?",JSON.stringify(cleanConsent),visitor.id);
          run("UPDATE jobs SET status='completed',payload=NULL,completed=? WHERE id=?",now(),job.id);
          audit(job.workspace_id,'Suppressed identity match','Matched email is suppressed; profile was not appended or sent for validation');
          return;
        }
        const validation = await contactValidator(person,payload.demo,config);
        visitor = get('SELECT * FROM visitors WHERE id=?',job.visitor_id);
        if (!visitor || visitor.status === 'suppressed' || get('SELECT status FROM jobs WHERE id=?',job.id)?.status === 'cancelled') return;
        const isSuppressed = person.email && suppressed(job.workspace_id,'email',person.email.toLowerCase());
        const consent = parse(visitor.consent);
        const receipt = verify(consent.emailReceipt);
        const permitted = receipt?.purpose === 'email_consent' && receipt.workspaceId === job.workspace_id && receipt.siteId === site.id && receipt.subject === visitor.subject_key && receipt.email === person.email.toLowerCase() && receipt.demo === Boolean(payload.demo);
        const campaign = get('SELECT * FROM campaigns WHERE workspace_id=?',job.workspace_id);
        const reasons = [];
        if (isSuppressed) reasons.push('Contact is on the suppression list');
        if (person.scope !== 'person') reasons.push('Match identifies a household, not an individual');
        if (person.confidence < 0.9) reasons.push('Match confidence is below 90%');
        if (!emailValid(person.email)) reasons.push('No usable email address');
        if (!permitted) reasons.push('No matching first-party email marketing consent receipt');
        if (!['valid','demo_valid'].includes(validation.email)) reasons.push('Email has not passed validation');
        if (!campaign.enabled) reasons.push('Offer campaign is paused');
        const firstName = (person.name || 'there').split(' ')[0];
        const personalize = s => s.replaceAll('{{firstName}}',firstName);
        const offerId = randomUUID();
        const elapsed = Date.now() - Date.parse(job.created);
        transaction(() => {
          run('UPDATE visitors SET person=?,validation=?,status=? WHERE id=?',JSON.stringify(person),JSON.stringify(validation),isSuppressed ? 'suppressed' : 'matched',visitor.id);
          run("INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(visitor_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,subject=excluded.subject,body=excluded.body,elapsed_ms=excluded.elapsed_ms WHERE offers.status IN ('blocked','ready')",offerId,job.workspace_id,visitor.id,reasons.length ? 'blocked' : payload.demo ? 'simulated_sent' : 'ready',reasons.join('; ') || (payload.demo ? 'Simulated delivery. No email or SMS sent.' : 'Eligible for configured delivery'),personalize(campaign.subject),personalize(campaign.body),now(),elapsed);
          audit(job.workspace_id,'Identity matched',`${person.provider}: ${person.scope} match; ${Math.round(person.confidence*100)}% reported confidence`);
        });
      }
      run("UPDATE jobs SET status='completed',payload=NULL,completed=?,error=NULL WHERE id=? AND status!='cancelled'",now(),job.id);
    } catch (error) {
      const attempts = job.attempts + 1;
      const safeError = error.message.startsWith('Provider') || error.message.startsWith('Identity') ? error.message : 'Provider processing failed or timed out';
      const visitor = get('SELECT status FROM visitors WHERE id=?',job.visitor_id);
      if (visitor && visitor.status !== 'suppressed' && get('SELECT status FROM jobs WHERE id=?',job.id)?.status !== 'cancelled') {
        run('UPDATE jobs SET status=?,available=?,error=?,payload=?,completed=? WHERE id=?',attempts < 3 ? 'queued' : 'failed',Date.now()+attempts*1000,safeError,attempts < 3 ? job.payload : null,attempts < 3 ? null : now(),job.id);
        run('UPDATE visitors SET status=? WHERE id=?',attempts < 3 ? 'queued' : 'error',job.visitor_id);
        audit(job.workspace_id,'Lookup retry',safeError);
      }
    } finally { workerBusy = false; }
  }
  function publicVisitor(v) {
    return { ...v, person: v.person ? parse(v.person) : null, validation: v.validation ? parse(v.validation) : null, consent: { ...parse(v.consent), emailReceipt: Boolean(parse(v.consent).emailReceipt) }, subject_key: undefined };
  }
  function base(req) {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/,'');
    return `http://${req.headers.host}`;
  }
  function security(res) {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  const ads = createAdEngine({db, token, verify, rate, audit, body, workspace, base});
  const server = http.createServer(async (req,res) => {
    security(res);
    const json = (status,data,headers={}) => { res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(data)); };
    try {
      const host = req.headers.host || '';
      const allowed = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).host : null;
      if (allowed ? host !== allowed : !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) fail(403,'Unrecognized host');
      const url = new URL(req.url,base(req)); const route = url.pathname; const method = req.method;
      const mutate = ['POST','PATCH','DELETE','PUT'].includes(method);
      if (route.startsWith('/api/') && mutate && req.headers.origin && req.headers.origin !== new URL(base(req)).origin) fail(403,'Cross-origin admin request rejected');
      if (await ads.handle(req,res,url)) return;
      if (route === '/health') return json(200,{ok:true});
      if (route === '/tracker.js') { res.writeHead(200,{'Content-Type':'text/javascript','Access-Control-Allow-Origin':'*'}); return res.end(readFileSync(path.join(root,'public/tracker.js'))); }
      if (route === '/collect' || route === '/pixel.gif') {
        const site = get('SELECT * FROM sites WHERE public_key=?',url.searchParams.get('site') || '');
        if (!site || site.demo) fail(404,'Unknown or demo-only site');
        const origin = req.headers.origin || (() => { try { return new URL(req.headers.referer).origin; } catch { return ''; } })();
        if (origin !== site.origin) fail(403,'Origin does not match registered site');
        res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin');
        if (method === 'OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end(); }
        rate(`collect:${site.id}:${opaque(site.id,ipOf(req))}`,120);rate(`site:${site.id}`,2000);
        let input;
        if (route === '/pixel.gif' && method === 'GET') {
          const receipt = verify(url.searchParams.get('receipt'));
          if (!receipt || receipt.purpose !== 'pixel_consent' || receipt.siteId !== site.id) fail(403,'A signed pixel consent receipt is required');
          input = { subjectId:receipt.subjectId,eventId:text(url.searchParams.get('event'),120),kind:'impression',url:site.origin+'/',source:text(url.searchParams.get('campaign'),100),consent:{collection:true,noticeVersion:receipt.noticeVersion} };
        } else { if (method !== 'POST') fail(405,'Use POST'); input = await body(req); }
        const result = acceptEvent(site,input,req);
        if (route === '/pixel.gif') { res.writeHead(200,{'Content-Type':'image/gif','Cache-Control':'no-store, max-age=0'});return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')); }
        return json(202,result);
      }
      if (route === '/unsubscribe') {
        const receipt = verify(url.searchParams.get('token'));
        if (!receipt || receipt.purpose !== 'unsubscribe') fail(400,'This unsubscribe link is invalid or expired');
        if (method === 'POST') {
          run('INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)',receipt.workspaceId,'email',opaque(receipt.workspaceId,receipt.email),now());
          for (const visitor of all('SELECT * FROM visitors WHERE workspace_id=? AND person IS NOT NULL',receipt.workspaceId)) if (parse(visitor.person).email.toLowerCase() === receipt.email) suppress(receipt.workspaceId,visitor);
          audit(receipt.workspaceId,'Unsubscribed','Email suppressed from future offers');
          res.writeHead(200,{'Content-Type':'text/html'});return res.end('<!doctype html><html lang="en"><title>Unsubscribed</title><body><h1>You are unsubscribed.</h1><p>You will receive no further offers from this workspace.</p></body></html>');
        }
        if (method !== 'GET') fail(405,'Use GET or POST');
        res.writeHead(200,{'Content-Type':'text/html'});return res.end(`<!doctype html><html lang="en"><title>Unsubscribe</title><body><h1>Stop marketing emails</h1><form method="post" action="${escape(req.url)}"><button>Unsubscribe</button></form></body></html>`);
      }
      if (route === '/api/login' && method === 'POST') {
        rate(`login:${ipOf(req)}`,10);
        const input = await body(req); const w = typeof input.token === 'string' && get('SELECT * FROM workspaces WHERE token_hash=?',hash(input.token));
        if (!w) fail(401,'Invalid workspace token');
        const sid = randomBytes(32).toString('base64url');run('INSERT INTO sessions VALUES(?,?,?)',hash(sid),w.id,Date.now()+12*3600000);
        return json(200,{workspace:{id:w.id,name:w.name}},{'Set-Cookie':`signal_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${base(req).startsWith('https:') ? '; Secure' : ''}`});
      }
      if (route === '/api/bootstrap' && method === 'GET') return json(200,{localDemo:config.localDemo});
      if (route.startsWith('/api/')) {
        const w = workspace(req); if (!w) fail(401,'Sign in with your workspace token');
        rate(`admin:${w.id}`,600);
        if (mutate && !String(req.headers['content-type'] || '').startsWith('application/json')) fail(415,'Use application/json');
        if (route === '/api/logout' && method === 'POST') {
          const sid = req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('signal_session='))?.slice(15);
          if (sid) run('DELETE FROM sessions WHERE id=?',hash(sid));
          return json(200,{ok:true},{'Set-Cookie':'signal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
        }
        if (route === '/api/state' && method === 'GET') {
          const visitors = all('SELECT v.*,s.name site_name,s.demo FROM visitors v JOIN sites s ON s.id=v.site_id WHERE v.workspace_id=? ORDER BY v.last_seen DESC LIMIT 500',w.id).map(publicVisitor);
          const offers = all('SELECT o.*,v.person,s.demo FROM offers o JOIN visitors v ON v.id=o.visitor_id JOIN sites s ON s.id=v.site_id WHERE o.workspace_id=? ORDER BY o.created DESC LIMIT 500',w.id).map(o=>({...o,person:o.person ? parse(o.person):null}));
          const stats = get("SELECT count(*) visits,count(DISTINCT visitor_id) unique_visitors FROM events WHERE workspace_id=?",w.id);
          return json(200,{advertising:ads.state(w.id),workspace:{id:w.id,name:w.name},sites:all('SELECT * FROM sites WHERE workspace_id=? ORDER BY created',w.id),visitors,offers,stats,campaign:get('SELECT * FROM campaigns WHERE workspace_id=?',w.id),geofences:all('SELECT * FROM geofences WHERE workspace_id=? ORDER BY created DESC',w.id).map(g=>({...g,plan:parse(g.plan)})),audit:all('SELECT * FROM audit WHERE workspace_id=? ORDER BY created DESC LIMIT 80',w.id),jobs:all('SELECT id,visitor_id,status,attempts,error,created,completed FROM jobs WHERE workspace_id=? ORDER BY created DESC LIMIT 100',w.id),config:{demo:config.localDemo,identityConfigured:Boolean(config.identityUrl&&config.identityKey),validationConfigured:Boolean(config.validationUrl&&config.validationKey),deliveryConfigured:Boolean(config.delivery&&config.outreachUrl&&config.outreachKey&&config.postalAddress),providerName:config.providerName,baseUrl:base(req)}});
        }
        if (route === '/api/workspaces' && method === 'POST') {
          if (w.id !== 'default') fail(403,'Only the bootstrap administrator can provision workspaces');
          const input = await body(req); if (!text(input.name,100).trim()) fail(400,'Workspace name required');
          const id = randomUUID(); const apiToken = randomBytes(32).toString('base64url');
          transaction(()=>{run('INSERT INTO workspaces VALUES(?,?,?)',id,text(input.name,100),hash(apiToken));initCampaign(id);audit(w.id,'Workspace provisioned',text(input.name,100));});
          return json(201,{id,name:input.name,token:apiToken});
        }
        if (route === '/api/sites' && method === 'POST') {
          const input = await body(req); let origin;
          try { const u = new URL(input.origin); if (!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||(u.pathname!=='/')) fail(400,'Use a website origin, e.g. https://store.example.com'); if (u.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(u.hostname)) fail(400,'Public websites must use HTTPS'); origin=u.origin; } catch(error) {if(error.status)throw error;fail(400,'Enter a valid website origin');}
          const name = text(input.name,100).trim();if(!name)fail(400,'Website name is required');
          const site={id:randomUUID(),workspace_id:w.id,name,origin,public_key:`pk_${randomBytes(18).toString('hex')}`,demo:0,created:now()};
          run('INSERT INTO sites VALUES(?,?,?,?,?,?,?)',...Object.values(site));audit(w.id,'Website connected',name);return json(201,site);
        }
        if (route === '/api/consent' && method === 'POST') {
          const input=await body(req);const site=get('SELECT * FROM sites WHERE id=? AND workspace_id=? AND demo=0',input.siteId,w.id);if(!site)fail(404,'Website not found');
          const receipt=consentReceipt(w.id,site.id,input);audit(w.id,'Consent recorded','First-party email permission recorded by authenticated customer backend');return json(201,{receipt});
        }
        if (route === '/api/pixel-consent' && method === 'POST') {
          const input=await body(req);const site=get('SELECT * FROM sites WHERE id=? AND workspace_id=? AND demo=0',input.siteId,w.id);if(!site)fail(404,'Website not found');
          if(input.collection!==true||!text(input.noticeVersion,100)||typeof input.subjectId!=='string'||input.subjectId.length<8||input.subjectId.length>120)fail(400,'Explicit collection permission, noticeVersion, and subjectId are required');
          return json(201,{receipt:token({purpose:'pixel_consent',siteId:site.id,subjectId:input.subjectId,noticeVersion:text(input.noticeVersion,100),exp:Date.now()+3600000})});
        }
        if (route === '/api/demo' && method === 'POST') {
          let site=get('SELECT * FROM sites WHERE workspace_id=? AND demo=1',w.id);
          if(!site){site={id:randomUUID(),workspace_id:w.id,name:'Demo storefront',origin:new URL(base(req)).origin,public_key:`demo_${randomBytes(12).toString('hex')}`,demo:1,created:now()};run('INSERT INTO sites VALUES(?,?,?,?,?,?,?)',...Object.values(site));}
          const batch=randomUUID();const results=[];
          for(let i=0;i<fixtures.length;i++){
            const f=fixtures[i];const subjectId=`demo-${batch}-${i}`;
            const receipt=f?.consent?consentReceipt(w.id,site.id,{subjectId,email:f.email,emailMarketing:true,noticeVersion:'demo-v1',source:'Synthetic signup form'},true):null;
            if(i===5&&f)run('INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)',w.id,'email',opaque(w.id,f.email),now());
            results.push(acceptEvent(site,{subjectId,eventId:randomUUID(),url:site.origin+['/products','/pricing','/services'][i%3],source:i%2?'geofence-demo':'google-display-demo',consent:{collection:true,noticeVersion:'demo-v1',emailReceipt:receipt},fixture:i},req,true));
          }
          audit(w.id,'Demo pipeline started','Six synthetic visits. No real consumer data or messages.');return json(202,{visitors:results});
        }
        if (route === '/api/campaign' && method === 'PATCH') {
          const input=await body(req);if(!text(input.name,100).trim()||!text(input.subject,200).trim()||!text(input.body,5000).trim()||typeof input.enabled!=='boolean')fail(400,'Name, subject, body and enabled are required');
          run('UPDATE campaigns SET name=?,subject=?,body=?,enabled=? WHERE workspace_id=?',text(input.name,100),text(input.subject,200),text(input.body,5000),Number(input.enabled),w.id);audit(w.id,'Offer campaign updated','Template applies to newly generated offers');return json(200,{ok:true});
        }
        if (route === '/api/geofences' && method === 'POST') {
          const plan=validateGeofence(await body(req));const id=randomUUID();run('INSERT INTO geofences VALUES(?,?,?,?)',id,w.id,JSON.stringify(plan),now());audit(w.id,'Geofencing plan saved',`${plan.name} — draft only`);return json(201,{id,plan});
        }
        const geo=route.match(/^\/api\/geofences\/([^/]+)(\/export)?$/);
        if(geo){const g=get('SELECT * FROM geofences WHERE id=? AND workspace_id=?',geo[1],w.id);if(!g)fail(404,'Plan not found');if(method==='GET'&&geo[2])return json(200,geojson(parse(g.plan)),{'Content-Disposition':'attachment; filename="geofence.geojson"'});if(method==='DELETE'){if(get('SELECT 1 FROM ad_campaigns WHERE geofence_id=? AND workspace_id=?',g.id,w.id))fail(409,'Geofence is attached to an ad campaign');run('DELETE FROM geofences WHERE id=?',g.id);audit(w.id,'Geofencing plan deleted','Draft removed');return json(200,{ok:true});}}
        const detail=route.match(/^\/api\/visitors\/([^/]+)(\/suppress)?$/);
        if(detail){const v=get('SELECT * FROM visitors WHERE id=? AND workspace_id=?',detail[1],w.id);if(!v)fail(404,'Visitor not found');
          if(method==='GET'&&!detail[2])return json(200,{visitor:publicVisitor(v),events:all('SELECT kind,page,source,created,campaign_id,ad_click_id FROM events WHERE visitor_id=? ORDER BY created DESC',v.id),offers:all('SELECT * FROM offers WHERE visitor_id=?',v.id),jobs:all('SELECT status,attempts,error,created,completed FROM jobs WHERE visitor_id=?',v.id)});
          if(method==='POST'&&detail[2]){transaction(()=>suppress(w.id,v));audit(w.id,'Visitor suppressed','Future enrichment and offers blocked');return json(200,{ok:true});}
          if(method==='DELETE'){transaction(()=>{suppress(w.id,v);run('DELETE FROM events WHERE visitor_id=?',v.id);run('DELETE FROM jobs WHERE visitor_id=?',v.id);run('DELETE FROM offers WHERE visitor_id=?',v.id);run('DELETE FROM visitors WHERE id=?',v.id);});audit(w.id,'Visitor erased','Contact and visit history removed; keyed suppression retained to prevent re-append');return json(200,{ok:true});}
        }
        const deliver=route.match(/^\/api\/offers\/([^/]+)\/deliver$/);
        if(deliver&&method==='POST'){
          const o=get('SELECT * FROM offers WHERE id=? AND workspace_id=?',deliver[1],w.id);if(!o)fail(404,'Offer not found');if(o.status!=='ready')fail(409,'Offer is not eligible for delivery');
          const v=get('SELECT v.*,s.demo FROM visitors v JOIN sites s ON s.id=v.site_id WHERE v.id=?',o.visitor_id);const p=parse(v.person);const receipt=verify(parse(v.consent).emailReceipt);const validation=parse(v.validation);
          if(v.demo||v.status==='suppressed'||suppressed(w.id,'email',p.email.toLowerCase())||!receipt||receipt.purpose!=='email_consent'||receipt.workspaceId!==w.id||receipt.siteId!==v.site_id||receipt.subject!==v.subject_key||receipt.email!==p.email.toLowerCase()||receipt.demo!==false||p.scope!=='person'||p.confidence<0.9||validation.email!=='valid'||!get('SELECT enabled FROM campaigns WHERE workspace_id=?',w.id).enabled)fail(409,'Contact is no longer eligible');
          if(!config.delivery||!config.outreachUrl||!config.outreachKey||!config.postalAddress)fail(409,'Configure a delivery gateway and sender postal address, then enable delivery');
          const unsubscribe=`${base(req)}/unsubscribe?token=${token({purpose:'unsubscribe',workspaceId:w.id,email:p.email.toLowerCase(),exp:Date.now()+365*86400000})}`;
          const claimed=run("UPDATE offers SET status='sending',reason='Delivery in progress' WHERE id=? AND status='ready'",o.id);if(!claimed.changes)fail(409,'Delivery already in progress');
          try {
            const result=await deliveryGateway(config.outreachUrl,config.outreachKey,{offerId:o.id,to:p.email,subject:o.subject,text:`Advertisement\n\n${o.body}\n\n${config.postalAddress}\nUnsubscribe: ${unsubscribe}`,unsubscribeUrl:unsubscribe,headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}},4500,o.id);
            if(result.accepted!==true)throw new Error('Delivery not acknowledged');
            run("UPDATE offers SET status='sent',reason='Delivery gateway accepted message' WHERE id=?",o.id);audit(w.id,'Offer delivered','Delivery gateway accepted offer');return json(200,{ok:true});
          }catch{run("UPDATE offers SET status='delivery_uncertain',reason='Provider outcome uncertain. Reconcile by offer ID before retrying.' WHERE id=?",o.id);fail(502,'Delivery outcome uncertain; check provider logs before retrying');}
        }
        fail(404,'Endpoint not found');
      }
      if(method!=='GET'&&method!=='HEAD')fail(405,'Method not allowed');
      const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/publisher':'publisher.html','/publisher.js':'publisher.js'};
      const asset=assets[route];if(!asset)fail(404,'Not found');
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
      res.writeHead(200,{'Content-Type':types[path.extname(asset)]});res.end(method==='HEAD'?undefined:readFileSync(path.join(root,'public',asset)));
    }catch(error){json(error.status||500,{error:error.status?error.message:'Server error'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  const worker=options.worker===false?null:setInterval(()=>{void processJob();},100);
  function cleanup(){
    run('DELETE FROM sessions WHERE expires<?',Date.now());
    const days=Math.max(1,Number(process.env.RETENTION_DAYS)||90);const cutoff=new Date(Date.now()-days*86400000).toISOString();
    transaction(()=>{const ids=all('SELECT id FROM visitors WHERE last_seen<?',cutoff);for(const v of ids){run('DELETE FROM events WHERE visitor_id=?',v.id);run('DELETE FROM offers WHERE visitor_id=?',v.id);run('DELETE FROM jobs WHERE visitor_id=?',v.id);run('DELETE FROM visitors WHERE id=?',v.id);}run('DELETE FROM audit WHERE created<?',cutoff);});
    run("UPDATE jobs SET status='failed',payload=NULL,error='Pending lookup expired' WHERE status='queued' AND created<?",new Date(Date.now()-86400000).toISOString());
  }
  cleanup();const retention=setInterval(cleanup,3600000);retention.unref();worker?.unref();
  return {server,config,db,processJob,async close(){closing=true;if(worker)clearInterval(worker);clearInterval(retention);await new Promise(resolve=>server.listening?server.close(resolve):resolve());while(workerBusy)await new Promise(r=>setTimeout(r,20));db.close();}};
}
