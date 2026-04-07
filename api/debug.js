import http from 'node:http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Replicate EXACTLY what catastro.js does step by step
  // with the inputs: province=ILLES BALEARS, municipality=ARTA, street=DEL CARDENAL DESPUIG

  const provName = 'ILLES BALEARS';
  const muniName = 'ARTA';
  const sigla = 'CL';
  const streetName = 'DEL CARDENAL DESPUIG';

  // Step 1: ConsultaVia
  const viaUrl = `http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaVia?Provincia=${enc(provName)}&Municipio=${enc(muniName)}&TipoVia=${enc(sigla)}&NombreVia=${enc(streetName)}`;
  results.step1_url = viaUrl;
  const viaResult = await testUrl(viaUrl);
  results.step1_via = viaResult;

  // Parse exact street from ConsultaVia response
  const streets = [];
  if (viaResult.preview) {
    for (const m of viaResult.preview.matchAll(/<nv>([^<]+)<\/nv>/gi)) streets.push(m[1].trim());
  }
  results.step1_streets_found = streets;
  const exactStreet = streets[0] || null;
  results.step1_exact_street = exactStreet;

  if (!exactStreet) {
    res.status(200).json({ ...results, stopped: 'No street found in ConsultaVia' });
    return;
  }

  // Step 2: ConsultaNumero
  const numUrl = `http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaNumero?Provincia=${enc(provName)}&Municipio=${enc(muniName)}&TipoVia=${enc(sigla)}&NomVia=${enc(exactStreet)}&Numero=1`;
  results.step2_url = numUrl;
  const numResult = await testUrl(numUrl);
  results.step2_numero = numResult;

  // Parse RCs
  const rcs = [];
  if (numResult.preview) {
    for (const m of numResult.preview.matchAll(/<pc1>([^<]+)<\/pc1>[\s\S]*?<pc2>([^<]+)<\/pc2>/gi)) {
      rcs.push((m[1].trim() + m[2].trim()).toUpperCase());
    }
  }
  results.step2_rcs_found = rcs;

  if (rcs.length === 0) {
    res.status(200).json({ ...results, stopped: 'No RCs found in ConsultaNumero' });
    return;
  }

  // Step 3: RC lookup for first RC
  const rcUrl = `http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${enc(rcs[0])}`;
  results.step3_url = rcUrl;
  results.step3_rc = await testUrl(rcUrl);

  res.status(200).json(results);
}

function enc(s) { return encodeURIComponent(s || ''); }

function testUrl(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { Accept: 'text/xml', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 12000,
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({
        status: r.statusCode,
        length: d.length,
        preview: d.substring(0, 800),
        error_desc: d.match(/<des>([^<]+)<\/des>/i)?.[1] || null,
        rc_count: (d.match(/<pc1>/gi) || []).length,
      }));
    });
    req.on('error', e => resolve({ error: e.message, code: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.end();
  });
}
