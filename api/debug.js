export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Get the actual WSDL to find croquis operations
  try {
    const r = await fetch('http://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc?wsdl', { headers: { 'User-Agent': 'Parcela/1.0' } });
    const text = await r.text();
    // Get all operation names
    const ops = [...text.matchAll(/wsdl:operation name="([^"]+)"/gi)].map(m=>m[1]);
    res.status(200).json({ ops, preview: text.substring(0, 500) });
  } catch(e) {
    res.status(200).json({ error: e.message });
  }
}
