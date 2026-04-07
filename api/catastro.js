// api/catastro.js
// Working approach confirmed via debugging:
// 1. ConsultaVia  → resolve exact street name from user input
// 2. ConsultaNumero → get all RCs on that street
// 3. Consulta_DNPRC for each RC → get m², year, address
// 4. Filter by m² ±15% → return ranked candidates
//
// Key findings from debug sessions:
// - Province names must match Catastro's exact list (e.g. "ILLES BALEARS" not "BALEARES")
// - Municipality names have no accents (e.g. "ARTA" not "ARTÀ")
// - Street names often have prefix (e.g. "DEL CARDENAL DESPUIG" not "CARDENAL DESPUIG")
// - All calls use plain HTTP — Catastro's SSL cert chain is broken (known issue)

import http from 'node:http';

const BASE = 'http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC';

// Official province names from ConsultaProvincia (exact strings Catastro accepts)
const PROVINCE_NAMES = {
  '01':'ALAVA','02':'ALBACETE','03':'ALACANT','04':'ALMERIA','05':'AVILA',
  '06':'BADAJOZ','07':'ILLES BALEARS','08':'BARCELONA','09':'BURGOS',
  '10':'CACERES','11':'CADIZ','12':'CASTELLO','13':'CIUDAD REAL','14':'CORDOBA',
  '15':'A CORUÑA','16':'CUENCA','17':'GIRONA','18':'GRANADA','19':'GUADALAJARA',
  '21':'HUELVA','22':'HUESCA','23':'JAEN','24':'LEON','25':'LLEIDA',
  '26':'LA RIOJA','27':'LUGO','28':'MADRID','29':'MALAGA','30':'MURCIA',
  '32':'OURENSE','33':'ASTURIAS','34':'PALENCIA','35':'LAS PALMAS',
  '36':'PONTEVEDRA','37':'SALAMANCA','38':'S.C. TENERIFE','39':'CANTABRIA',
  '40':'SEGOVIA','41':'SEVILLA','42':'SORIA','43':'TARRAGONA','44':'TERUEL',
  '45':'TOLEDO','46':'VALENCIA','47':'VALLADOLID','49':'ZAMORA','50':'ZARAGOZA',
  '51':'CEUTA','52':'MELILLA',
};

// Map user-friendly province inputs → province code
const PROVINCE_INPUT_MAP = {
  'illes balears':'07','baleares':'07','balears':'07','islas baleares':'07','mallorca':'07','ibiza':'07','menorca':'07',
  'barcelona':'08','madrid':'28','malaga':'29','málaga':'29','sevilla':'41','seville':'41',
  'valencia':'46','valència':'46','alicante':'03','alacant':'03','granada':'18',
  'tenerife':'38','santa cruz de tenerife':'38','las palmas':'35','gran canaria':'35',
  'cadiz':'11','cádiz':'11','cordoba':'14','córdoba':'14','murcia':'30',
  'zaragoza':'50','valladolid':'47','bilbao':'48','vizcaya':'48',
  'a coruña':'15','la coruña':'15','coruña':'15','pontevedra':'36',
  'girona':'17','lleida':'25','tarragona':'43','castellon':'12','castelló':'12',
  'toledo':'45','albacete':'02','ciudad real':'13','cuenca':'16','guadalajara':'19',
  'burgos':'09','leon':'24','león':'24','salamanca':'37','segovia':'40',
  'avila':'05','ávila':'05','soria':'42','zamora':'49','palencia':'34',
  'caceres':'10','cáceres':'10','badajoz':'06','huelva':'21','almeria':'04',
  'jaen':'23','jaén':'23','lugo':'27','ourense':'32','asturias':'33',
  'cantabria':'39','la rioja':'26','navarra':'31','huesca':'22','teruel':'44',
  'ceuta':'51','melilla':'52',
};

