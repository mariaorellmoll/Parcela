export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Simulate what renderCard now sends to /api/mapimage
  // ac.streetName = "DEL CARDENAL DESPUIG", ac.number = "12", ac.municipality = "ARTA"
  const streetForGeo = "CARDENAL DESPUIG"; // after stripping DEL
  const geocodeQuery = `${streetForGeo} 12, Arta, España`;

  const queries = [
    geocodeQuery,
    "Arta, España",
    "Arta, Illes Balears",
    "Artà, Mallorca",
  ];

  const results = {};
  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=es`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Parcela/1.0' } });
      const data = await r.json();
      results[q] = data.length ? { lat: data[0].lat, lon: data[0].lon, name: data[0].display_name } : 'NOT FOUND';
    } catch(e) { results[q] = { error: e.message }; }
  }
  res.status(200).json(results);
}
