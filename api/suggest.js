// api/suggest.js
// Autocomplete suggestions from Catastro for province, municipality, street
// GET /api/suggest?type=municipality&province=ILLES+BALEARS&q=pal
// GET /api/suggest?type=street&province=ILLES+BALEARS&municipality=PALMA&q=sant+miquel

import http from 'node:http';

const BASE = 'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { type, province, municipality, q = '' } = req.query || {};

  try {
    if (type === 'municipality') {
      if (!province) return res.status(400).json({ error: 'province required' });
      const results = await getMunicipalities(province, q);
      return res.status(200).json({ results });
    }

    if (type === 'street') {
      if (!province || !municipality) return res.status(400).json({ error: 'province and municipality required' });
      const results = await getStreets(province, municipality, q);
      return res.status(200).json({ results });
    }

    return res.status(400).json({ error: 'type must be municipality or street' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getMunicipalities(province, q) {
  const url = `${BASE}/OVCCallejero.asmx/ConsultaMunicipio` +
    `?Provincia=${enc(province)}&Municipio=${enc(q.toUpperCase())}`;
  const xml = await fetchXML(url);
  if (!xml) return [];
  const results = [];
  for (const m of xml.matchAll(/<muni>([\s\S]*?)<\/muni>/gi)) {
    const name = m[1].match(/<nm>([^<]+)<\/nm>/i)?.[1]?.trim();
    if (name) results.push(name);
  }
  return results.slice(0, 10);
}

async function getStreets(province, municipality, q) {
  const url = `${BASE}/OVCCallejero.asmx/ConsultaVia` +
    `?Provincia=${enc(province)}&Municipio=${enc(municipality)}` +
    `&TipoVia=&NombreVia=${enc(q.toUpperCase())}`;
  const xml = await fetchXML(url);
  if (!xml) return [];
  const results = [];
  for (const m of xml.matchAll(/<calle>([\s\S]*?)<\/calle>/gi)) {
    const tv = m[1].match(/<tv>([^<]+)<\/tv>/i)?.[1]?.trim() || '';
    const nv = m[1].match(/<nv>([^<]+)<\/nv>/i)?.[1]?.trim() || '';
    if (nv) results.push({ display: `${tv} ${nv}`.trim(), type: tv, name: nv });
  }
  return results.slice(0, 10);
}

function enc(s) { return encodeURIComponent(s || ''); }

function fetchXML(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname, port: 80,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { Accept: 'text/xml', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 8000,
    }, (r) => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => d += c);
      r.on('end', () => resolve(r.statusCode < 300 ? d : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
