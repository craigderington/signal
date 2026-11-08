(() => {
  'use strict';
  const script = document.currentScript;
  const origin = new URL(script.src).origin;
  const site = script.dataset.site;
  if (!site) return;
  let permission = null;
  const storageKey = 'signal_subject_' + site;
  function subject() {
    try { let id=sessionStorage.getItem(storageKey); if(!id){id=crypto.randomUUID();sessionStorage.setItem(storageKey,id);}return id; }
    catch { return null; }
  }
  function track() {
    if (!permission?.collection || navigator.globalPrivacyControl === true) return;
    const id=subject();if(!id)return;
    const params=new URL(location.href).searchParams;
    const source=(params.get('utm_source')||'direct').replace(/[^a-z0-9_-]/gi,'').slice(0,64);
    fetch(origin+'/collect?site='+encodeURIComponent(site),{
      method:'POST',mode:'cors',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subjectId:id,eventId:crypto.randomUUID(),url:location.origin+location.pathname,source,attribution:params.get('signal_click'),consent:permission,gpc:false}),
    }).catch(()=>{});
  }
  window.Signal={
    consent(value){permission=value?.collection===true&&typeof value.noticeVersion==='string'?{collection:true,noticeVersion:value.noticeVersion,emailReceipt:value.emailReceipt||null}:null;if(permission)track();},
    track,
    getSubjectId(){return permission?.collection && navigator.globalPrivacyControl !== true ? subject() : null;},
    revoke(){permission=null;try{sessionStorage.removeItem(storageKey);}catch{}},
  };
  if(window.signalConsent)window.Signal.consent(window.signalConsent);
})();
