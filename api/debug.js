export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Test every possible croquis endpoint variant
  const rc14 = '0138301ED3903N';
  const endpoints = [
    `http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarCroquisGet?ReferenciaCatastral=${rc14}`,
    `http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarFotoCroquisGet?ReferenciaCatastral=${rc14}`,
    `http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarCroquis?ReferenciaCatastral=${rc14}`,
    `http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarCroquisParcelaGet?ReferenciaCatastral=${rc14}`,
  ];

  for (const url of endpoints) {
    const key = url.match(/\/(\w+)\?/)[1];
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Parcela/1.0' } });
      const buf = await r.arrayBuffer();
      results[key] = { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.byteLength };
    } catch(e) { results[key] = { error: e.message }; }
  }

  // Test mapimage - can we reach staticmap.openstreetmap.de ?
  try {
    const r = await fetch('https://staticmap.openstreetmap.de/staticmap.php?center=39.6974,3.3492&zoom=16&size=400x200&markers=39.6974,3.3492,ol-marker', { headers: { 'User-Agent': 'Parcela/1.0' } });
    const buf = await r.arrayBuffer();
    results.staticmap_osm = { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.byteLength };
  } catch(e) { results.staticmap_osm = { error: e.message }; }

  // Test alternative: geoapify static map (no key needed for basic)
  try {
    const r = await fetch('https://maps.geoapify.com/v1/staticmap?style=osm-carto&width=600&height=300&center=lonlat:3.3492,39.6974&zoom=15&marker=lonlat:3.3492,39.6974;color:%231a56db;size:medium&apiKey=YOUR_KEY');
    results.geoapify = { status: r.status };
  } catch(e) { results.geoapify = { error: e.message }; }

  // Test: can we reach nominatim at all from Vercel?
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?q=Arta+Spain&format=json&limit=1', { headers: { 'User-Agent': 'Parcela/1.0' } });
    const d = await r.json();
    results.nominatim = { status: r.status, count: d.length, first: d[0]?.lat };
  } catch(e) { results.nominatim = { error: e.message }; }

  res.status(200).json(results);
}
