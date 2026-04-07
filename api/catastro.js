// api/catastro.js
// Correct approach: use numeric province/municipality codes, not text names
// Step 1: ConsultaMunicipio → get municipality code from province code + name
// Step 2: Consulta_DNPLOC_Codigos → search properties by code + street
// Step 3: Consulta_DNPRC_Codigos for each RC → full property data

const BASE = 'https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC';

// Province codes (INE standard)
const PROVINCE_CODES = {
  'alava': '01', 'albacete': '02', 'alicante': '03', 'almeria': '04', 'almería': '04',
  'avila': '05', 'ávila': '05', 'badajoz': '06', 'baleares': '07', 'illes balears': '07',
  'balears': '07', 'barcelona': '08', 'burgos': '09', 'caceres': '10', 'cáceres': '10',
  'cadiz': '11', 'cádiz': '11', 'castellon': '12', 'castellón': '12', 'ciudad real': '13',
  'cordoba': '14', 'córdoba': '14', 'cuenca': '16', 'girona': '17', 'granada': '18',
  'guadalajara': '19', 'guipuzcoa': '20', 'huelva': '21', 'huesca': '22', 'jaen': '23',
  'jaén': '23', 'la rioja': '26', 'las palmas': '35', 'leon': '24', 'león': '24',
  'lleida': '25', 'lugo': '27', 'madrid': '28', 'malaga': '29', 'málaga': '29',
  'murcia': '30', 'navarra': '31', 'ourense': '32', 'palencia': '34', 'pontevedra': '36',
  'salamanca': '37', 'santa cruz de tenerife': '38', 'tenerife': '38', 'cantabria': '39',
  'segovia': '40', 'sevilla': '41', 'soria': '42', 'tarragona': '43', 'teruel': '44',
  'toledo': '45', 'valencia': '46', 'valència': '46', 'valladolid': '47', 'vizcaya': '48',
  'zamora': '49', 'zaragoza': '50', 'ceuta': '51', 'melilla': '52',
};

// Well-known municipality names → Catastro internal name
// Catastro uses uppercase Spanish/Catalan names
const MUNI_NAME_MAP = {
  'palma': 'PALMA',
  'palma de mallorca': 'PALMA',
  'arta': 'ARTÀ',
  'artà': 'ARTÀ',
  'soller': 'SÓLLER',
  'sóller': 'SÓLLER',
  'ibiza': 'EIVISSA',
  'eivissa': 'EIVISSA',
  'sant antoni': 'SANT ANTONI DE PORTMANY',
  'sant antoni de portmany': 'SANT ANTONI DE PORTMANY',
  'santa eulalia': 'SANTA EULÀRIA DES RIU',
  'santa eularia': 'SANTA EULÀRIA DES RIU',
  'santa eularia des riu': 'SANTA EULÀRIA DES RIU',
  'santa eulària des riu': 'SANTA EULÀRIA DES RIU',
  'pollensa': 'POLLENÇA',
  'pollença': 'POLLENÇA',
  'pollenca': 'POLLENÇA',
  'alcudia': 'ALCÚDIA',
  'alcúdia': 'ALCÚDIA',
  'calvià': 'CALVIÀ',
  'calvia': 'CALVIÀ',
  'manacor': 'MANACOR',
  'inca': 'INCA',
  'llucmajor': 'LLUCMAJOR',
  'felanitx': 'FELANITX',
  'santanyi': 'SANTANYÍ',
  'santanyí': 'SANTANYÍ',
  'andratx': 'ANDRATX',
  'capdepera': 'CAPDEPERA',
  'campos': 'CAMPOS',
  'sa pobla': 'SA POBLA',
  'muro': 'MURO',
  'petra': 'PETRA',
  'sineu': 'SINEU',
  'formentera': 'FORMENTERA',
  'madrid': 'MADRID',
  'barcelona': 'BARCELONA',
  'sevilla': 'SEVILLA',
  'seville': 'SEVILLA',
  'malaga': 'MÁLAGA',
  'málaga': 'MÁLAGA',
  'marbella': 'MARBELLA',
  'granada': 'GRANADA',
  'valencia': 'VALÈNCIA',
  'valència': 'VALÈNCIA',
  'alicante': 'ALICANTE/ALACANT',
  'benidorm': 'BENIDORM',
  'torrevieja': 'TORREVIEJA',
};

