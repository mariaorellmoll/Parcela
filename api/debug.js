// api/debug.js — temporary diagnostic endpoint
// Shows exactly what Catastro returns (or what error occurs) for a known working query
// DELETE THIS FILE after debugging

import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // Test 1: The RC lookup we know works
  results.rc_lookup = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=0138301ED3903N'
  );

  // Test 2: ConsultaMunicipioCodigos with correct parameter
  results.muni_codigos = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejeroCodigos.asmx/ConsultaMunicipioCodigos?CodigoProvincia=07&Municipio=ARTA'
  );

  // Test 3: Consulta_DNPLOC directly — the text-name version
  results.dnploc_text = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=CARDENAL%20DESPUIG&Numero=&Bloque=&Escalera=&Planta=&Puerta='
  );

  // Test 4: Consulta_DNPLOC with accented name
  results.dnploc_accented = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ART%C3%80&Sigla=CL&Calle=CARDENAL%20DESPUIG&Numero=&Bloque=&Escalera=&Planta=&Puerta='
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
        preview: data.substring(0, 300),
        error_code: data.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1] || null,
        error_desc: data.match(/<des>([^<]+)<\/des>/i)?.[1] || null,
        rc_count: (data.match(/<pc1>/gi) || []).length,
      }));
    });
    req.on('error', e => resolve({ error: e.message, code: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}
