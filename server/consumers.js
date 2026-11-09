import { randomUUID } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const stamp = () => new Date().toISOString();
const fieldLimits = { name: 100, phone: 40, city: 100, state: 40, postalCode: 20, country: 2 };
const authority = { crm: 1, manual: 2, form: 2 };
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function normalizeEmail(value) {
  if (typeof value !== 'string') fail(400, 'Email is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address');
  // Do not remove plus tags or dots: those rules are provider-specific.
  return email;
}

export function normalizeConsumer(input, sourceInput = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Expected a contact object');
  if (sourceInput == null) sourceInput = {};
  if (typeof sourceInput !== 'object' || Array.isArray(sourceInput)) fail(400, 'Source must be an object');
  const email = normalizeEmail(input.email);
  const fields = {};
  for (const [field, limit] of Object.entries(fieldLimits)) {
    if (!has(input, field) || input[field] === '' || input[field] == null) continue;
    if (typeof input[field] !== 'string' || input[field].trim().length > limit) fail(400, `${field} must be text up to ${limit} characters`);
    const value = input[field].trim();
    if (!value) continue;
    fields[field] = value;
  }
  if (fields.phone) {
    if (!/^[+\d().\s-]+$/.test(fields.phone)) fail(400, 'Phone must contain a phone number, without an extension');
    let phone = fields.phone.replace(/[().\s-]/g, '');
    if (/^\d{10}$/.test(phone)) phone = '+1' + phone;
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) fail(400, 'Use an international phone number or a 10-digit U.S. number');
    fields.phone = phone;
  }
  if (fields.country) {
    fields.country = fields.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(fields.country)) fail(400, 'Country must be a two-letter country code');
  }
  const type = sourceInput.type || 'manual';
  const name = sourceInput.name || 'Dashboard entry';
  if (!has(authority, type)) fail(400, 'Source type must be crm, form, or manual');
  if (typeof name !== 'string' || !name.trim() || name.length > 120) fail(400, 'Give the data source a name (up to 120 characters)');
  const observed = sourceInput.observedAt || stamp();
  const time = Date.parse(observed);
  if (typeof observed !== 'string' || !Number.isFinite(time) || time > Date.now() + 300000) fail(400, 'observedAt must be a valid timestamp, not in the future');
  const recordId = sourceInput.recordId || null;
  if (recordId && (typeof recordId !== 'string' || recordId.length > 120)) fail(400, 'Source recordId must be text up to 120 characters');
  return { email, fields, source: { type, name: name.trim(), observedAt: new Date(time).toISOString(), recordId, recordedAt: stamp() } };
}

export function parseCSV(content) {
  if (typeof content !== 'string') fail(400, 'CSV content must be text');
  const data = content.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false, closed = false;
  function cell() { row.push(value); value = ''; closed = false; }
  function finishRow() { cell(); if (row.some(v => v.trim())) rows.push(row); row = []; }
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (quoted) {
      if (char === '"') {
        if (data[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === '"') {
      if (value || closed) fail(400, 'Malformed CSV quote');
      quoted = true;
    } else if (char === ',') cell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && data[i + 1] === '\n') i++;
      finishRow();
    } else {
      if (closed && char.trim()) fail(400, 'Unexpected text after a quoted CSV field');
      if (!closed) value += char;
    }
    if (rows.length > 251 || row.length > 40) fail(400, 'Import at most 250 rows and 40 columns at a time');
  }
  if (quoted) fail(400, 'CSV has an unclosed quoted field');
  if (row.length || value || closed) finishRow();
  if (!rows.length) fail(400, 'CSV is empty');
  const headers = rows.shift().map(h => h.trim());
  const aliases = {
    email: 'email', emailaddress: 'email', name: 'name', fullname: 'name',
    firstname: 'firstName', lastname: 'lastName', phone: 'phone', phonenumber: 'phone',
    city: 'city', state: 'state', postalcode: 'postalCode', zip: 'postalCode', zipcode: 'postalCode',
    country: 'country', observedat: 'observedAt', updatedat: 'observedAt', externalid: 'recordId', recordid: 'recordId',
  };
  const mapped = headers.map(h => aliases[h.toLowerCase().replace(/[ _-]/g, '')] || null);
  const recognized = mapped.filter(Boolean);
  if (new Set(recognized).size !== recognized.length) fail(400, 'CSV contains duplicate mapped columns');
  if (!mapped.includes('email')) fail(400, 'CSV needs an email column');
  const records = rows.map((cells, index) => {
    if (cells.length !== headers.length) fail(400, `CSV row ${index + 2} has a different number of columns`);
    const record = {};
    cells.forEach((v, i) => { if (mapped[i]) record[mapped[i]] = v; });
    if (!record.name && (record.firstName || record.lastName)) record.name = [record.firstName, record.lastName].filter(Boolean).join(' ');
    return record;
  });
  return { records, ignoredHeaders: headers.filter((_, i) => !mapped[i]) };
}

