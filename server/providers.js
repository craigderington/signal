import { setTimeout as delay } from 'node:timers/promises';

export const fixtures = [
  { name: 'Alex Morgan', email: 'alex.morgan@example.com', phone: '+12025550101', city: 'Austin, TX', scope: 'person', confidence: 0.96, consent: true },
  { name: 'Jordan Lee', email: 'jordan.lee@example.com', phone: '+12025550102', city: 'Denver, CO', scope: 'person', confidence: 0.93, consent: false },
  { name: 'Taylor Brooks', email: 'taylor.brooks@example.com', phone: '+12025550103', city: 'Raleigh, NC', scope: 'household', confidence: 0.74, consent: true },
  { name: 'Sam Rivera', email: 'sam.rivera@example.com', phone: '+12025550104', city: 'Phoenix, AZ', scope: 'person', confidence: 0.98, consent: true },
  null,
  { name: 'Casey Ellis', email: 'casey.ellis@example.com', phone: '+12025550105', city: 'Portland, OR', scope: 'person', confidence: 0.91, consent: true },
];

export async function gateway(url, key, body, timeout = 4500, idempotencyKey) {
  if (!url || !key) throw new Error('Provider gateway is not configured');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Provider gateway must use HTTPS');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Provider gateway returned HTTP ${response.status}`);
  // Do not expose upstream response bodies: they can contain PII or secrets.
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 64000) { await reader.cancel(); throw new Error('Provider response exceeds limit'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function resolveIdentity(payload, config) {
  if (payload.demo) {
    await delay(180);
    const fixture = fixtures[payload.fixture % fixtures.length];
    return fixture ? { ...fixture, id: `demo-${payload.fixture % fixtures.length}`, provider: 'Demo identity graph', evidence: 'Synthetic fixture; no real individual identified', matchedAt: new Date().toISOString() } : null;
  }
  if (!config.identityUrl) return null;
  const response = await gateway(config.identityUrl, config.identityKey, {
    ip: payload.ip, subjectId: payload.subjectId, siteId: payload.siteId,
    timestamp: payload.timestamp, collectionConsent: payload.collectionConsent,
    // Raw page paths and contact information are deliberately not sent to the graph.
  });
  if (response.matched !== true) return null;
  const p = response.person;
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 200 || !['person', 'household'].includes(p.scope) || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1 || typeof p.evidence !== 'string' || !p.evidence.trim()) throw new Error('Provider returned invalid identity evidence');
  const clean = v => typeof v === 'string' ? v.slice(0, 300) : '';
  return { id: p.id, name: clean(p.name), email: clean(p.email).toLowerCase(), phone: clean(p.phone), city: clean(p.city), scope: p.scope, confidence: p.confidence, evidence: clean(p.evidence), provider: config.providerName, matchedAt: new Date().toISOString() };
}

export async function validateContact(person, demo, config) {
  if (demo) return { email: 'demo_valid', phone: person.phone ? 'demo_valid' : 'unknown', provider: 'Synthetic validator', checkedAt: new Date().toISOString() };
  if (!config.validationUrl) return { email: 'unverified', phone: 'unverified', provider: 'Not configured' };
  const result = await gateway(config.validationUrl, config.validationKey, { email: person.email, phone: person.phone }, 2000);
  const allowed = ['valid', 'invalid', 'unknown', 'catch_all'];
  return { email: allowed.includes(result.email) ? result.email : 'unknown', phone: allowed.includes(result.phone) ? result.phone : 'unknown', provider: 'Validation gateway', checkedAt: new Date().toISOString() };
}

export function validateGeofence(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) fail('Give the campaign a name (up to 100 characters)');
  if (!['native', 'google_radius', 'simplifi', 'groundtruth'].includes(input.provider)) fail('Choose a supported planning provider');
  if (!['retail', 'automotive', 'restaurant', 'commercial_event', 'other_commercial'].includes(input.category)) fail('Choose a commercial location category');
  if (!Number.isFinite(input.dailyBudget) || input.dailyBudget < 1 || input.dailyBudget > 100000) fail('Enter a daily budget between $1 and $100,000');
  if (input.shape === 'radius') {
    if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 85 || !Number.isFinite(input.lng) || Math.abs(input.lng) > 180) fail('Enter valid coordinates (latitude within ±85)');
    if (!Number.isFinite(input.radiusKm) || input.radiusKm < (input.provider === 'google_radius' ? 1 : 0.1) || input.radiusKm > 500) fail('Radius must be 1–500 km for Google, or 0.1–500 km for other plans');
  } else if (input.shape === 'polygon' && input.provider !== 'google_radius') {
    const ring = input.coordinates;
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 500 || ring.some(p => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || Math.abs(p[0]) > 180 || !Number.isFinite(p[1]) || Math.abs(p[1]) > 85)) fail('Provide a GeoJSON outer ring of 4–500 [longitude, latitude] points');
    if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) fail('Close the polygon by repeating its first point');
    if (new Set(ring.slice(0, -1).map(p => JSON.stringify(p))).size < 3) fail('Polygon needs at least three distinct vertices');
    const area = Math.abs(ring.slice(1).reduce((a,p,i) => a + ring[i][0] * p[1] - p[0] * ring[i][1],0));
    if (area < 1e-10) fail('Polygon must enclose an area');
    if (Math.max(...ring.map(p=>p[0]))-Math.min(...ring.map(p=>p[0]))>180) fail('Antimeridian-crossing polygons are not supported in this MVP');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const on=(a,b,p)=>Math.abs(cross(a,b,p))<1e-12&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]);
    const intersects=(a,b,c,d)=>{const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);return x*y<0&&z*w<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);};
    const n=ring.length-1;
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(j!==i+1&&!(i===0&&j===n-1)&&intersects(ring[i],ring[i+1],ring[j],ring[j+1]))fail('Polygon edges must not intersect');

  } else fail('Use a radius for Google, or a radius/polygon for DSP plans');
  return { name: input.name.trim(), provider: input.provider, category: input.category, dailyBudget: input.dailyBudget, shape: input.shape, ...(input.shape === 'radius' ? { lat: input.lat, lng: input.lng, radiusKm: input.radiusKm } : { coordinates: input.coordinates }), status: 'draft', targeting: 'presence', purpose: 'commercial advertising', note: 'Native ad serving supports this plan. External exchange buying is not connected.' };
}

export function geojson(plan) {
  let coordinates = plan.coordinates;
  if (plan.shape === 'radius') {
    coordinates = Array.from({ length: 65 }, (_, i) => {
      const angle = 2 * Math.PI * (i % 64) / 64;
      return [plan.lng + plan.radiusKm / (111.32 * Math.cos(plan.lat * Math.PI / 180)) * Math.cos(angle), plan.lat + plan.radiusKm / 111.32 * Math.sin(angle)];
    });
  }
  return { type: 'Feature', properties: { ...plan, coordinates: undefined, geometryNote: plan.shape === 'radius' ? 'Approximate visualization; use center and radius for platform targeting' : 'Validate geometry with the DSP before launch' }, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}
