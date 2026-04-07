import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // Test: DNPLOC with empty provincia/municipio — does stripping params help?
  results.dnploc_no_province = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=&Municipio=ARTA&Sigla=CL&Calle=CARDENAL&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  // Test: DNPLOC with minimal params
  results.dnploc_minimal = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=&Municipio=&Sigla=CL&Calle=CARDENAL&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  // Test: DNPRC with a known RC but adding fake province — does adding params break it?
  results.rc_with_province = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=ILLES%20BALEARS&Municipio=ARTA&RC=0138301ED3903N'
  );

  // Test: ConsultaVia with empty province
  results.via_no_province = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaVia?Provincia=&Municipio=ARTA&TipoVia=CL&NombreVia=CARDENAL'
  );

  // Test: ConsultaMunicipio (no codes) — text name version
  results.consulta_municipio = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaMunicipio?Provincia=BALEARES&Municipio=ARTA'
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
        preview: data.substring(0, 400),
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
