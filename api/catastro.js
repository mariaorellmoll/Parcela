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
    const candidates = await streetSearch({ province, municipality, street, street_type, floor, door, m2: parseFloat(m2), year_built });
    return res.status(200).json({ path: 'street', candidates, query: { province, municipality, street, m2, floor, year_built } });
  } catch(e) {
    console.error('catastro street search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── DIRECT RC LOOKUP ──────────────────────────────────────────────────────────
async function lookupRC(rc) {
  const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC` +
    `?Provincia=&Municipio=&RC=${encodeURIComponent(rc)}`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  return parseProperty(xml, rc);
}

// ── STREET SEARCH ─────────────────────────────────────────────────────────────
// Uses Consulta_DNPLOC: returns all properties matching province+municipality+street
// Then fetches full data for each and filters by m²
async function streetSearch({ province, municipality, street, street_type, floor, door, m2, year_built }) {
  const sigla = street_type || 'CL'; // default to Calle
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
    throw new Error(`Catastro did not respond. Check the municipality name is spelled correctly in Spanish (e.g. "Palma de Mallorca", not "Palma").`);
  }

  // Check for Catastro error codes
  const errCode = listXml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  const errDesc = listXml.match(/<des>([^<]+)<\/des>/i)?.[1];
  if (errCode && errCode !== '0') {
    const friendly = catastroError(errCode, errDesc, { municipality, street });
    throw new Error(friendly);
  }

  // Parse the list response — may return either a list of inmuebles or a single property
  const rcList = parseRCList(listXml);

  if (rcList.length === 0) {
    // Single property response — parse directly
    const single = parseProperty(listXml, null);
    if (single?.rc) return [{ ...single, matchScore: 100 }];
    throw new Error(`No properties found in "${muni}"${street ? ` on "${street}"` : ''}. Try a different street name or leave it blank to search the whole municipality.`);
  }

  if (rcList.length > 200) {
    throw new Error(`Too many results (${rcList.length} properties). Add a street name to narrow the search.`);
  }

  // Step 2: Fetch full data for each RC in parallel (max 30 at a time)
  const batch = rcList.slice(0, 30);
  const fullData = await Promise.all(
    batch.map(async (item) => {
      try {
        const full = await lookupRC(item.rc);
        return full;
      } catch { return null; }
    })
  );

  const valid = fullData.filter(Boolean);
  if (valid.length === 0) {
    throw new Error(`Found ${rcList.length} properties but could not fetch their details. Try again shortly.`);
  }

  // Step 3: Filter and score by m²
  const m2Tol = 0.15;
  const m2Min = m2 * (1 - m2Tol);
  const m2Max = m2 * (1 + m2Tol);

  const scored = valid
    .filter(p => {
      const bm2 = p?.cadastralData?.builtAreaM2;
      // Include if m² matches within tolerance, OR if no m² data (don't exclude blindly)
      if (bm2 && (bm2 < m2Min || bm2 > m2Max)) return false;
      return true;
    })
    .map(p => {
      const bm2 = p?.cadastralData?.builtAreaM2;
      const yr  = p?.cadastralData?.yearBuilt;
      let score = 70; // base score for matching municipality/street

      // m² score (up to +30)
      if (bm2) {
        const diff = Math.abs(bm2 - m2) / m2;
        score += Math.round((1 - diff) * 30);
      }
      // Year built bonus (up to +10)
      if (year_built && yr) {
        const diff = Math.abs(yr - parseInt(year_built));
        if (diff === 0) score += 10;
        else if (diff <= 2) score += 7;
        else if (diff <= 5) score += 3;
      }
      // Floor match bonus (+5)
      if (floor && p?.addressComponents?.floor) {
        const pf = p.addressComponents.floor.toString().toLowerCase();
        const qf = floor.toString().toLowerCase();
        if (pf === qf || pf.includes(qf) || qf.includes(pf)) score += 5;
      }

      return { ...p, matchScore: Math.min(100, score) };
    });

  // Sort by score, take top 5
  scored.sort((a, b) => b.matchScore - a.matchScore);
  return scored.slice(0, 5);
}

// ── PARSE RC LIST FROM Consulta_DNPLOC response ───────────────────────────────
function parseRCList(xml) {
  const results = [];

  // Format 1: <inmueble> blocks with <rc><pc1>...<pc2>... structure
  const inmuebles = [...xml.matchAll(/<inmueble>([\s\S]*?)<\/inmueble>/gi)];
  inmuebles.forEach(m => {
    const block = m[1];
    const pc1 = block.match(/<pc1>([^<]+)<\/pc1>/i)?.[1]?.trim();
    const pc2 = block.match(/<pc2>([^<]+)<\/pc2>/i)?.[1]?.trim();
    if (pc1 && pc2) {
      results.push({ rc: (pc1 + pc2).toUpperCase() });
      return;
    }
    const rc = block.match(/<rc>([^<]+)<\/rc>/i)?.[1]?.trim();
    if (rc) results.push({ rc: rc.toUpperCase() });
  });

  // Format 2: <bico> blocks
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

  // Check for errors
  const errCode = xml.match(/<cuerr>(\d+)<\/cuerr>/i)?.[1];
  if (errCode && errCode !== '0') return null;

  const get = (tag) => xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`, 'i'))?.[1]?.trim() || null;

  // RC: try pc1+pc2 first, then rc directly
  const pc1 = get('pc1');
  const pc2 = get('pc2');
  const rc = pc1 && pc2 ? (pc1 + pc2).toUpperCase()
           : (get('rc') || rcFallback || '').toUpperCase();

  if (!rc) return null;

  // Address
  const tv    = get('tv') || get('tipovia') || '';
  const nv    = get('nv') || get('nombrevia') || '';
  const pnp   = get('pnp') || '';
  const bq    = get('bq') || '';
  const es    = get('es') || '';
  const pt    = get('pt') || '';
  const pu    = get('pu') || '';
  const muni  = get('nm') || get('municipio') || '';
  const prov  = get('np') || get('provincia') || '';
  const cp    = get('dp') || get('cp') || '';

  const streetStr = [tv, nv].filter(Boolean).join(' ');
  const detailStr = [
    pnp ? `nº ${pnp}` : '',
    bq  ? `Bloque ${bq}` : '',
    es  ? `Esc. ${es}` : '',
    pt  ? `Planta ${pt}` : '',
    pu  ? `Pta. ${pu}` : '',
  ].filter(Boolean).join(', ');

  const address = [streetStr, detailStr, cp, muni, prov].filter(Boolean).join(', ');

  // Property data — Catastro uses different tags in different responses
  const uso   = get('luso') || get('uso') || null;
  const sfc   = get('sfc') ? parseFloat(get('sfc')) : null;
  const ant   = get('ant') ? parseInt(get('ant')) : null;
  const vv    = get('vv')  ? parseFloat(get('vv'))  : null;
  const npr   = get('npr') ? parseInt(get('npr'))   : null;

  // Some responses encode area in <stl> or <ssuelo>
  const stl   = get('stl') ? parseFloat(get('stl')) : null;
  const builtM2 = sfc || stl || null;

  const useMap = { V:'Residential (dwelling)', R:'Residential (multi-unit)',
    I:'Industrial', O:'Office', C:'Commercial', A:'Agricultural',
    T:'Tourism / holiday', G:'Garage', Y:'Sports / leisure', Z:'Other' };

  // Build Catastro web link
  const rc1 = rc.substring(0, 7);
  const rc2 = rc.substring(7, 14);
  const catUrl = `https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?RC1=${rc1}&RC2=${rc2}&pest=rc&RCCompleta=${rc}&from=OVCBusqueda&tipoCarto=nuevo`;

  return {
    rc,
    address: address || null,
    addressComponents: {
      streetType: tv || null,
      streetName: nv || null,
      number: pnp || null,
      block: bq || null,
      staircase: es || null,
      floor: pt || null,
      door: pu || null,
      postcode: cp || null,
      municipality: muni || null,
      province: prov || null,
    },
    cadastralData: {
      use: useMap[uso] || uso || null,
      builtAreaM2: builtM2,
      yearBuilt: ant,
      cadastralValue: vv,
      numberOfFloors: npr,
    },
    catastroUrl: catUrl,
    source: 'Catastro OVC — Ministerio de Hacienda',
  };
}

// ── FRIENDLY ERROR MESSAGES ───────────────────────────────────────────────────
function catastroError(code, desc, { municipality, street }) {
  const map = {
    '1':  `Municipality "${municipality}" not found. Try the full official name in Spanish (e.g. "Palma de Mallorca", "Sant Antoni de Portmany").`,
    '2':  `Province not recognised. Try leaving the province field blank.`,
    '3':  `Street "${street}" not found in "${municipality}". Try leaving street blank to search the whole municipality, or check the spelling.`,
    '4':  `No properties found matching these details in "${municipality}".`,
    '43': `No properties found. Try a different street name or leave it blank.`,
    '67': `Too many results — add a street name to narrow down.`,
  };
  return map[code] || (desc ? `Catastro error: ${desc}` : `Catastro returned an error (code ${code}). Check the municipality name.`);
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
    console.error('fetchXML error:', e.message, url.substring(0, 100));
    return null;
  }
}
