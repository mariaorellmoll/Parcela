// api/mapimage.js
// Geocodes address server-side and returns coordinates as JSON

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query || {};
  if (!address) return res.status(400).json({ error: 'address required' });

  // Try progressively simpler queries until one works
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const queries = [
    address,                           // full: "CARDENAL DESPUIG 12, Arta, España"
    parts.slice(1).join(', '),         // drop street number: "Arta, España"
    parts[parts.length - 2] + ', España', // just municipality
    parts[parts.length - 1],           // just country part
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=es`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Parcela/1.0 contact@parcela.app', 'Accept-Language': 'es' }
      });
      const data = await r.json();
      if (data && data.length) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).json({
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
          query_used: q,
        });
      }
    } catch(e) { continue; }
  }

  return res.status(404).json({ error: 'Location not found' });
}
