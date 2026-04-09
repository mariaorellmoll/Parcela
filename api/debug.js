export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const lat = 39.6950088, lon = 3.3492;
  const results = {};

  const tests = {
    // TomTom static map - free tier
    tomtom: `https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&zoom=16&center=${lon},${lat}&width=600&height=280&format=png&markers=type:circle|color:1a56db|center:${lon},${lat}`,
    // MapTiler - has free tier
    maptiler: `https://api.maptiler.com/maps/streets/static/${lon},${lat},16/600x280.png?key=get_your_own_key`,
    // Stadia Maps - free for low volume
    stadia: `https://tiles.stadiamaps.com/static/osm_bright.png?center=${lon},${lat}&zoom=16&size=600x280&pin=lonlat:${lon},${lat}`,
    // Maps.co - completely free
    mapsco: `https://geocode.maps.co/search?q=Arta+Spain&api_key=`,
    // LocationIQ static map - free tier 5000/day
    locationiq: `https://maps.locationiq.com/v3/staticmap?key=pk.test&center=${lat},${lon}&zoom=16&size=600x280&markers=icon:small-red-cutout|${lat},${lon}&format=png`,
    // HERE Maps static - free tier
    here: `https://image.maps.ls.hereapi.com/mia/1.6/mapview?c=${lat},${lon}&z=16&w=600&h=280&f=1`,
  };

  for (const [name, url] of Object.entries(tests)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Parcela/1.0' }, signal: AbortSignal.timeout(5000) });
      const buf = await r.arrayBuffer();
      results[name] = { status: r.status, ct: r.headers.get('content-type'), bytes: buf.byteLength };
    } catch(e) { results[name] = { error: e.message }; }
  }

  // Also check the real croquis URL by looking at Catastro's actual web service WSDL
  try {
    const r = await fetch('http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc', { headers: { 'User-Agent': 'Parcela/1.0' } });
    const text = await r.text();
    // Extract all operation names
    const ops = [...text.matchAll(/name="([^"]+)"/g)].map(m=>m[1]).filter(n=>n.toLowerCase().includes('foto')||n.toLowerCase().includes('croquis')||n.toLowerCase().includes('recuperar'));
    results.catastro_wsdl_ops = ops;
  } catch(e) { results.catastro_wsdl = { error: e.message }; }

  res.status(200).json(results);
}
