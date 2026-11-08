const radians = d => d * Math.PI / 180;
export function distanceMeters(a, b) {
  const dlat = radians(b.lat-a.lat), dlng = radians(b.lng-a.lng);
  const v = Math.sin(dlat/2)**2 + Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dlng/2)**2;
  return 6371008.8 * 2 * Math.asin(Math.min(1,Math.sqrt(v)));
}
export function locationMatches(plan, location, at = Date.now()) {
  if (!location || location.source !== 'gps' || !Number.isFinite(location.lat) || Math.abs(location.lat)>85 || !Number.isFinite(location.lng) || Math.abs(location.lng)>180 || !Number.isFinite(location.accuracyMeters) || location.accuracyMeters<1 || location.accuracyMeters>100 || !Number.isFinite(location.timestamp) || at-location.timestamp>300000 || location.timestamp-at>30000) return false;
  if (plan.shape==='radius') return distanceMeters(plan,location)+location.accuracyMeters <= plan.radiusKm*1000;
  const ring=plan.coordinates;
  if(Math.max(...ring.map(p=>p[0]))-Math.min(...ring.map(p=>p[0]))>180)return false;
  const x=location.lng,y=location.lat;let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i],[xj,yj]=ring[j];
    if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
  }
  if(!inside)return false;
  const scaleX=111320*Math.cos(radians(y)),scaleY=111320;
  for(let i=1;i<ring.length;i++){
    const a={x:(ring[i-1][0]-x)*scaleX,y:(ring[i-1][1]-y)*scaleY};
    const b={x:(ring[i][0]-x)*scaleX,y:(ring[i][1]-y)*scaleY};
    const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
    const t=length?Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/length)):0;
    if(Math.hypot(a.x+t*dx,a.y+t*dy)<location.accuracyMeters)return false;
  }
  return true;
}
