// api/mapimage.js
// Geocodes address server-side and returns coordinates as JSON
// The frontend then renders the map directly using browser-side tile requests

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query || {};
  if (!address) return res.status(400).json({ error: 'address required' });

  try {
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', Spain')}&format=json&limit=1&countrycodes=es`;
    const geoRes = await fetch(geoUrl, {
      headers: { 'User-Agent': 'Parcela/1.0 contact@parcela.app', 'Accept-Language': 'es' }
    });
    const geoData = await geoRes.json();

    if (!geoData || !geoData.length) {
      return res.status(404).json({ error: 'Location not found' });
    }

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).json({
      lat: parseFloat(geoData[0].lat),
      lon: parseFloat(geoData[0].lon),
      display: geoData[0].display_name,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
