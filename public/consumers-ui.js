export function createConsumersUI({ getState, api, esc, icon, button, heading, empty, badge, date, field, textarea, select, modal, formSubmit, infoModal, toast, download, refresh, openDrawer, closeDrawer }) {
  let query = '';
  const profileFields = ['name', 'phone', 'city', 'state', 'postalCode', 'country'];
  const labels = { name: 'Full name', email: 'Email', phone: 'Phone', city: 'City', state: 'State / region', postalCode: 'Postal code', country: 'Country code' };
  const sources = contact => [...new Set(Object.values(contact.provenance).map(p => p.name))].join(' · ');
  function table(contacts) {
    return `<div class="table-scroll"><table><thead><tr><th>Consumer</th><th>Phone</th><th>Data sources</th><th>Sessions</th><th>Record status</th><th>Updated</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>${contacts.map(c => `<tr><td><div class="person-cell"><span class="avatar">${esc(c.name?.split(' ').map(p => p[0]).slice(0,2).join('') || '@')}</span><div><button class="text-button person-name" data-action="consumer-detail" data-id="${c.id}">${esc(c.name || c.email)}</button><small>${esc(c.email)}</small></div></div></td><td>${esc(c.phone || '—')}</td><td class="consumer-source-cell">${esc(sources(c))}</td><td>${c.linkedVisitors}</td><td>${badge(c.status)}</td><td class="muted nowrap">${date(c.updated)}</td><td><button class="icon-button" data-action="consumer-detail" data-id="${c.id}" aria-label="View consumer">${icon('arrow',17)}</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function filtered() {
    return (getState().consumers || []).filter(c => [c.name, c.email, c.phone, c.city, sources(c)].join(' ').toLowerCase().includes(query.toLowerCase()));
  }
  function render() {
    const state = getState(), contacts = filtered();
    return `${heading('Your customer knowledge, connected.','Customer-owned contacts, field-level sources, and associated website sessions.',button('consumer-import','Import CRM data','secondary','','download') + button('consumer-new','Add consumer','primary','','plus'))}<div class="notice">${icon('shield',18)}<span>Customer-provided records stay separate from anonymous identity matches. Imports do not verify contact ownership, validate deliverability, or grant outreach permission.</span></div><section class="panel"><div class="table-toolbar"><label class="search-label"><span class="sr-only">Search consumers</span><input id="consumer-search" type="search" placeholder="Search name, email, phone, or source…" value="${esc(query)}"></label><span class="small-chip">${state.consumerCount || 0} CUSTOMER RECORDS</span></div><div id="consumer-results">${contacts.length ? table(contacts) : empty('Build on the data your customers already own.','Add a contact or import a CRM export. Associate a website session after a customer identifies themselves.','consumer-import','Import customer data','users')}</div></section><section class="panel explanation"><h2>One consumer, many observed visits.</h2><p>A CRM record is a contact in your directory. A website visit remains anonymous until your authenticated backend associates a form submission or known session with that contact. We never merge people because they share an IP address.</p><p>Each field records its source and observation time. Newer form corrections are protected from lower-authority CRM overwrites; older exports can still fill empty fields.</p></section><p class="footnote">Showing the latest 500 customer records. Source data is stored locally within this client workspace. Anonymous-provider matching remains a separate, replaceable integration.</p>`;
  }
  function bindPage() {
    const search = document.querySelector('#consumer-search');
    if (search) search.oninput = () => {
      query = search.value;
      const contacts = filtered();
      document.querySelector('#consumer-results').innerHTML = contacts.length ? table(contacts) : empty('No matching consumers.','Try a different search.',null,null,'users');
    };
  }
  function visitorActions(visitor, consumer) {
    if (visitor.demo || visitor.status === 'suppressed') return '';
    return consumer
      ? button('consumer-detail','Open consumer','secondary',`data-id="${consumer.id}"`) + button('consumer-refresh','Refresh from directory','secondary',`data-id="${visitor.id}"`)
      : button('consumer-link','Link known consumer','secondary',`data-id="${visitor.id}"`);
  }
  async function detail(id) {
    const result = await api('/api/consumers/' + id), c = result.consumer;
    const provenance = Object.entries(c.provenance).map(([key, p]) => `<div class="provenance-row"><div><strong>${esc(labels[key] || key)}</strong><span>${esc(key === 'email' ? c.email : c[key] || '—')}</span></div><small>${esc(p.name)} · ${esc(p.type)}<br>Observed ${date(p.observedAt)}${p.recordId ? '<br>Source record: ' + esc(p.recordId) : ''}</small></div>`).join('');
    openDrawer(`<button class="drawer-shade" data-action="close-drawer" aria-label="Close consumer details"></button><aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="Consumer details" tabindex="-1"><div class="drawer-heading"><span class="eyebrow">CUSTOMER-OWNED RECORD</span><button class="icon-button" data-action="close-drawer" aria-label="Close details">${icon('close')}</button></div><span class="large-avatar">${esc(c.name?.split(' ').map(p=>p[0]).slice(0,2).join('') || '@')}</span><h2>${esc(c.name || 'Customer record')}</h2><p>${esc(c.email)}</p>${badge(c.status)}<p class="footnote">Customer-provided data. Contact ownership and deliverability are not verified by import. Permission is recorded separately for each associated visit.</p><div class="detail-section"><h3>Field provenance</h3>${provenance}</div><div class="detail-section"><h3>Associated website sessions</h3>${result.visitors.length ? result.visitors.map(v=>`<div class="visit-event"><button class="text-button" data-action="visitor" data-id="${v.id}">${esc(v.site_name)} ${icon('arrow',12)}</button><span>${date(v.last_seen)} · ${esc(v.status)}</span></div>`).join('') : '<p>No sessions associated. A directory record does not identify anonymous traffic by itself.</p>'}</div><div class="detail-section"><h3>Enrichment history</h3>${result.history.slice(0,15).map(h=>`<div class="visit-event"><strong>${esc(h.action.replaceAll('_',' '))} · ${esc(h.source.name)}</strong><span>${date(h.created)}${h.changes.length ? '<br>' + h.changes.map(change => esc((labels[change.field] || change.field) + ': ' + (change.outcome === 'retained' ? 'existing value retained' : 'updated'))).join('<br>') : ''}</span></div>`).join('')}</div><div class="drawer-actions consumer-actions">${c.status === 'active' ? button('consumer-edit','Edit contact','secondary',`data-id="${c.id}"`) + button('consumer-suppress','Suppress','secondary',`data-id="${c.id}"`) : ''}${button('consumer-erase','Erase contact','danger',`data-id="${c.id}"`)}</div></aside>`);
  }
  function contactForm(c) {
    return field('Full name','name',c?.name || '','text','maxlength="100"') + field('Email','email',c?.email || '','email',`required maxlength="254" ${c?'readonly':''}`) + `<div class="contact-form-grid">${profileFields.filter(f=>f!=='name').map(f=>field(labels[f],f,c?.[f] || '',f==='phone'?'tel':'text',f==='country'?'maxlength="2" placeholder="US"':'')).join('')}</div>`;
  }
  function importModal() {
    modal('Import customer-owned CRM data','Preview first. Valid imports are applied atomically, up to 250 contacts per batch.',field('CRM / source name','sourceName','','text','required maxlength="120" placeholder="Customer CRM"')+select('Format','format','<option value="csv">CSV export</option><option value="json">JSON array</option>')+'<label class="field"><span>Choose a local file (optional)</span><input id="consumer-file" type="file" accept=".csv,.json,text/csv,application/json"></label>'+textarea('Paste export content','content','','required maxlength="200000" placeholder="email,name,phone,city,state,postalCode,country,updated_at,external_id"')+'<button type="button" class="button text" data-action="consumer-sample">Download example CSV</button><p class="footnote">Supported columns: email, name (or first_name / last_name), phone, city, state, postalCode, country, updated_at, external_id. Unknown columns are ignored. Blank values do not erase existing fields.</p><div id="import-preview"></div>','Preview import');
    const form = document.querySelector('#modal-form'), submit = form.querySelector('[type=submit]');
    let approved = null;
    const invalidate = () => { approved = null; submit.textContent='Preview import'; document.querySelector('#import-preview').innerHTML=''; };
    form.querySelectorAll('textarea,select,input:not([type=file])').forEach(e=>e.addEventListener('input',invalidate));
    document.querySelector('#consumer-file').onchange = async e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 200000) { form.querySelector('.form-error').textContent='Choose a file up to 200 KB.'; return; }
      form.elements.content.value = await file.text();
      form.elements.format.value = file.name.toLowerCase().endsWith('.json')?'json':'csv';
      if (!form.elements.sourceName.value) form.elements.sourceName.value=file.name.replace(/\.(csv|json)$/i,'');
      invalidate();
    };
    form.onsubmit = async e => {
      e.preventDefault(); submit.disabled = true; form.querySelector('.form-error').textContent = '';
      const input = { format: form.elements.format.value, sourceName: form.elements.sourceName.value, content: form.elements.content.value };
      try {
        if (approved !== JSON.stringify(input)) {
          const preview = await api('/api/consumers/import-preview','POST',input);
          document.querySelector('#import-preview').innerHTML = `<div class="notice">${preview.total} rows · ${preview.newContacts} new contacts · ${preview.existing} existing contacts</div>${preview.ignoredHeaders.length?'<p class="footnote">Ignored columns: '+esc(preview.ignoredHeaders.join(', '))+'</p>':''}${preview.issues.length?'<div class="form-error">'+preview.issues.map(i=>'Row '+i.row+': '+esc(i.message)).join('<br>')+'</div>':'<div class="import-samples">'+preview.preview.map(c=>'<p><strong>'+esc(c.name||c.email)+'</strong><span>'+esc(c.email)+(c.phone?' · '+esc(c.phone):'')+'</span></p>').join('')+'</div>'}`;
          if (!preview.issues.length) { approved=JSON.stringify(input); submit.textContent=`Import ${preview.total} contact${preview.total===1?'':'s'}`; }
        } else {
          const result = await api('/api/consumers/import','POST',input);
          document.querySelector('#modal').close(); await refresh();
          toast(`${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged${result.conflicts?' · '+result.conflicts+' existing values protected':''}.`);
        }
      } catch (error) { form.querySelector('.form-error').textContent=error.message; approved=null; submit.textContent='Preview import'; }
      finally { submit.disabled=false; }
    };
  }
  async function action(name, el) {
    if (!name.startsWith('consumer-')) return false;
    const state=getState();
    if (name==='consumer-detail') { await detail(el.dataset.id); return true; }
    if (name==='consumer-new' || name==='consumer-edit') {
      const c=name==='consumer-edit'?(await api('/api/consumers/'+el.dataset.id)).consumer:null;
      modal(c?'Edit customer-owned record':'Add a customer-owned consumer','Every saved field retains its source. This does not grant outreach permission.',contactForm(c)+(c?'':field('Source name','sourceName','Customer-provided record','text','required maxlength="120"')),'Save contact');
      formSubmit(async d=>{
        if(c) await api('/api/consumers/'+c.id,'PATCH',d);
        else {const {sourceName,...contact}=d;await api('/api/consumers','POST',{contact,source:{type:'manual',name:sourceName}});}
        closeDrawer(); toast('Customer record saved with field provenance.');
      }); return true;
    }
    if (name==='consumer-import') { importModal(); return true; }
    if (name==='consumer-sample') { download('signal-customer-example.csv','email,name,phone,city,state,postalCode,country,updated_at,external_id\r\nnora.example@example.com,Nora Example,+12025550120,Austin,TX,78701,US,2026-01-01T00:00:00Z,customer-001\r\n','text/csv');return true; }
    if (name==='consumer-link') {
      const contacts=(state.consumers||[]).filter(c=>c.status==='active');
      if(!contacts.length){infoModal('Add a customer record first','Open Consumers to add or import your customer-owned contacts.','<p>A known session can then be associated with that record by your backend or through this admin action.</p>');return true;}
      modal('Associate a known customer session','This is an explicit customer/admin assertion, not an IP-based identity match.',select('Customer record','consumerId',contacts.map(c=>`<option value="${c.id}">${esc(c.name||c.email)} · ${esc(c.email)}</option>`).join(''))+field('Association source','sourceName','Dashboard association','text','required maxlength="120"')+'<label class="permission-checkbox"><input type="checkbox" name="emailMarketing">Record already-captured email marketing permission</label>'+field('Permission notice version','noticeVersion','','text','maxlength="100" placeholder="Required only when recording permission"')+'<p class="footnote">Leave permission unchecked unless your customer has collected it. Retain the underlying evidence. Linking a contact alone does not authorize an offer.</p>','Associate and enrich');
      formSubmit(async d=>{await api('/api/identify','POST',{visitorId:el.dataset.id,consumerId:d.consumerId,source:{type:'manual',name:d.sourceName},consent:{emailMarketing:d.emailMarketing==='on',noticeVersion:d.noticeVersion}});closeDrawer();toast('Session associated. Local enrichment queued.');});return true;
    }
    if (name==='consumer-refresh') { await api('/api/visitors/'+el.dataset.id+'/enrich','POST',{});closeDrawer();await refresh();toast('Customer record refresh queued.');return true; }
    if (name==='consumer-suppress' || name==='consumer-erase') {
      const erase=name==='consumer-erase';
      modal(erase?'Erase consumer and associated visits':'Suppress this consumer',erase?'Removes this profile, its source history, and associated visitor data.':'Blocks all associated sessions and future appends.','<p>Keyed suppression is retained to prevent accidental re-import or re-append. Imports cannot restore permission.</p>',erase?'Erase consumer data':'Suppress consumer');
      formSubmit(async()=>{await api('/api/consumers/'+el.dataset.id+(erase?'':'/suppress'),erase?'DELETE':'POST',{});closeDrawer();toast(erase?'Consumer and associated visits erased.':'Consumer and associated sessions suppressed.');});return true;
    }
    return false;
  }
  return { render, bindPage, visitorActions, action };
}
