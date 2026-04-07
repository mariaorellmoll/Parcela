import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Get full province list
  const provXml = await fetchRaw(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaProvincia'
  );
  const provinces = {};
  for (const m of provXml.matchAll(/<prov>[\s\S]*?<cpine>(\d+)<\/cpine>[\s\S]*?<np>([^<]+)<\/np>[\s\S]*?<\/prov>/gi)) {
    provinces[m[1].padStart(2,'0')] = m[2].trim();
  }
  results.province_map = provinces;

  // Get municipalities in ILLES BALEARS matching ART
  const muniXml = await fetchRaw(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaMunicipio?Provincia=ILLES%20BALEARS&Municipio=ART'
  );
  const munis = [];
  for (const m of muniXml.matchAll(/<nm>([^<]+)<\/nm>/gi)) munis.push(m[1].trim());
  results.municipalities_ART = munis;

  // Get exact street name for CARDENAL in ARTA
  results.via_cardenal = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaVia?Provincia=ILLES%20BALEARS&Municipio=ARTA&TipoVia=CL&NombreVia=CARDENAL'
  );

  // DNPLOC with ARTÀ accented
  results.dnploc_arta_accented = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ART%C3%80&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  // DNPLOC with ARTA no accent, full street name from map
  results.dnploc_del_cardenal = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  // ConsultaNumero with correct param NomVia
  results.consulta_numero = await testUrl(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaNumero?Provincia=ILLES%20BALEARS&Municipio=ARTA&TipoVia=CL&NomVia=DEL%20CARDENAL%20DESPUIG&Numero=1'
  );

  res.status(200).json(results);
}

async function fetchRaw(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
      method: 'GET', headers: { Accept: 'text/xml', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 10000,
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function testUrl(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
      method: 'GET', headers: { Accept: 'text/xml', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 10000,
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({
        status: r.statusCode, length: d.length,
        preview: d.substring(0, 600),
        error_desc: d.match(/<des>([^<]+)<\/des>/i)?.[1] || null,
        rc_count: (d.match(/<pc1>/gi) || []).length,
      }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}
