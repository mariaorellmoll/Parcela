import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // The text-based endpoints are strict about province name.
  // Try every plausible variant for Baleares
  const variants = [
    'BALEARES', 'ILLES BALEARS', 'BALEARS', 'ISLAS BALEARES', 'IB', '07'
  ];

  for (const prov of variants) {
    results[`via_prov_${prov}`] = await testUrl(
      `http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaVia?Provincia=${encodeURIComponent(prov)}&Municipio=ARTA&TipoVia=CL&NombreVia=CARDENAL`
    );
  }

  // Also try ConsultaProvincia — get the exact list of valid province names
  results.consulta_provincia = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaProvincia'
  );

  res.status(200).json(results);
}

function testUrl(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Accept': 'text/xml', 'User-Agent': 'Parcela/1.0', 'Connection': 'close' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        preview: data.substring(0, 300),
        error_desc: data.match(/<des>([^<]+)<\/des>/i)?.[1] || null,
        rc_count: (data.match(/<pc1>/gi) || []).length,
      }));
    });
    req.on('error', e => resolve({ error: e.message, code: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}
