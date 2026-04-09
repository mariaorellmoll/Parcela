export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};
  
  // Test fetching a single OSM tile from Vercel server
  try {
    const r = await fetch('https://tile.openstreetmap.org/16/33149/24281.png', {
      headers: { 'User-Agent': 'Parcela/1.0' }
    });
    results.osm_tile = { status: r.status, ct: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
  } catch(e) { results.osm_tile = { error: e.message }; }

  // Test unpkg leaflet reachable?
  try {
    const r = await fetch('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    results.unpkg = { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
  } catch(e) { results.unpkg = { error: e.message }; }

  // If OSM tiles work server-side, we can stitch them into a PNG and return it
  // Let's test: fetch 3x2 tiles around Arta and return as JSON with base64
  const lat = 39.6926564, lon = 3.3500800, zoom = 16;
  const n = Math.pow(2, zoom);
  const tileX = Math.floor((lon + 180) / 360 * n);
  const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1/Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  results.tile_coords = { tileX, tileY, zoom };
  
  try {
    const tileUrl = `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;
    const r = await fetch(tileUrl, { headers: { 'User-Agent': 'Parcela/1.0' } });
    const buf = await r.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    results.centre_tile = { status: r.status, ct: r.headers.get('content-type'), bytes: buf.byteLength, b64preview: b64.substring(0,50) };
  } catch(e) { results.centre_tile = { error: e.message }; }

  res.status(200).json(results);
}