// Street type prefixes to auto-detect
const STREET_PREFIXES = [
  [/^(AVENIDA|AVDA\.?|AV\.)\s+/i, 'AV'],
  [/^(CALLE|CARRER|CL\.)\s+/i,    'CL'],
  [/^(PLAZA|PLAÇA|PL\.?|PZA\.?)\s+/i, 'PZ'],
  [/^(PASEO|PASSEIG|PS\.)\s+/i,   'PS'],
  [/^(CARRETERA|CTRA\.?|CR\.)\s+/i, 'CR'],
  [/^(RONDA|RD\.)\s+/i,            'RD'],
  [/^(CAMINO|CAMI|CM\.)\s+/i,      'CM'],
  [/^(GRAN VIA|GRAN VÍA)\s+/i,     'GV'],
  [/^(TRAVESIA|TRAVESÍA|TV\.)\s+/i,'TV'],
  [/^(URBANIZACION|URBANITZACIÓ|UR\.)\s+/i, 'UR'],
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rc, province, municipality, street, street_type, floor, m2, year_built } = req.body || {};

  // ── PATH A: Direct RC ─────────────────────────────────────────────────────
  if (rc && rc.replace(/\s/g, '').length >= 14) {
    try {
      const clean = rc.replace(/\s/g, '').toUpperCase();
      const result = await lookupByRC(clean);
      if (!result) return res.status(404).json({ error: `No Catastro record found for RC: ${clean}` });
      return res.status(200).json({ path: 'rc_direct', candidates: [result], query: { rc: clean } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATH B: Municipality + street search ──────────────────────────────────
  if (!municipality) return res.status(400).json({ error: 'Municipality name is required.' });
  if (!m2) return res.status(400).json({ error: 'Built area (m²) is required.' });

  try {
    const { sigla, calle } = detectStreetType(street || '', street_type || 'CL');
    const candidates = await searchByMunicipality({
      province, municipality, sigla, calle, floor,
      m2: parseFloat(m2), year_built,
    });
    return res.status(200).json({
      path: 'street',
      candidates,
      query: { municipality, street: calle, street_type: sigla, m2, floor },
    });
  } catch (e) {
    console.error('[catastro]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── STEP 1: Resolve province code ────────────────────────────────────────────
function getProvinceCode(province, municipality) {
  if (province) {
    const key = province.toLowerCase().trim();
    if (PROVINCE_CODES[key]) return PROVINCE_CODES[key];
    // Try partial match
    for (const [k, v] of Object.entries(PROVINCE_CODES)) {
      if (key.includes(k) || k.includes(key)) return v;
    }
  }
  // Infer from municipality for well-known cases
  const muniKey = municipality.toLowerCase().trim();
  const balearicMunis = ['palma','artà','arta','sóller','soller','eivissa','ibiza',
    'sant antoni','formentera','pollença','pollenca','alcúdia','alcudia','calvià',
    'calvia','manacor','inca','llucmajor','felanitx','santanyí','santanyi',
    'andratx','capdepera','campos','sa pobla','muro','petra','sineu'];
  if (balearicMunis.some(m => muniKey.includes(m) || m.includes(muniKey))) return '07';
  if (muniKey.includes('madrid')) return '28';
  if (muniKey.includes('barcelona')) return '08';
  if (muniKey.includes('sevilla') || muniKey.includes('seville')) return '41';
  if (muniKey.includes('malaga') || muniKey.includes('málaga')) return '29';
  if (muniKey.includes('valencia') || muniKey.includes('valència')) return '46';
  if (muniKey.includes('granada')) return '18';
  if (muniKey.includes('alicante')) return '03';
  return null; // unknown — will try without province code
}

// ── STEP 2: Get municipality code from Catastro ───────────────────────────────
async function getMunicipalityCode(provCode, muniName) {
  // Try the normalised name first
  const normalised = MUNI_NAME_MAP[muniName.toLowerCase().trim()] || muniName.toUpperCase().trim();

  const url = `${BASE}/OVCCallejeroCodigos.asmx/ConsultaMunicipioCodigos` +
    `?Provincia=${encodeURIComponent(provCode)}&Municipio=${encodeURIComponent(normalised)}`;

  const xml = await fetchXML(url);
  if (!xml) throw new Error('Catastro did not respond when looking up municipality code.');

  // Parse municipality list — returns <muni> blocks
  const munis = [...xml.matchAll(/<muni>([\s\S]*?)<\/muni>/gi)];
  if (munis.length === 0) {
    // Try without accents
    const plain = stripAccents(normalised);
    if (plain !== normalised) {
      const url2 = `${BASE}/OVCCallejeroCodigos.asmx/ConsultaMunicipioCodigos` +
        `?Provincia=${encodeURIComponent(provCode)}&Municipio=${encodeURIComponent(plain)}`;
      const xml2 = await fetchXML(url2);
      if (xml2) {
        const munis2 = [...xml2.matchAll(/<muni>([\s\S]*?)<\/muni>/gi)];
        if (munis2.length > 0) return parseMuniList(munis2, normalised, plain);
      }
    }
    // Try just first word of municipality name
    const firstWord = normalised.split(' ')[0];
    if (firstWord !== normalised) {
      const url3 = `${BASE}/OVCCallejeroCodigos.asmx/ConsultaMunicipioCodigos` +
        `?Provincia=${encodeURIComponent(provCode)}&Municipio=${encodeURIComponent(firstWord)}`;
      const xml3 = await fetchXML(url3);
      if (xml3) {
        const munis3 = [...xml3.matchAll(/<muni>([\s\S]*?)<\/muni>/gi)];
        if (munis3.length > 0) return parseMuniList(munis3, normalised, firstWord);
      }
    }
    throw new Error(
      `Municipality "${muniName}" not found in province ${provCode}. ` +
      `Check the spelling — Catastro uses official Spanish/Catalan names. ` +
      `Examples: "PALMA", "ARTÀ", "SÓLLER", "EIVISSA", "CALVIÀ".`
    );
  }

  return parseMuniList(munis, normalised, normalised);
}

function parseMuniList(munis, originalName, query) {
  // If only one result, use it
  if (munis.length === 1) {
    const block = munis[0][1];
    const code = block.match(/<cm>([^<]+)<\/cm>/i)?.[1]?.trim();
    const name = block.match(/<nm>([^<]+)<\/nm>/i)?.[1]?.trim();
    if (code) return { code, name: name || originalName };
  }
  // Multiple results — find best match
  const queryUpper = query.toUpperCase();
  for (const m of munis) {
    const block = m[1];
    const code = block.match(/<cm>([^<]+)<\/cm>/i)?.[1]?.trim();
    const name = block.match(/<nm>([^<]+)<\/nm>/i)?.[1]?.trim() || '';
    if (name.toUpperCase() === queryUpper || stripAccents(name).toUpperCase() === stripAccents(queryUpper)) {
      return { code, name };
    }
  }
  // Take first match
  const block = munis[0][1];
  const code = block.match(/<cm>([^<]+)<\/cm>/i)?.[1]?.trim();
  const name = block.match(/<nm>([^<]+)<\/nm>/i)?.[1]?.trim();
  return { code, name: name || originalName };
}

// ── STEP 3: Search properties by code ────────────────────────────────────────
async function searchByMunicipality({ province, municipality, sigla, calle, floor, m2, year_built }) {
  const provCode = getProvinceCode(province, municipality);
  if (!provCode) {
    throw new Error(
      `Could not determine province for "${municipality}". ` +
      `Please fill in the Province field (e.g. "Baleares", "Madrid", "Barcelona").`
    );
  }

  // Get municipality code
  const muniInfo = await getMunicipalityCode(provCode, municipality);
  const { code: muniCode, name: muniName } = muniInfo;

  // Search properties using codes
  const url = `${BASE}/OVCCallejeroCodigos.asmx/Consulta_DNPLOC_Codigos` +
    `?CodigoProvincia=${encodeURIComponent(provCode)}` +
    `&CodigoMunicipio=${encodeURIComponent(muniCode)}` +
    `&CodigoMunicipioINE=` +
    `&Sigla=${encodeURIComponent(sigla)}` +
    `&Calle=${encodeURIComponent(calle)}` +
    `&Numero=` +
    `&Bloque=` +
    `&Escalera=` +
    `&Planta=${encodeURIComponent(floor || '')}` +
    `&Puerta=`;

  const xml = await fetchXML(url);
  if (!xml) throw new Error('Catastro did not respond. Try again in a moment.');

  // Check error codes
  const errCode = xml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  const errDesc = xml.match(/<des>([^<]+)<\/des>/i)?.[1];
  if (errCode && errCode !== '0') {
    throw new Error(friendlyError(errCode, errDesc, { municipality: muniName, street: calle, sigla }));
  }

  // Parse RC list
  const rcList = extractRCs(xml);

  // If no list returned, might be a single direct property response
  if (rcList.length === 0) {
    const single = parsePropertyXML(xml, null);
    if (single?.rc) return [{ ...single, matchScore: 95 }];
    throw new Error(
      `No properties found on "${sigla} ${calle}" in ${muniName}. ` +
      `Try leaving the street blank to search the whole municipality, ` +
      `or check the street name spelling.`
    );
  }

  if (rcList.length > 500) {
    throw new Error(
      `${rcList.length} properties found in ${muniName} — too many to process. ` +
      `Add a street name to narrow down the search.`
    );
  }

  // Fetch full data for top 30 RCs in parallel
  const batch = rcList.slice(0, 30);
  const fullData = await Promise.all(
    batch.map(rc => lookupByRC(rc).catch(() => null))
  );
  const valid = fullData.filter(Boolean);

  if (valid.length === 0) {
    throw new Error('Found properties but could not fetch details. Catastro may be slow — please try again.');
  }

  // Filter and score by m²
  const m2Min = m2 * 0.85;
  const m2Max = m2 * 1.15;

  let matched = valid.filter(p => {
    const bm2 = p.cadastralData?.builtAreaM2;
    return !bm2 || (bm2 >= m2Min && bm2 <= m2Max);
  });

  // If nothing in tolerance, return closest ones anyway
  if (matched.length === 0) matched = valid;

  const scored = matched.map(p => {
    const bm2 = p.cadastralData?.builtAreaM2;
    const yr = p.cadastralData?.yearBuilt;
    let score = 70;
    if (bm2) score += Math.round((1 - Math.abs(bm2 - m2) / m2) * 25);
    if (year_built && yr) {
      const d = Math.abs(yr - parseInt(year_built));
      score += d === 0 ? 10 : d <= 2 ? 7 : d <= 5 ? 3 : 0;
    }
    if (floor && p.addressComponents?.floor) {
      const pf = String(p.addressComponents.floor).toLowerCase();
      const qf = String(floor).toLowerCase();
      if (pf === qf || pf.includes(qf) || qf.includes(pf)) score += 5;
    }
    return { ...p, matchScore: Math.min(100, Math.max(0, score)) };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  return scored.slice(0, 5);
}

// ── RC LOOKUP ────────────────────────────────────────────────────────────────
async function lookupByRC(rc) {
  const url = `${BASE}/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${encodeURIComponent(rc)}`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  return parsePropertyXML(xml, rc);
}

// ── EXTRACT RC LIST FROM XML ──────────────────────────────────────────────────
function extractRCs(xml) {
  const rcs = [];
  // Try <inmueble> blocks
  for (const m of xml.matchAll(/<inmueble>([\s\S]*?)<\/inmueble>/gi)) {
    const b = m[1];
    const pc1 = b.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
    const pc2 = b.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
    if (pc1 && pc2) { rcs.push((pc1 + pc2).toUpperCase()); continue; }
    const rc = b.match(/<rc>([^<]+)<\/rc>/i)?.[1]?.trim();
    if (rc) rcs.push(rc.toUpperCase());
  }
  if (rcs.length > 0) return rcs;
  // Try <bico> blocks
  for (const m of xml.matchAll(/<bico>([\s\S]*?)<\/bico>/gi)) {
    const b = m[1];
    const pc1 = b.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
    const pc2 = b.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
    if (pc1 && pc2) rcs.push((pc1 + pc2).toUpperCase());
  }
  return rcs;
}

// ── PARSE PROPERTY XML ────────────────────────────────────────────────────────
function parsePropertyXML(xml, rcFallback) {
  if (!xml) return null;
  const errCode = xml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  if (errCode && errCode !== '0') return null;

  const g = tag => xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`, 'i'))?.[1]?.trim() || null;

  const pc1 = g('pc1'); const pc2 = g('pc2');
  const rc = pc1 && pc2 ? (pc1 + pc2).toUpperCase() : (g('rc') || rcFallback || '').toUpperCase();
  if (!rc) return null;

  const tv = g('tv') || ''; const nv = g('nv') || '';
  const pnp = g('pnp') || ''; const bq = g('bq') || '';
  const es = g('es') || ''; const pt = g('pt') || ''; const pu = g('pu') || '';
  const muni = g('nm') || g('municipio') || '';
  const prov = g('np') || g('provincia') || '';
  const cp = g('dp') || g('cp') || '';

  const addressParts = [
    [tv, nv].filter(Boolean).join(' '),
    pnp ? `nº ${pnp}` : '',
    bq ? `Bloque ${bq}` : '',
    es ? `Esc. ${es}` : '',
    pt ? `Planta ${pt}` : '',
    pu ? `Pta. ${pu}` : '',
  ].filter(Boolean).join(', ');
  const address = [addressParts, cp, muni, prov].filter(Boolean).join(', ');

  const uso = g('luso') || g('uso');
  const sfc = g('sfc') ? parseFloat(g('sfc')) : null;
  const stl = g('stl') ? parseFloat(g('stl')) : null;
  const ant = g('ant') ? parseInt(g('ant')) : null;
  const vv  = g('vv')  ? parseFloat(g('vv')) : null;
  const npr = g('npr') ? parseInt(g('npr'))  : null;

  const useMap = {
    V: 'Residential (dwelling)', R: 'Residential (multi-unit)',
    I: 'Industrial', O: 'Office', C: 'Commercial', A: 'Agricultural',
    T: 'Tourism / holiday', G: 'Garage', Z: 'Other',
  };

  const r1 = rc.substring(0, 7); const r2 = rc.substring(7, 14);
  const catUrl = `https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx` +
    `?RC1=${r1}&RC2=${r2}&pest=rc&RCCompleta=${rc}&from=OVCBusqueda&tipoCarto=nuevo`;

  return {
    rc, address: address || null,
    addressComponents: { streetType: tv || null, streetName: nv || null, number: pnp || null,
      block: bq || null, staircase: es || null, floor: pt || null, door: pu || null,
      postcode: cp || null, municipality: muni || null, province: prov || null },
    cadastralData: { use: useMap[uso] || uso || null, builtAreaM2: sfc || stl || null,
      yearBuilt: ant, cadastralValue: vv, numberOfFloors: npr },
    catastroUrl: catUrl,
    source: 'Catastro OVC — Ministerio de Hacienda',
  };
}

// ── STREET TYPE AUTO-DETECT ───────────────────────────────────────────────────
function detectStreetType(street, defaultType) {
  for (const [pattern, sigla] of STREET_PREFIXES) {
    if (pattern.test(street)) {
      return { sigla, calle: street.replace(pattern, '').trim() };
    }
  }
  return { sigla: defaultType || 'CL', calle: street.trim() };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[·]/g, '');
}

function friendlyError(code, desc, { municipality, street, sigla }) {
  const map = {
    '3':  `Street "${sigla} ${street}" not found in ${municipality}. Try leaving the street blank, or check the spelling.`,
    '4':  `No properties found. Try different search terms.`,
    '43': `No properties found on that street. Try leaving it blank to search the whole municipality.`,
    '67': `Too many results — please add a street name to narrow the search.`,
  };
  return map[code] || (desc ? `Catastro: ${desc}` : `Catastro error (code ${code}).`);
}

async function fetchXML(url) {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/xml, application/xml, */*', 'User-Agent': 'Parcela/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    console.error('[fetchXML]', e.message);
    return null;
  }
}
