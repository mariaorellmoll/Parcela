// api/mapimage.js
// Server-side proxy: geocodes the address and returns a static map image
// GET /api/mapimage?address=CL+DEL+CARDENAL+DESPUIG+12+ARTA+ILLES+BALEARS

export default async function handler(req, res) {
  const { address } = req.query || {};
  if (!address) return res.status(400).json({ error: 'address required' });

  try {
    // Step 1: Geocode with Nominatim (server-side, no CORS issues)
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', Spain')}&format=json&limit=1&countrycodes=es`;
    const geoRes = await fetch(geoUrl, {
      headers: { 'User-Agent': 'Parcela/1.0 contact@parcela.app', 'Accept-Language': 'es' }
    });
    const geoData = await geoRes.json();

    if (!geoData || !geoData.length) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: Fetch static map tile from OpenStreetMap
    // Use staticmap.net — free, no key, returns PNG
    const zoom = 16;
    const width = 680;
    const height = 280;
    const markerColor = '1a56db';

    const staticUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=${zoom}&size=${width}x${height}&markers=${lat},${lon},ol-marker`;

    const imgRes = await fetch(staticUrl, {
      headers: { 'User-Agent': 'Parcela/1.0' }
    });

    if (!imgRes.ok) {
      // Fallback: return coordinates as JSON so frontend can use them
      return res.status(200).json({ lat, lon, imageAvailable: false });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buffer = await imgRes.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.status(200).send(Buffer.from(buffer));

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