export function createConsumerStore({ db, opaque, audit, transaction, body, identify, reEnrich, receiptEmail }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumers (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL,
      fields TEXT NOT NULL, provenance TEXT NOT NULL, status TEXT NOT NULL,
      created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(workspace_id,email)
    );
    CREATE TABLE IF NOT EXISTS consumer_links (
      visitor_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
      source TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consumer_history (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
      action TEXT NOT NULL, source TEXT NOT NULL, changes TEXT NOT NULL, created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consumer_source_refs (
      workspace_id TEXT NOT NULL, source_type TEXT NOT NULL, source_name TEXT NOT NULL,
      record_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,source_type,source_name,record_id)
    );
    CREATE INDEX IF NOT EXISTS consumer_link_owner ON consumer_links(workspace_id,consumer_id);
    CREATE INDEX IF NOT EXISTS consumer_history_owner ON consumer_history(workspace_id,consumer_id,created);
    CREATE INDEX IF NOT EXISTS consumers_owner ON consumers(workspace_id,updated);
  `);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const isSuppressed = (workspaceId, email) => Boolean(get("SELECT 1 FROM suppressions WHERE workspace_id=? AND kind='email' AND value=?", workspaceId, opaque(workspaceId, email)));
  function record(row) {
    if (!row) return null;
    return { id: row.id, email: row.email, ...JSON.parse(row.fields), provenance: JSON.parse(row.provenance),
      status: row.status, created: row.created, updated: row.updated,
      linkedVisitors: get('SELECT count(*) n FROM consumer_links WHERE consumer_id=? AND workspace_id=?', row.id, row.workspace_id).n,
      identityMethod: 'customer_provided', verification: 'not_verified_by_import' };
  }
  function find(workspaceId, id) { return record(get('SELECT * FROM consumers WHERE id=? AND workspace_id=?', id, workspaceId)); }
  function forVisitor(workspaceId, visitorId) {
    const row = get('SELECT c.* FROM consumers c JOIN consumer_links l ON l.consumer_id=c.id AND l.workspace_id=c.workspace_id WHERE l.visitor_id=? AND c.workspace_id=?', visitorId, workspaceId);
    return record(row);
  }
  function checkReferences(workspaceId, normalized) {
    if (isSuppressed(workspaceId, normalized.email)) fail(409, 'Contact is suppressed; importing cannot restore outreach permission');
    const s = normalized.source;
    if (s.recordId) {
      const ref = get('SELECT c.email FROM consumer_source_refs r JOIN consumers c ON c.id=r.consumer_id WHERE r.workspace_id=? AND r.source_type=? AND r.source_name=? AND r.record_id=?', workspaceId, s.type, s.name, s.recordId);
      if (ref && ref.email !== normalized.email) fail(409, 'Source record email changed; review the contact rather than merging automatically');
    }
  }
  function apply(workspaceId, normalized) {
    checkReferences(workspaceId, normalized);
    const old = get('SELECT * FROM consumers WHERE workspace_id=? AND email=?', workspaceId, normalized.email);
    if (old?.status === 'suppressed') fail(409, 'Contact is suppressed');
    const id = old?.id || randomUUID();
    const values = old ? JSON.parse(old.fields) : {};
    const provenance = old ? JSON.parse(old.provenance) : { email: normalized.source };
    const changes = [];
    let changed = !old;
    for (const [field, incoming] of Object.entries(normalized.fields)) {
      const previous = provenance[field];
      const canReplace = !previous || Date.parse(normalized.source.observedAt) >= Date.parse(previous.observedAt) && authority[normalized.source.type] >= authority[previous.type];
      if (canReplace) {
        if (values[field] !== incoming || !previous || previous.type !== normalized.source.type || previous.name !== normalized.source.name || previous.observedAt !== normalized.source.observedAt) {
          values[field] = incoming;
          provenance[field] = normalized.source;
          changes.push({ field, outcome: 'updated', previousSource: previous || null });
          changed = true;
        }
      } else if (values[field] !== incoming) changes.push({ field, outcome: 'retained', previousSource: previous });
    }
    const revision = old && stamp() <= old.updated ? new Date(Date.parse(old.updated) + 1).toISOString() : stamp();
    if (!old) run('INSERT INTO consumers VALUES(?,?,?,?,?,?,?,?)', id, workspaceId, normalized.email, JSON.stringify(values), JSON.stringify(provenance), 'active', revision, revision);
    else if (changed) run('UPDATE consumers SET fields=?,provenance=?,updated=? WHERE id=? AND workspace_id=?', JSON.stringify(values), JSON.stringify(provenance), revision, id, workspaceId);
    if (normalized.source.recordId) run('INSERT OR IGNORE INTO consumer_source_refs VALUES(?,?,?,?,?)', workspaceId, normalized.source.type, normalized.source.name, normalized.source.recordId, id);
    run('INSERT INTO consumer_history VALUES(?,?,?,?,?,?,?)', randomUUID(), workspaceId, id, old ? changed ? 'updated' : 'reviewed' : 'created', JSON.stringify(normalized.source), JSON.stringify(changes), stamp());
    return { consumer: find(workspaceId, id), outcome: !old ? 'created' : changed ? 'updated' : 'unchanged', conflicts: changes.filter(c => c.outcome === 'retained').length };
  }
  function upsert(workspaceId, contact, source) {
    const normalized = normalizeConsumer(contact, source);
    return transaction(() => apply(workspaceId, normalized));
  }
  function importPreview(workspaceId, input) {
    if (!input || typeof input.content !== 'string' || input.content.length > 200000) fail(400, 'Provide import content up to 200,000 characters');
    if (typeof input.sourceName !== 'string' || !input.sourceName.trim() || input.sourceName.length > 120) fail(400, 'Give the CRM source a name');
    let records, ignoredHeaders = [];
    if (input.format === 'csv') ({ records, ignoredHeaders } = parseCSV(input.content));
    else if (input.format === 'json') {
      try { records = JSON.parse(input.content); } catch { fail(400, 'Invalid JSON import'); }
    } else fail(400, 'Choose CSV or JSON import');
    if (!Array.isArray(records) || records.length < 1 || records.length > 250) fail(400, 'Import between 1 and 250 contacts at a time');
    const normalized = [], issues = [], seen = new Set(), refs = new Map();
    records.forEach((row, index) => {
      try {
        const n = normalizeConsumer(row, { type: 'crm', name: input.sourceName, observedAt: row?.observedAt, recordId: row?.recordId });
        if (seen.has(n.email)) fail(400, 'Email appears more than once in this batch');
        seen.add(n.email);
        if (n.source.recordId) {
          if (refs.has(n.source.recordId) && refs.get(n.source.recordId) !== n.email) fail(400, 'Source recordId appears with different emails');
          refs.set(n.source.recordId, n.email);
        }
        checkReferences(workspaceId, n);
        normalized.push(n);
      } catch (error) { issues.push({ row: index + (input.format === 'csv' ? 2 : 1), message: error.status ? error.message : 'Invalid contact record' }); }
    });
    const existing = normalized.filter(n => get('SELECT 1 FROM consumers WHERE workspace_id=? AND email=?', workspaceId, n.email)).length;
    return { normalized, issues, ignoredHeaders, total: records.length, existing, newContacts: normalized.length - existing };
  }
  function importRecords(workspaceId, input) {
    const preview = importPreview(workspaceId, input);
    if (preview.issues.length) fail(400, `Import has ${preview.issues.length} invalid row(s). Preview and correct them first; no contacts were imported.`);
    return transaction(() => {
      const result = { total: preview.total, created: 0, updated: 0, unchanged: 0, conflicts: 0 };
      for (const n of preview.normalized) { const applied = apply(workspaceId, n); result[applied.outcome]++; result.conflicts += applied.conflicts; }
      audit(workspaceId, 'CRM contacts imported', `${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged; ${result.conflicts} source conflicts retained`);
      return result;
    });
  }
  function list(workspaceId) { return all('SELECT * FROM consumers WHERE workspace_id=? ORDER BY updated DESC LIMIT 500', workspaceId).map(record); }
  function matchVisitor(workspaceId, visitorId) {
    const consumer = forVisitor(workspaceId, visitorId);
    if (!consumer || consumer.status !== 'active' || isSuppressed(workspaceId, consumer.email)) return null;
    const link = get('SELECT source FROM consumer_links WHERE visitor_id=? AND workspace_id=?', visitorId, workspaceId);
    const source = JSON.parse(link.source);
    return { id: consumer.id, consumerId: consumer.id, consumerRevision: consumer.updated,
      name: consumer.name || '', email: consumer.email, phone: consumer.phone || '',
      city: [consumer.city, consumer.state].filter(Boolean).join(', '), postalCode: consumer.postalCode || '', country: consumer.country || '',
      scope: 'person', confidence: null, method: 'customer_provided', provider: 'Customer-owned records',
      evidence: `Authenticated customer association via ${source.name}. Customer-provided identity; ownership and deliverability are not verified by import.`,
      provenance: consumer.provenance, matchedAt: stamp() };
  }
  function isCurrentAssociation(workspaceId, visitorId, person) {
    if (person?.method !== 'customer_provided') return false;
    const contact = forVisitor(workspaceId, visitorId);
    return Boolean(contact && contact.status === 'active' && contact.id === person.consumerId && contact.updated === person.consumerRevision && contact.email === person.email && !isSuppressed(workspaceId, contact.email));
  }
  function link(workspaceId, visitor, consumer, source) {
    const existing = get('SELECT consumer_id FROM consumer_links WHERE visitor_id=? AND workspace_id=?', visitor.id, workspaceId);
    if (existing && existing.consumer_id !== consumer.id) fail(409, 'This session is already associated with another contact; start a new consented session');
    if (consumer.status !== 'active' || isSuppressed(workspaceId, consumer.email)) fail(409, 'Contact is suppressed');
    const time = stamp();
    run('INSERT INTO consumer_links VALUES(?,?,?,?,?,?) ON CONFLICT(visitor_id) DO UPDATE SET source=excluded.source,updated=excluded.updated', visitor.id, workspaceId, consumer.id, JSON.stringify(source), time, time);
    run('INSERT INTO consumer_history VALUES(?,?,?,?,?,?,?)', randomUUID(), workspaceId, consumer.id, 'visitor_linked', JSON.stringify(source), '[]', time);
  }
  function associatedVisitors(workspaceId, email) {
    const rows = all('SELECT v.*,c.email linked_email FROM visitors v LEFT JOIN consumer_links l ON l.visitor_id=v.id AND l.workspace_id=v.workspace_id LEFT JOIN consumers c ON c.id=l.consumer_id AND c.workspace_id=l.workspace_id WHERE v.workspace_id=?', workspaceId);
    return rows.filter(v => v.linked_email === email || (v.person && JSON.parse(v.person).email?.trim().toLowerCase() === email) || receiptEmail?.(JSON.parse(v.consent).emailReceipt) === email);
  }
  function suppressEmail(workspaceId, email) {
    email = normalizeEmail(email);
    run("INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)", workspaceId, 'email', opaque(workspaceId, email), stamp());
    run("UPDATE consumers SET status='suppressed' WHERE workspace_id=? AND email=?", workspaceId, email);
    const visitors = associatedVisitors(workspaceId, email);
    for (const visitor of visitors) {
      run('INSERT OR IGNORE INTO suppressions VALUES(?,?,?,?)', workspaceId, 'subject', visitor.subject_key, stamp());
      run("UPDATE visitors SET status='suppressed' WHERE id=?", visitor.id);
      run("UPDATE jobs SET status='cancelled',payload=NULL WHERE visitor_id=? AND status IN ('queued','processing')", visitor.id);
      run("UPDATE offers SET status='blocked',reason='Contact opted out or was suppressed' WHERE visitor_id=? AND status NOT IN ('sent','simulated_sent','sending','delivery_uncertain')", visitor.id);
    }
  }
  function erase(workspaceId, consumerId) {
    const consumer = find(workspaceId, consumerId);
    if (!consumer) fail(404, 'Consumer not found');
    return transaction(() => {
      suppressEmail(workspaceId, consumer.email);
      const visitors = associatedVisitors(workspaceId, consumer.email);
      for (const visitor of visitors) {
        for (const table of ['events', 'jobs', 'offers', 'consumer_links']) run(`DELETE FROM ${table} WHERE visitor_id=? AND workspace_id=?`, visitor.id, workspaceId);
        run('DELETE FROM visitors WHERE id=? AND workspace_id=?', visitor.id, workspaceId);
      }
      run('DELETE FROM consumer_links WHERE consumer_id=? AND workspace_id=?', consumerId, workspaceId);
      run('DELETE FROM consumer_source_refs WHERE consumer_id=? AND workspace_id=?', consumerId, workspaceId);
      run('DELETE FROM consumer_history WHERE consumer_id=? AND workspace_id=?', consumerId, workspaceId);
      run('DELETE FROM consumers WHERE id=? AND workspace_id=?', consumerId, workspaceId);
      audit(workspaceId, 'Consumer erased', 'Customer record and associated visitor data removed; keyed suppression retained');
      return { ok: true };
    });
  }
  async function handle(req, res, url, workspace) {
    const route = url.pathname, method = req.method, w = workspace.id;
    if (!route.startsWith('/api/consumers') && route !== '/api/identify' && !/^\/api\/visitors\/[^/]+\/enrich$/.test(route)) return false;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return true; };
    if (route === '/api/consumers' && method === 'GET') return json(200, { consumers: list(w) });
    if (route === '/api/consumers' && method === 'POST') {
      const input = await body(req);
      const result = upsert(w, input.contact || input, input.source);
      audit(w, 'Customer record saved', `Customer-owned contact ${result.outcome}; no outreach permission inferred`);
      return json(result.outcome === 'created' ? 201 : 200, result);
    }
    if (['/api/consumers/import-preview', '/api/consumers/import'].includes(route) && method === 'POST') {
      const input = await body(req, 500000);
      if (route.endsWith('import-preview')) {
        const p = importPreview(w, input);
        return json(200, { total: p.total, newContacts: p.newContacts, existing: p.existing, issues: p.issues, ignoredHeaders: p.ignoredHeaders,
          preview: p.normalized.slice(0, 5).map(n => ({ email: n.email, ...n.fields, source: n.source })) });
      }
      return json(201, importRecords(w, input));
    }
    if (route === '/api/identify' && method === 'POST') return json(200, identify(w, await body(req)));
    const enrich = route.match(/^\/api\/visitors\/([^/]+)\/enrich$/);
    if (enrich && method === 'POST') return json(202, reEnrich(w, enrich[1]));
    const detail = route.match(/^\/api\/consumers\/([^/]+)(\/suppress)?$/);
    if (detail) {
      const consumer = find(w, detail[1]);
      if (!consumer) fail(404, 'Consumer not found');
      if (method === 'GET' && !detail[2]) return json(200, { consumer,
        history: all('SELECT action,source,changes,created FROM consumer_history WHERE consumer_id=? AND workspace_id=? ORDER BY created DESC LIMIT 50', consumer.id, w).map(h => ({ ...h, source: JSON.parse(h.source), changes: JSON.parse(h.changes) })),
        visitors: all('SELECT v.id,v.status,v.first_seen,v.last_seen,s.name site_name FROM consumer_links l JOIN visitors v ON v.id=l.visitor_id JOIN sites s ON s.id=v.site_id WHERE l.consumer_id=? AND l.workspace_id=? ORDER BY v.last_seen DESC LIMIT 100', consumer.id, w) });
      if (method === 'PATCH' && !detail[2]) {
        const input = await body(req);
        if (has(input, 'email') && normalizeEmail(input.email) !== consumer.email) fail(409, 'Primary email changes require review; this endpoint cannot merge identities');
        const result = upsert(w, { ...input, email: consumer.email }, { type: 'manual', name: 'Dashboard correction' });
        audit(w, 'Customer record updated', 'Customer-owned fields updated with provenance');
        return json(200, result);
      }
      if (method === 'POST' && detail[2]) {
        transaction(() => suppressEmail(w, consumer.email));
        audit(w, 'Consumer suppressed', 'All associated sessions and future appends blocked');
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && !detail[2]) return json(200, erase(w, consumer.id));
    }
    fail(404, 'Consumer endpoint not found');
  }
  return { list, find, forVisitor, upsert, link, matchVisitor, isCurrentAssociation, suppressEmail, erase, handle };
}
