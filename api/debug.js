import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Get full province list
  results.all_provinces = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaProvincia'
  );

  // Now we know ILLES BALEARS works for ConsultaVia — test DNPLOC with it
  results.dnploc_illes_balears = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=CARDENAL%20DESPUIG&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  // Test ConsultaNumero with ILLES BALEARS — get all numbers on this street
  results.consulta_numero = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaNumero?Provincia=ILLES%20BALEARS&Municipio=ARTA&TipoVia=CL&NombreVia=CARDENAL%20DESPUIG&Numero=1'
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
        length: data.length,
        preview: data.substring(0, 800),
        error_desc: data.match(/<des>([^<]+)<\/des>/i)?.[1] || null,
        rc_count: (data.match(/<pc1>/gi) || []).length,
      }));
    });
    req.on('error', e => resolve({ error: e.message, code: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}
