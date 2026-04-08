import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const xml = await fetchRaw(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=0138301ED3903N'
  );
  res.status(200).json({ full_xml: xml, length: xml?.length });
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
