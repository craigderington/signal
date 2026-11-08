import { randomUUID, randomBytes } from 'node:crypto';
import { locationMatches } from './geo.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now=()=>new Date().toISOString();
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
export function createAdEngine({db,token,verify,rate,audit,body,workspace,base}){
  db.exec(`CREATE TABLE IF NOT EXISTS placements(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,origin TEXT NOT NULL,public_key TEXT UNIQUE NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ad_campaigns(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,headline TEXT NOT NULL,description TEXT NOT NULL,landing_url TEXT NOT NULL,color TEXT NOT NULL,geofence_id TEXT,cpm_micros INTEGER NOT NULL,total_micros INTEGER NOT NULL,daily_micros INTEGER NOT NULL,spent_micros INTEGER NOT NULL DEFAULT 0,day_spent_micros INTEGER NOT NULL DEFAULT 0,day TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ad_ledger(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,campaign_id TEXT NOT NULL,placement_id TEXT NOT NULL,cost_micros INTEGER NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,day TEXT NOT NULL,created TEXT NOT NULL,impression_at TEXT,click_at TEXT);
    CREATE INDEX IF NOT EXISTS ledger_pending ON ad_ledger(campaign_id,status,expires);
    CREATE INDEX IF NOT EXISTS ledger_workspace ON ad_ledger(workspace_id,created);`);
  const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  function selectAd(placement,location,consent){
    const t=Date.now(),day=now().slice(0,10);
    return tx(()=>{
      run("UPDATE ad_ledger SET status='expired' WHERE status='reserved' AND expires<=?",t);
      run('UPDATE ad_campaigns SET day=?,day_spent_micros=0 WHERE day!=?',day,day);
      const campaigns=all("SELECT * FROM ad_campaigns WHERE workspace_id=? AND status='active' ORDER BY cpm_micros DESC,created",placement.workspace_id);
      for(const c of campaigns){
        if(c.geofence_id){const fence=get('SELECT plan FROM geofences WHERE id=? AND workspace_id=?',c.geofence_id,c.workspace_id);if(!consent||!fence||!locationMatches(JSON.parse(fence.plan),location))continue;}
        const pending=get("SELECT COALESCE(sum(cost_micros),0) amount FROM ad_ledger WHERE campaign_id=? AND status='reserved' AND expires>?",c.id,t).amount;
        const cost=Math.round(c.cpm_micros/1000);
        if(c.spent_micros+pending+cost>c.total_micros||c.day_spent_micros+pending+cost>c.daily_micros)continue;
        const id=randomUUID();const midnight=Date.parse(day+'T00:00:00.000Z')+86400000;
        const expires=Math.min(t+120000,midnight);
        run('INSERT INTO ad_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,c.workspace_id,c.id,placement.id,cost,'reserved',expires,day,now(),null,null);
        const signed=token({purpose:'ad_event',id,exp:expires});
        const clickToken=token({purpose:'ad_click',id,exp:t+7*86400000});
        return {id,campaignId:c.id,headline:c.headline,description:c.description,color:c.color,impressionPath:`/ads/impression?token=${signed}`,clickPath:`/ads/click?token=${clickToken}`,framePath:`/ads/frame?token=${signed}`,expiresAt:expires};
      }
      return null;
    });
  }
  function state(w){return {placements:all('SELECT * FROM placements WHERE workspace_id=? ORDER BY created DESC',w),campaigns:all(`SELECT c.*, (SELECT count(*) FROM ad_ledger l WHERE l.campaign_id=c.id AND l.impression_at IS NOT NULL) impressions,(SELECT count(*) FROM ad_ledger l WHERE l.campaign_id=c.id AND l.click_at IS NOT NULL) clicks,(SELECT count(DISTINCT e.visitor_id) FROM events e WHERE e.campaign_id=c.id) attributed_visits FROM ad_campaigns c WHERE c.workspace_id=? ORDER BY c.created DESC`,w),ledger:all("SELECT l.id,l.campaign_id,l.status,l.cost_micros,l.impression_at,l.click_at,c.name campaign_name FROM ad_ledger l JOIN ad_campaigns c ON c.id=l.campaign_id WHERE l.workspace_id=? AND l.status='shown' ORDER BY l.created DESC LIMIT 50",w)};}
  async function handle(req,res,url){
    const route=url.pathname,method=req.method;
    const json=(status,payload,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(payload));};
    if(route==='/adtag.js'){
      const js=`(()=>{const s=document.currentScript,origin=new URL(s.src).origin,key=s.dataset.placement;fetch(origin+'/ads/request?placement='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(r=>r.json()).then(({ad})=>{if(!ad)return;const frame=document.createElement('iframe');frame.src=origin+ad.framePath;frame.title='Advertisement';frame.width='300';frame.height='280';frame.setAttribute('frameborder','0');frame.setAttribute('scrolling','no');s.before(frame);}).catch(()=>{});})();`;
      res.writeHead(200,{'Content-Type':'text/javascript','Access-Control-Allow-Origin':'*'});res.end(js);return true;
    }
    if(route==='/ad.css'){
      const color=/^#[0-9a-f]{6}$/i.test(url.searchParams.get('color')||'')?url.searchParams.get('color'):'#1b5c49';
      res.writeHead(200,{'Content-Type':'text/css'});res.end(`*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:${color};color:#fff}a{display:block;min-height:280px;padding:25px;color:inherit;text-decoration:none}small{font-size:9px;letter-spacing:1px;opacity:.75}h2{font-size:26px;font-weight:500;line-height:1.2;margin:24px 0 12px}p{font-size:12px;line-height:1.6;opacity:.85}strong{font-size:12px;display:block;margin-top:22px}`);return true;
    }
    if(route==='/ads/frame'){
      const signed=verify(url.searchParams.get('token'));if(!signed||signed.purpose!=='ad_event')fail(403,'Invalid or expired frame');
      const ledger=get('SELECT * FROM ad_ledger WHERE id=?',signed.id);if(!ledger)fail(404,'Ad reservation not found');
      const c=get('SELECT * FROM ad_campaigns WHERE id=?',ledger.campaign_id),p=get('SELECT * FROM placements WHERE id=?',ledger.placement_id);
      const impression='/ads/impression?token='+encodeURIComponent(url.searchParams.get('token'));
      const click='/ads/click?token='+token({purpose:'ad_click',id:ledger.id,exp:Date.now()+7*86400000});
      res.removeHeader('X-Frame-Options');res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors ${p.origin}; base-uri 'none'`);
      res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Advertisement</title><link rel="stylesheet" href="/ad.css?color=${encodeURIComponent(c.color)}"></head><body><a href="${esc(click)}" target="_blank" rel="noopener sponsored"><small>ADVERTISEMENT</small><h2>${esc(c.headline)}</h2><p>${esc(c.description)}</p><strong>Learn more →</strong></a><img src="${esc(impression)}" width="1" height="1" alt=""></body></html>`);return true;
    }
    if(route==='/ads/request'){
      const p=get('SELECT * FROM placements WHERE public_key=?',url.searchParams.get('placement')||'');if(!p)fail(404,'Unknown placement');
      if(req.headers.origin!==p.origin)fail(403,'Publisher origin does not match placement');
      res.setHeader('Access-Control-Allow-Origin',p.origin);res.setHeader('Vary','Origin');
      if(method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end();return true;}
      if(method!=='POST')fail(405,'Use POST');rate(`ads:${p.id}`,1000);
      const input=await body(req);const consent=input.consent?.location===true && input.consent?.noticeVersion && input.gpc!==true && req.headers['sec-gpc']!=='1';
      json(200,{ad:selectAd(p,consent?input.location:null,Boolean(consent))});return true;
    }
    if(route==='/ads/impression'||route==='/ads/click'){
      if(method!=='GET')fail(405,'Use GET');const signed=verify(url.searchParams.get('token'));if(!signed||signed.purpose!==(route==='/ads/click'?'ad_click':'ad_event'))fail(403,'Invalid or expired ad token');
      const ledger=get('SELECT * FROM ad_ledger WHERE id=?',signed.id);if(!ledger)fail(404,'Ad reservation not found');
      const c=get('SELECT * FROM ad_campaigns WHERE id=?',ledger.campaign_id);
      if(route==='/ads/impression'){
        tx(()=>{
          const fresh=get('SELECT * FROM ad_ledger WHERE id=?',ledger.id);
          if(fresh.status!=='reserved'||fresh.expires<=Date.now()||c.status!=='active')return;
          const charged=run('UPDATE ad_campaigns SET spent_micros=spent_micros+?,day_spent_micros=day_spent_micros+? WHERE id=? AND spent_micros+?<=total_micros AND day_spent_micros+?<=daily_micros AND day=?',fresh.cost_micros,fresh.cost_micros,c.id,fresh.cost_micros,fresh.cost_micros,fresh.day);
          if(charged.changes)run("UPDATE ad_ledger SET status='shown',impression_at=? WHERE id=?",now(),fresh.id);
        });
        res.writeHead(200,{'Content-Type':'image/gif','Cache-Control':'no-store'});res.end(gif);return true;
      }
      run("UPDATE ad_ledger SET click_at=COALESCE(click_at,?) WHERE id=? AND status='shown'",now(),ledger.id);
      const target=new URL(c.landing_url);if(get("SELECT 1 FROM ad_ledger WHERE id=? AND status='shown' AND click_at IS NOT NULL",ledger.id))target.searchParams.set('signal_click',token({purpose:'attribution',workspaceId:c.workspace_id,ledgerId:ledger.id,exp:Date.now()+30*86400000}));
      res.writeHead(302,{Location:target.href,'Cache-Control':'no-store'});res.end();return true;
    }
    if(!route.startsWith('/api/ads/'))return false;
    const w=workspace(req);if(!w)fail(401,'Sign in with your workspace token');
    rate(`admin:${w.id}`,600);
    if(method!=='GET'&&!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'Use application/json');
    if(route==='/api/ads/placements'&&method==='POST'){
      const input=await body(req);let origin;try{const u=new URL(input.origin);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();if(u.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(u.hostname))throw Error();origin=u.origin;}catch{fail(400,'Enter a valid HTTPS publisher origin, or localhost');}
      if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)fail(400,'Placement name is required');
      const id=randomUUID(),key='pl_'+randomBytes(18).toString('hex');run('INSERT INTO placements VALUES(?,?,?,?,?,?)',id,w.id,input.name,origin,key,now());audit(w.id,'Publisher placement added',input.name);json(201,{id,public_key:key});return true;
    }
    if(route==='/api/ads/campaigns'&&method==='POST'){
      const input=await body(req);for(const [field,max] of [['name',100],['headline',100],['description',250]])if(typeof input[field]!=='string'||!input[field].trim()||input[field].length>max)fail(400,`${field} is required (up to ${max} characters)`);
      let landing;try{landing=new URL(input.landingUrl);if(!['https:','http:'].includes(landing.protocol)||landing.username||landing.password)throw Error();if(landing.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(landing.hostname))throw Error();}catch{fail(400,'Enter a valid HTTPS landing page, or localhost');}
      for(const key of ['cpm','totalBudget','dailyBudget'])if(!Number.isFinite(input[key])||input[key]<=0||input[key]>100000)fail(400,`Invalid ${key}`);
      if(input.cpm<0.01||input.dailyBudget>input.totalBudget)fail(400,'CPM must be at least $0.01; daily budget cannot exceed total');
      if(input.geofenceId&&!get('SELECT id FROM geofences WHERE id=? AND workspace_id=?',input.geofenceId,w.id))fail(400,'Geofence not found');
      if(!/^#[0-9a-f]{6}$/i.test(input.color||''))fail(400,'Choose a hex creative color');
      const id=randomUUID();run('INSERT INTO ad_campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,w.id,input.name,input.headline,input.description,landing.href,input.color,input.geofenceId||null,Math.round(input.cpm*1e6),Math.round(input.totalBudget*1e6),Math.round(input.dailyBudget*1e6),0,0,now().slice(0,10),'paused',now());
      audit(w.id,'Ad campaign created',`${input.name} — paused`);json(201,{id});return true;
    }
    const campaign=route.match(/^\/api\/ads\/campaigns\/([^/]+)$/);
    if(campaign&&method==='PATCH'){
      const c=get('SELECT * FROM ad_campaigns WHERE id=? AND workspace_id=?',campaign[1],w.id);if(!c)fail(404,'Campaign not found');const input=await body(req);if(!['active','paused'].includes(input.status))fail(400,'Use active or paused');run('UPDATE ad_campaigns SET status=? WHERE id=?',input.status,c.id);audit(w.id,'Ad campaign '+input.status,c.name);json(200,{ok:true});return true;
    }
    if(route==='/api/ads/evaluate'&&method==='POST'){
      const input=await body(req);const plans=all('SELECT id,plan FROM geofences WHERE workspace_id=?',w.id);json(200,{matches:plans.filter(p=>locationMatches(JSON.parse(p.plan),input.location)).map(p=>({id:p.id,name:JSON.parse(p.plan).name})),note:'Synthetic test only. Coordinates are evaluated in memory and not retained.'});return true;
    }
    if(route==='/api/ads/sandbox'&&method==='POST'){
      let p=get('SELECT * FROM placements WHERE workspace_id=? AND name=?',w.id,'Local publisher sandbox');
      if(!p){const id=randomUUID(),key='pl_'+randomBytes(18).toString('hex');run('INSERT INTO placements VALUES(?,?,?,?,?,?)',id,w.id,'Local publisher sandbox',new URL(base(req)).origin,key,now());p=get('SELECT * FROM placements WHERE id=?',id);}
      const input=await body(req);const ad=selectAd(p,input.location,true);json(200,{ad,placement:p,note:'Internal demonstration; no exchange media is purchased.'});return true;
    }
    fail(404,'Ad endpoint not found');
  }
  return {handle,state,selectAd};
}
