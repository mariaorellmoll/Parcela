export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Test: does /api/mapimage actually return lat/lon correctly?
  try {
    const r = await fetch('https://parcela-khaki.vercel.app/api/mapimage?address=CL+DEL+CARDENAL+DESPUIG+12+ARTA+ILLES+BALEARS');
    const data = await r.json();
    res.status(200).json({ mapimage_result: data });
  } catch(e) {
    res.status(200).json({ error: e.message });
  }
}
