import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Test Consulta_DNPLOC with various Numero values — looking for one that returns ALL properties
  const tests = [
    ['Numero=0',    'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=0&Bloque=&Escalera=&Planta=&Puerta='],
    ['Numero=S/N',  'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=S%2FN&Bloque=&Escalera=&Planta=&Puerta='],
    ['no Numero param', 'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Bloque=&Escalera=&Planta=&Puerta='],
    ['Numero=12',   'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=12&Bloque=&Escalera=&Planta=&Puerta='],
    ['Numero=11',   'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=11&Bloque=&Escalera=&Planta=&Puerta='],
    ['Numero=10',   'Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=10&Bloque=&Escalera=&Planta=&Puerta='],
  ];

  for (const [label, path] of tests) {
    const url = `http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/${path}`;
    const xml = await fetchRaw(url);
    const rcCount = (xml?.match(/<pc1>/gi) || []).length;
    const errDesc = xml?.match(/<des>([^<]+)<\/des>/i)?.[1] || null;
    results[label] = { 
      rc_count: rcCount, 
      error: errDesc,
      preview: xml?.substring(0, 400) 
    };
  }

  res.status(200).json(results);
}

async function fetchRaw(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
      method: 'GET', headers: { Accept: 'text/xml', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 12000,
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
