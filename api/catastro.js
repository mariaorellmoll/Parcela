// api/catastro.js
// Two search paths:
// A) Direct RC lookup → Consulta_DNPRC (exact)
// B) Street search → Consulta_DNPLOC (province+municipality+street) → list of RCs
//    → Consulta_DNPRC for each → filter by m² ±15% → rank → return top 5

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rc, province, municipality, street, street_type, floor, door, m2, year_built } = req.body || {};

  // ── PATH A: Direct RC lookup ──────────────────────────────────────────────
  if (rc && rc.replace(/\s/g,'').length >= 14) {
    try {
      const clean = rc.replace(/\s/g,'').toUpperCase();
      const result = await lookupRC(clean);
      if (!result) return res.status(404).json({ error: `No property found for RC: ${clean}` });
      return res.status(200).json({ path: 'rc_direct', candidates: [result], query: { rc: clean } });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATH B: Street/neighbourhood search ──────────────────────────────────
  if (!municipality) {
    return res.status(400).json({ error: 'Municipality is required for neighbourhood search.' });
  }
  if (!m2) {
    return res.status(400).json({ error: 'Built area (m²) is required — it is the primary matching signal.' });
  }

  try {
    // Normalise street: auto-detect type if embedded in name (e.g. "Avenida Mèxic" → type=AV, name="Mèxic")
    const { sigla, calle } = normaliseStreet(street, street_type);

    // Normalise municipality name to Catastro's format, try variants on failure
    const candidates = await streetSearchWithRetry({
      province, municipality, street: calle, street_type: sigla, floor, door,
      m2: parseFloat(m2), year_built
    });
    return res.status(200).json({ path: 'street', candidates, query: { province, municipality, street: calle, street_type: sigla, m2, floor, year_built } });
  } catch(e) {
    console.error('catastro street search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── MUNICIPALITY NAME NORMALISER ──────────────────────────────────────────────
// Catastro uses its own internal names — often shorter than what people type.
// We try the user's input first, then fall back through known variants.
const MUNI_VARIANTS = {
  'palma de mallorca': ['PALMA', 'PALMA DE MALLORCA'],
  'palma':             ['PALMA', 'PALMA DE MALLORCA'],
  'barcelona':         ['BARCELONA'],
  'madrid':            ['MADRID'],
  'ibiza':             ['EIVISSA', 'IBIZA'],
  'eivissa':           ['EIVISSA', 'IBIZA'],
  'sant antoni de portmany': ['SANT ANTONI DE PORTMANY', 'SANT ANTONI'],
  'santa eularia des riu':   ['SANTA EULARIA DES RIU', 'SANTA EULALIA DEL RIO'],
  'santa eulalia':           ['SANTA EULARIA DES RIU', 'SANTA EULALIA DEL RIO'],
  'soller':            ['SOLLER', 'SÓLLER'],
  'sóller':            ['SOLLER', 'SÓLLER'],
  'pollenca':          ['POLLENCA', 'POLLENÇA'],
  'pollença':          ['POLLENÇA', 'POLLENCA'],
  'alcudia':           ['ALCUDIA', 'ALCÚDIA'],
  'alcúdia':           ['ALCÚDIA', 'ALCUDIA'],
  'arta':              ['ARTA', 'ARTÀ'],
  'artà':              ['ARTÀ', 'ARTA'],
  'manacor':           ['MANACOR'],
  'inca':              ['INCA'],
  'llucmajor':         ['LLUCMAJOR'],
  'felanitx':          ['FELANITX'],
  'calvia':            ['CALVIA', 'CALVIÀ'],
  'calvià':            ['CALVIÀ', 'CALVIA'],
  'andratx':           ['ANDRATX'],
  'campos':            ['CAMPOS'],
  'santanyi':          ['SANTANYI', 'SANTANYÍ'],
  'santanyí':          ['SANTANYÍ', 'SANTANYI'],
  'valencia':          ['VALENCIA', 'VALÈNCIA'],
  'seville':           ['SEVILLA'],
  'sevilla':           ['SEVILLA'],
  'malaga':            ['MALAGA', 'MÁLAGA'],
  'málaga':            ['MÁLAGA', 'MALAGA'],
  'marbella':          ['MARBELLA'],
  'fuengirola':        ['FUENGIROLA'],
  'torremolinos':      ['TORREMOLINOS'],
  'granada':           ['GRANADA'],
  'alicante':          ['ALICANTE', 'ALACANT'],
  'benidorm':          ['BENIDORM'],
  'tenerife':          ['SANTA CRUZ DE TENERIFE'],
  'las palmas':        ['LAS PALMAS DE GRAN CANARIA'],
};

function getMuniVariants(municipality) {
  const key = municipality.toLowerCase().trim();
  const known = MUNI_VARIANTS[key];
  if (known) return known;
  // Always try: as-is uppercase, then without accents
  const upper = municipality.toUpperCase().trim();
  const noAccent = upper
    .replace(/Á/g,'A').replace(/É/g,'E').replace(/Í/g,'I')
    .replace(/Ó/g,'O').replace(/Ú/g,'U').replace(/Ü/g,'U')
    .replace(/À/g,'A').replace(/È/g,'E').replace(/Ì/g,'I')
    .replace(/Ò/g,'O').replace(/Ù/g,'U').replace(/Ï/g,'I')
    .replace(/Ñ/g,'N').replace(/Ç/g,'C').replace(/·/g,'');
  const variants = [upper];
  if (noAccent !== upper) variants.push(noAccent);
  // Also try without "de", "del", "de la" suffixes
  const stripped = upper.replace(/ DE (LA |LOS |LAS |EL )?/g, ' ').trim();
  if (stripped !== upper) variants.push(stripped);
  return [...new Set(variants)];
}

// ── STREET TYPE AUTO-DETECTOR ─────────────────────────────────────────────────
// If user types "Avenida Mèxic" in street name, extract type=AV, name="Mèxic"
const STREET_PREFIXES = [
  { prefix: /^(AV\.|AVDA\.?|AVENIDA)\s+/i, sigla: 'AV' },
  { prefix: /^(CL\.?|CALLE|CARRER)\s+/i,   sigla: 'CL' },
  { prefix: /^(PL\.?|PLAZA|PLAÇA)\s+/i,     sigla: 'PZ' },
  { prefix: /^(PS\.?|PASEO|PASSEIG)\s+/i,   sigla: 'PS' },
  { prefix: /^(CR\.?|CARRETERA)\s+/i,        sigla: 'CR' },
  { prefix: /^(RD\.?|RONDA)\s+/i,            sigla: 'RD' },
  { prefix: /^(TV\.?|TRAVESIA|TRAVESÍA)\s+/i, sigla: 'TV' },
  { prefix: /^(CM\.?|CAMINO|CAMI)\s+/i,      sigla: 'CM' },
  { prefix: /^(UR\.?|URBANIZACION|URBANIZACIÓN)\s+/i, sigla: 'UR' },
  { prefix: /^(GV\.?|GRAN VIA|GRAN VÍA)\s+/i, sigla: 'GV' },
];

function normaliseStreet(street, street_type) {
  if (!street) return { sigla: street_type || 'CL', calle: '' };

  for (const { prefix, sigla } of STREET_PREFIXES) {
    if (prefix.test(street)) {
      const calle = street.replace(prefix, '').trim();
      return { sigla, calle };
    }
  }
  // No prefix detected — use the selected street_type
  return { sigla: street_type || 'CL', calle: street.trim() };
}

// ── STREET SEARCH WITH MUNICIPALITY RETRY ────────────────────────────────────
async function streetSearchWithRetry(params) {
  const variants = getMuniVariants(params.municipality);

  let lastError = null;
  for (const muniVariant of variants) {
    try {
      const result = await streetSearch({ ...params, municipality: muniVariant });
      return result;
    } catch(e) {
      lastError = e;
      // Only retry on municipality-not-found errors
      if (!e.message.includes('not found') && !e.message.includes('no encontrado') && !e.message.includes('error 1') && !e.message.includes('(code 1)')) {
        throw e; // Non-municipality error — don't retry
      }
      console.log(`Municipality "${muniVariant}" failed, trying next variant...`);
    }
  }

  // All variants failed — give helpful message
  const tried = variants.join('", "');
  throw new Error(
    `Municipality not found in Catastro. Tried: "${tried}".\n\n` +
    `Tips:\n` +
    `— Use the official Spanish name (e.g. "Palma" not "Palma de Mallorca")\n` +
    `— Balearic towns often use Catalan names (e.g. "Eivissa" not "Ibiza", "Sóller" not "Soller")\n` +
    `— The Basque Country and Navarre have separate registries not covered by Catastro`
  );
}

// ── STREET SEARCH ─────────────────────────────────────────────────────────────
async function streetSearch({ province, municipality, street, street_type, floor, door, m2, year_built }) {
  const sigla = street_type || 'CL';
  const calle = street || '';
  const prov  = province || '';
  const muni  = municipality;

  // Step 1: Get list of RCs matching the street in this municipality
  const listUrl = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC` +
    `?Provincia=${encodeURIComponent(prov)}` +
    `&Municipio=${encodeURIComponent(muni)}` +
    `&Sigla=${encodeURIComponent(sigla)}` +
    `&Calle=${encodeURIComponent(calle)}` +
    `&Numero=` +
    `&Bloque=` +
    `&Escalera=` +
    `&Planta=${encodeURIComponent(floor || '')}` +
    `&Puerta=${encodeURIComponent(door || '')}`;

  const listXml = await fetchXML(listUrl);
  if (!listXml) {
    throw new Error(`Catastro did not respond. Check your internet connection and try again.`);
  }

  // Check for Catastro error codes
  const errCode = listXml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  const errDesc = listXml.match(/<des>([^<]+)<\/des>/i)?.[1];
  if (errCode && errCode !== '0') {
    throw new Error(catastroError(errCode, errDesc, { municipality: muni, street: calle }));
  }

  // Parse the list — may return a list of inmuebles or a single property directly
  const rcList = parseRCList(listXml);

  if (rcList.length === 0) {
    // Single property response — parse directly
    const single = parseProperty(listXml, null);
    if (single?.rc) return [{ ...single, matchScore: 100 }];
    throw new Error(`No properties found in "${muni}"${calle ? ` on "${sigla} ${calle}"` : ''}. Try a different street name or leave it blank.`);
  }

  if (rcList.length > 500) {
    throw new Error(`Too many results (${rcList.length} properties in "${muni}"). Add a street name to narrow the search.`);
  }

  // Step 2: Fetch full data for each RC in parallel (max 30 at a time to avoid timeouts)
  const batch = rcList.slice(0, 30);
  const fullData = await Promise.all(
    batch.map(async (item) => {
      try { return await lookupRC(item.rc); }
      catch { return null; }
    })
  );

  const valid = fullData.filter(Boolean);
  if (valid.length === 0) {
    throw new Error(`Found ${rcList.length} properties but could not fetch their details. Try again shortly — Catastro may be slow.`);
  }

  // Step 3: Filter by m² (±15%) and score
  const m2Tol = 0.15;
  const m2Min = m2 * (1 - m2Tol);
  const m2Max = m2 * (1 + m2Tol);

  const scored = valid
    .filter(p => {
      const bm2 = p?.cadastralData?.builtAreaM2;
      if (bm2 && (bm2 < m2Min || bm2 > m2Max)) return false;
      return true;
    })
    .map(p => {
      const bm2 = p?.cadastralData?.builtAreaM2;
      const yr  = p?.cadastralData?.yearBuilt;
      let score = 70;

      if (bm2) {
        const diff = Math.abs(bm2 - m2) / m2;
        score += Math.round((1 - diff) * 30);
      }
      if (year_built && yr) {
        const diff = Math.abs(yr - parseInt(year_built));
        if (diff === 0) score += 10;
        else if (diff <= 2) score += 7;
        else if (diff <= 5) score += 3;
      }
      if (floor && p?.addressComponents?.floor) {
        const pf = p.addressComponents.floor.toString().toLowerCase();
        const qf = floor.toString().toLowerCase();
        if (pf === qf || pf.includes(qf) || qf.includes(pf)) score += 5;
      }
      return { ...p, matchScore: Math.min(100, score) };
    });

  scored.sort((a, b) => b.matchScore - a.matchScore);

  // If nothing matched within m² tolerance, return top 5 of what we have anyway
  // with a note that m² didn't match — better than empty results
  if (scored.length === 0) {
    const fallback = valid.slice(0, 5).map(p => ({ ...p, matchScore: 50, m2MatchNote: 'outside_tolerance' }));
    return fallback;
  }

  return scored.slice(0, 5);
}

// ── PARSE RC LIST FROM Consulta_DNPLOC response ───────────────────────────────
function parseRCList(xml) {
  const results = [];

  const inmuebles = [...xml.matchAll(/<inmueble>([\s\S]*?)<\/inmueble>/gi)];
  inmuebles.forEach(m => {
    const block = m[1];
    const pc1 = block.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
    const pc2 = block.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
    if (pc1 && pc2) { results.push({ rc: (pc1 + pc2).toUpperCase() }); return; }
    const rc = block.match(/<rc>([^<]+)<\/rc>/i)?.[1]?.trim();
    if (rc) results.push({ rc: rc.toUpperCase() });
  });

  if (results.length === 0) {
    const bicos = [...xml.matchAll(/<bico>([\s\S]*?)<\/bico>/gi)];
    bicos.forEach(m => {
      const block = m[1];
      const pc1 = block.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
      const pc2 = block.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
      if (pc1 && pc2) results.push({ rc: (pc1 + pc2).toUpperCase() });
    });
  }

  return results;
}

// ── PARSE SINGLE PROPERTY from Consulta_DNPRC response ───────────────────────
function parseProperty(xml, rcFallback) {
  if (!xml) return null;
  const errCode = xml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  if (errCode && errCode !== '0') return null;

  const get = (tag) => xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`, 'i'))?.[1]?.trim() || null;

  const pc1 = get('pc1'); const pc2 = get('pc2');
  const rc = pc1 && pc2 ? (pc1 + pc2).toUpperCase() : (get('rc') || rcFallback || '').toUpperCase();
  if (!rc) return null;

  const tv = get('tv') || ''; const nv = get('nv') || '';
  const pnp = get('pnp') || ''; const bq = get('bq') || '';
  const es = get('es') || ''; const pt = get('pt') || '';
  const pu = get('pu') || ''; const muni = get('nm') || get('municipio') || '';
  const prov = get('np') || get('provincia') || '';
  const cp = get('dp') || get('cp') || '';

  const streetStr = [tv, nv].filter(Boolean).join(' ');
  const detailStr = [
    pnp ? `nº ${pnp}` : '', bq ? `Bloque ${bq}` : '',
    es ? `Esc. ${es}` : '', pt ? `Planta ${pt}` : '', pu ? `Pta. ${pu}` : '',
  ].filter(Boolean).join(', ');
  const address = [streetStr, detailStr, cp, muni, prov].filter(Boolean).join(', ');

  const uso = get('luso') || get('uso') || null;
  const sfc = get('sfc') ? parseFloat(get('sfc')) : null;
  const stl = get('stl') ? parseFloat(get('stl')) : null;
  const ant = get('ant') ? parseInt(get('ant')) : null;
  const vv  = get('vv')  ? parseFloat(get('vv'))  : null;
  const npr = get('npr') ? parseInt(get('npr'))   : null;

  const useMap = {
    V:'Residential (dwelling)', R:'Residential (multi-unit)',
    I:'Industrial', O:'Office', C:'Commercial', A:'Agricultural',
    T:'Tourism / holiday', G:'Garage', Y:'Sports / leisure', Z:'Other',
  };

  const rc1 = rc.substring(0,7); const rc2 = rc.substring(7,14);
  const catUrl = `https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?RC1=${rc1}&RC2=${rc2}&pest=rc&RCCompleta=${rc}&from=OVCBusqueda&tipoCarto=nuevo`;

  return {
    rc,
    address: address || null,
    addressComponents: {
      streetType: tv || null, streetName: nv || null, number: pnp || null,
      block: bq || null, staircase: es || null, floor: pt || null,
      door: pu || null, postcode: cp || null, municipality: muni || null, province: prov || null,
    },
    cadastralData: {
      use: useMap[uso] || uso || null,
      builtAreaM2: sfc || stl || null,
      yearBuilt: ant, cadastralValue: vv, numberOfFloors: npr,
    },
    catastroUrl: catUrl,
    source: 'Catastro OVC — Ministerio de Hacienda',
  };
}

// ── DIRECT RC LOOKUP ──────────────────────────────────────────────────────────
async function lookupRC(rc) {
  const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC` +
    `?Provincia=&Municipio=&RC=${encodeURIComponent(rc)}`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  return parseProperty(xml, rc);
}

// ── FRIENDLY ERROR MESSAGES ───────────────────────────────────────────────────
function catastroError(code, desc, { municipality, street }) {
  const map = {
    '1':  `Municipality not found (code 1) — "${municipality}" not recognised by Catastro.`,
    '2':  `Province not recognised. Try leaving the province field blank.`,
    '3':  `Street "${street}" not found in "${municipality}". Try leaving street blank to search the whole municipality, or check the spelling.`,
    '4':  `No properties found matching these details.`,
    '43': `No properties found. Try a different street name or leave it blank.`,
    '67': `Too many results — add a street name to narrow down.`,
  };
  return map[code] || (desc ? `Catastro error: ${desc}` : `Catastro returned error code ${code}. Check the municipality name.`);
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
async function fetchXML(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/xml, application/xml, */*', 'User-Agent': 'Parcela/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch(e) {
    console.error('fetchXML error:', e.message, url.substring(0,120));
    return null;
  }
}
