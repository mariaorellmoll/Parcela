import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Get FULL XML for the number 12 parcel
  const xml = await fetchRaw(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=0138301ED3903N'
  );

  // Also check what Consulta_DNPLOC returns for number 12 — does it include sub-units?
  const xml12 = await fetchRaw(
    'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?Provincia=ILLES%20BALEARS&Municipio=ARTA&Sigla=CL&Calle=DEL%20CARDENAL%20DESPUIG&Numero=12&Bloque=&Escalera=&Planta=&Puerta='
  );

  res.status(200).json({
    dnprc_full: xml,
    dnploc_12_full: xml12,
    dnprc_length: xml?.length,
    dnploc_length: xml12?.length,
    bi_count_dnprc: (xml?.match(/<bi>/gi) || []).length,
    bi_count_dnploc: (xml12?.match(/<bi>/gi) || []).length,
    sfc_values_dnprc: [...(xml?.matchAll(/<sfc>([^<]+)<\/sfc>/gi) || [])].map(m => m[1]),
    sfc_values_dnploc: [...(xml12?.matchAll(/<sfc>([^<]+)<\/sfc>/gi) || [])].map(m => m[1]),
  });
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
