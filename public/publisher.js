const slot=document.querySelector('#ad-slot');
const key=new URL(location.href).searchParams.get('placement');
if(!key)slot.textContent='Choose “Open publisher” next to a placement in Signal.';
else{slot.textContent='';const s=document.createElement('script');s.src='/adtag.js';s.dataset.placement=key;slot.append(s);}
