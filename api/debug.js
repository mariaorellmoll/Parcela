import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Get ALL numbers on the street with both calls
  const [xml1, xml2] = await Promise.all([
    fetchRaw('http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaNumero?Provincia=ILLES%20BALEARS&Municipio=ARTA&TipoVia=CL&NomVia=DEL%20CARDENAL%20DESPUIG&Numero=1'),
    fetchRaw('http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaNumero?Provincia=ILLES%20BALEARS&Municipio=ARTA&TipoVia=CL&NomVia=DEL%20CARDENAL%20DESPUIG&Numero=999'),
  ]);

  // Extract all number+RC pairs from both responses
  const extractPairs = (xml) => {
    if (!xml) return [];
    const pairs = [];
    for (const m of xml.matchAll(/<nump>([\s\S]*?)<\/nump>/gi)) {
      const b = m[1];
      const pc1 = b.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
      const pc2 = b.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
      const num = b.match(/<pnp>([^<]+)<\/pnp>/i)?.[1]?.trim();
      if (pc1 && pc2) pairs.push({ num, rc: pc1 + pc2 });
    }
    return pairs;
  };

  const pairs1 = extractPairs(xml1);
  const pairs2 = extractPairs(xml2);
  results.from_numero_1 = pairs1;
  results.from_numero_999 = pairs2;

  // All unique RCs
  const allRCs = [...new Set([...pairs1, ...pairs2].map(p => p.rc))];
  results.all_rcs = allRCs;

  // Fetch m² for each RC
  const details = await Promise.all(allRCs.map(async rc => {
    const xml = await fetchRaw(`http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${rc}`);
    const sfc = xml?.match(/<sfc>([^<]+)<\/sfc>/i)?.[1]?.trim();
    const stl = xml?.match(/<stl>([^<]+)<\/stl>/i)?.[1]?.trim();
    const pnp = xml?.match(/<pnp>([^<]+)<\/pnp>/i)?.[1]?.trim();
    const luso = xml?.match(/<luso>([^<]+)<\/luso>/i)?.[1]?.trim();
    return { rc, num: pnp, m2: sfc || stl || null, use: luso };
  }));
  results.details = details;

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