// Street type prefixes to auto-detect from user input
const STREET_PREFIXES = [
  [/^(AVENIDA|AVDA\.?|AV\.)\s+/i, 'AV'],
  [/^(CALLE|CARRER|CL\.)\s+/i,    'CL'],
  [/^(PLAZA|PLAÇA|PL\.?|PZA\.?)\s+/i, 'PZ'],
  [/^(PASEO|PASSEIG|PS\.)\s+/i,   'PS'],
  [/^(CARRETERA|CTRA\.?|CR\.)\s+/i,'CR'],
  [/^(RONDA|RD\.)\s+/i,            'RD'],
  [/^(CAMINO|CAMI|CM\.)\s+/i,      'CM'],
  [/^(GRAN VIA|GRAN VÍA)\s+/i,     'GV'],
  [/^(TRAVESIA|TRAVESÍA|TV\.)\s+/i,'TV'],
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rc, province, municipality, street, street_type, floor, m2, year_built } = req.body || {};

  // PATH A: Direct RC lookup
  if (rc && rc.replace(/\s/g,'').length >= 14) {
    try {
      const clean = rc.replace(/\s/g,'').toUpperCase();
      const result = await lookupRC(clean);
      if (!result) return res.status(404).json({ error: `No Catastro record found for RC: ${clean}` });
      return res.status(200).json({ path: 'rc_direct', candidates: [result], query: { rc: clean } });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PATH B: Street search
  if (!municipality) return res.status(400).json({ error: 'Municipality is required.' });
  if (!m2) return res.status(400).json({ error: 'Built area (m²) is required.' });
  if (!street) return res.status(400).json({ error: 'Street name is required to search.' });

  try {
    const provCode = resolveProvinceCode(province, municipality);
    if (!provCode) {
      return res.status(400).json({
        error: `Could not determine province for "${municipality}". Please fill in the Province field.`
      });
    }
    const provName = PROVINCE_NAMES[provCode];
    const muniName = municipality.toUpperCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents for municipality

    const { sigla, streetName } = parseStreetInput(street, street_type || 'CL');

    const candidates = await searchByStreet({
      provName, muniName, sigla, streetName,
      m2: parseFloat(m2), floor, year_built,
    });

    return res.status(200).json({
      path: 'street',
      candidates,
      query: { province: provName, municipality: muniName, street: streetName, street_type: sigla, m2, floor },
    });
  } catch(e) {
    console.error('[catastro]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── RESOLVE PROVINCE CODE ─────────────────────────────────────────────────────
function resolveProvinceCode(province, municipality) {
  if (province) {
    const key = province.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Direct match
    if (PROVINCE_INPUT_MAP[key]) return PROVINCE_INPUT_MAP[key];
    // Partial match
    for (const [k, v] of Object.entries(PROVINCE_INPUT_MAP)) {
      if (key.includes(k) || k.includes(key)) return v;
    }
  }
  // Infer from municipality name
  const mkey = municipality.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return PROVINCE_INPUT_MAP[mkey] || null;
}

// ── PARSE STREET INPUT ────────────────────────────────────────────────────────
function parseStreetInput(street, defaultType) {
  for (const [pattern, sigla] of STREET_PREFIXES) {
    if (pattern.test(street)) {
      return { sigla, streetName: street.replace(pattern, '').trim().toUpperCase() };
    }
  }
  return { sigla: defaultType.toUpperCase(), streetName: street.trim().toUpperCase() };
}

// ── MAIN SEARCH FLOW ──────────────────────────────────────────────────────────
async function searchByStreet({ provName, muniName, sigla, streetName, m2, floor, year_built }) {

  // Steps 1+2 in parallel: resolve exact street name AND get RCs simultaneously
  const [exactStreet, rcListFromInput] = await Promise.all([
    resolveStreetName(provName, muniName, sigla, streetName),
    getAllRCsOnStreet(provName, muniName, sigla, streetName),
  ]);

  if (!exactStreet) {
    throw new Error(
      `Street "${sigla} ${streetName}" not found in ${muniName}. ` +
      `Check the spelling — try a partial name (e.g. "CARDENAL" instead of "CARDENAL DESPUIG").`
    );
  }

  // If exact name differs from input and we got no RCs from input, fetch with exact name
  let rcList = rcListFromInput;
  if (rcList.length === 0 && exactStreet !== streetName.toUpperCase()) {
    rcList = await getAllRCsOnStreet(provName, muniName, sigla, exactStreet);
  }

  if (rcList.length === 0) {
    throw new Error(`No properties found on ${sigla} ${exactStreet} in ${muniName}.`);
  }

  // Step 3: Fetch full data for each RC in parallel (cap at 20 to stay within timeout)
  const batch = rcList.slice(0, 20);
  const fullData = await Promise.all(
    batch.map(rc => lookupRC(rc).catch(() => null))
  );
  const valid = fullData.filter(Boolean);

  if (valid.length === 0) {
    throw new Error('Found properties but could not fetch their details. Please try again.');
  }

  // Step 4: Filter and score by m²
  const m2Min = m2 * 0.85;
  const m2Max = m2 * 1.15;

  let matched = valid.filter(p => {
    const bm2 = p.cadastralData?.builtAreaM2;
    return !bm2 || (bm2 >= m2Min && bm2 <= m2Max);
  });

  // If nothing in tolerance, return closest anyway
  if (matched.length === 0) {
    matched = [...valid].sort((a, b) => {
      const da = Math.abs((a.cadastralData?.builtAreaM2 || 0) - m2);
      const db = Math.abs((b.cadastralData?.builtAreaM2 || 0) - m2);
      return da - db;
    }).slice(0, 3);
  }

  const scored = matched.map(p => {
    const bm2 = p.cadastralData?.builtAreaM2;
    const yr = p.cadastralData?.yearBuilt;
    let score = 70;
    if (bm2) score += Math.round((1 - Math.min(Math.abs(bm2 - m2) / m2, 1)) * 25);
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

// ── STEP 1: Resolve exact street name ────────────────────────────────────────
async function resolveStreetName(provName, muniName, sigla, streetName) {
  // ConsultaVia does partial matching — great for resolving exact names
  const url = `${BASE}/OVCCallejero.asmx/ConsultaVia` +
    `?Provincia=${enc(provName)}&Municipio=${enc(muniName)}` +
    `&TipoVia=${enc(sigla)}&NombreVia=${enc(streetName)}`;

  const xml = await fetchXML(url);
  if (!xml) return null;

  // Extract street names from response
  const streets = [];
  for (const m of xml.matchAll(/<nv>([^<]+)<\/nv>/gi)) {
    streets.push(m[1].trim());
  }
  if (streets.length === 0) return null;

  // Pick best match — prefer exact, then starts-with, then first
  const upper = streetName.toUpperCase();
  return streets.find(s => s === upper)
    || streets.find(s => s.includes(upper) || upper.includes(s.replace(/^(DEL?|DE LA|LOS|LAS)\s+/i, '')))
    || streets[0];
}

// ── STEP 2: Get all RCs on a street ──────────────────────────────────────────
async function getAllRCsOnStreet(provName, muniName, sigla, streetName) {
  // ConsultaNumero returns all street numbers with their RCs
  // Pass Numero=1 — if it doesn't exist it returns a list of nearby numbers
  const url = `${BASE}/OVCCallejero.asmx/ConsultaNumero` +
    `?Provincia=${enc(provName)}&Municipio=${enc(muniName)}` +
    `&TipoVia=${enc(sigla)}&NomVia=${enc(streetName)}&Numero=1`;

  const xml = await fetchXML(url);
  if (!xml) return [];

  const rcs = [];
  for (const m of xml.matchAll(/<nump>([\s\S]*?)<\/nump>/gi)) {
    const block = m[1];
    const pc1 = block.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
    const pc2 = block.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
    if (pc1 && pc2) rcs.push((pc1 + pc2).toUpperCase());
  }
  return [...new Set(rcs)]; // deduplicate
}

// ── RC LOOKUP ────────────────────────────────────────────────────────────────
async function lookupRC(rc) {
  const url = `${BASE}/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${enc(rc)}`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  return parsePropertyXML(xml, rc);
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

  const tv=g('tv')||''; const nv=g('nv')||''; const pnp=g('pnp')||'';
  const bq=g('bq')||''; const es=g('es')||''; const pt=g('pt')||''; const pu=g('pu')||'';
  const muni=g('nm')||g('municipio')||''; const prov=g('np')||g('provincia')||'';
  const cp=g('dp')||g('cp')||'';

  const addressParts = [
    [tv,nv].filter(Boolean).join(' '),
    pnp?`nº ${pnp}`:'', bq?`Bloque ${bq}`:'',
    es?`Esc. ${es}`:'', pt?`Planta ${pt}`:'', pu?`Pta. ${pu}`:'',
  ].filter(Boolean).join(', ');
  const address = [addressParts, cp, muni, prov].filter(Boolean).join(', ');

  const uso=g('luso')||g('uso');
  const sfc=g('sfc')?parseFloat(g('sfc')):null;
  const stl=g('stl')?parseFloat(g('stl')):null;
  const ant=g('ant')?parseInt(g('ant')):null;
  const vv=g('vv')?parseFloat(g('vv')):null;
  const npr=g('npr')?parseInt(g('npr')):null;

  const useMap={V:'Residential (dwelling)',R:'Residential (multi-unit)',
    I:'Industrial',O:'Office',C:'Commercial',A:'Agricultural',
    T:'Tourism / holiday',G:'Garage',Z:'Other'};

  const r1=rc.substring(0,7); const r2=rc.substring(7,14);
  const catUrl=`https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?RC1=${r1}&RC2=${r2}&pest=rc&RCCompleta=${rc}&from=OVCBusqueda&tipoCarto=nuevo`;

  return {
    rc, address: address||null,
    addressComponents:{streetType:tv||null,streetName:nv||null,number:pnp||null,
      block:bq||null,staircase:es||null,floor:pt||null,door:pu||null,
      postcode:cp||null,municipality:muni||null,province:prov||null},
    cadastralData:{use:useMap[uso]||uso||null,builtAreaM2:sfc||stl||null,
      yearBuilt:ant,cadastralValue:vv,numberOfFloors:npr},
    catastroUrl:catUrl,
    source:'Catastro OVC — Ministerio de Hacienda',
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function enc(s) { return encodeURIComponent(s||''); }

function fetchXML(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: 80,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { Accept: 'text/xml, application/xml, */*', 'User-Agent': 'Parcela/1.0', Connection: 'close' },
      timeout: 12000,
    }, (r) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', c => { data += c; });
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(data);
        else { console.error('[fetchXML] HTTP', r.statusCode, url.substring(0,80)); resolve(null); }
      });
    });
    req.on('error', e => { console.error('[fetchXML]', e.message, url.substring(0,80)); resolve(null); });
    req.on('timeout', () => { req.destroy(); console.error('[fetchXML] timeout', url.substring(0,80)); resolve(null); });
    req.end();
  });
}
