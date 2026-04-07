// api/catastro.js
// Finds a property in Catastro from listing characteristics (neighbourhood + m² + floor + beds)
// Strategy:
//   1. Geocode the neighbourhood/zone to lat/lon via Nominatim
//   2. Query Catastro INSPIRE WFS for all parcels in bounding box
//   3. Filter by m² (±15%), floor, year built
//   4. For each match, fetch full property data from Catastro OVC
//   5. Return ranked candidates with real address + all data

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { neighbourhood, municipality, province, m2, floor, beds, year_built, rc } = req.body || {};

  // Path A: direct RC lookup (fastest, most accurate)
  if (rc && rc.trim().length >= 14) {
    try {
      const result = await lookupByRC(rc.trim().toUpperCase());
      return res.status(200).json({ path: 'rc_direct', candidates: result ? [result] : [], query: { rc } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Path B: fuzzy match from listing characteristics
  if (!neighbourhood && !municipality) {
    return res.status(400).json({ error: 'Provide neighbourhood/municipality or a cadastral reference (RC)' });
  }
  if (!m2) {
    return res.status(400).json({ error: 'Built area (m²) is required for property matching' });
  }

  try {
    const query = { neighbourhood, municipality, province, m2: parseFloat(m2), floor, beds, year_built };
    const candidates = await fuzzyFind(query);
    return res.status(200).json({ path: 'fuzzy', candidates, query });
  } catch (e) {
    console.error('catastro error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── DIRECT RC LOOKUP ──────────────────────────────────────────────────────────
async function lookupByRC(rc) {
  const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${encodeURIComponent(rc)}`;
  const xml = await fetchXML(url);
  if (!xml) throw new Error('Catastro did not return data for this reference');
  return parseOVCProperty(xml, rc);
}

// ── FUZZY FIND ────────────────────────────────────────────────────────────────
async function fuzzyFind(query) {
  const { neighbourhood, municipality, province, m2, floor, beds, year_built } = query;

  // Step 1: Geocode to get coordinates
  const searchTerm = [neighbourhood, municipality, province, 'Spain'].filter(Boolean).join(', ');
  const geo = await geocode(searchTerm);
  if (!geo) throw new Error(`Could not locate "${searchTerm}" — try a more specific area name`);

  // Step 2: Build bounding box (roughly 800m radius around the geocoded point)
  const delta = 0.008; // ~800m in degrees
  const bbox = `${geo.lon - delta},${geo.lat - delta},${geo.lon + delta},${geo.lat + delta}`;

  // Step 3: Query Catastro INSPIRE WFS for parcels in bounding box
  const parcels = await queryWFS(bbox, geo);
  if (!parcels || parcels.length === 0) {
    throw new Error(`No Catastro data found for this area. Try a different neighbourhood name or expand the search area.`);
  }

  // Step 4: Filter by characteristics
  const m2Tolerance = 0.15; // 15%
  const m2Min = m2 * (1 - m2Tolerance);
  const m2Max = m2 * (1 + m2Tolerance);

  let matches = parcels.filter(p => {
    // m² match (primary filter — required)
    if (p.builtArea && (p.builtArea < m2Min || p.builtArea > m2Max)) return false;
    // Year built (if provided, ±5 years)
    if (year_built && p.yearBuilt) {
      if (Math.abs(p.yearBuilt - parseInt(year_built)) > 5) return false;
    }
    return true;
  });

  // Step 5: Score and rank matches
  matches = matches.map(p => {
    let score = 100;
    // m² proximity score
    if (p.builtArea && m2) {
      const diff = Math.abs(p.builtArea - m2) / m2;
      score -= Math.round(diff * 100); // penalise up to 15 points per 15% diff
    }
    // Floor match bonus
    if (floor && p.floors) {
      const floorNum = parseInt(floor);
      if (!isNaN(floorNum) && p.floors >= floorNum) score += 5;
    }
    // Year built bonus
    if (year_built && p.yearBuilt) {
      const diff = Math.abs(p.yearBuilt - parseInt(year_built));
      if (diff === 0) score += 10;
      else if (diff <= 2) score += 5;
    }
    return { ...p, matchScore: Math.max(0, Math.min(100, score)) };
  });

  // Sort by score descending, take top 5
  matches.sort((a, b) => b.matchScore - a.matchScore);
  matches = matches.slice(0, 5);

  // Step 6: For top matches, fetch full OVC data (address + cadastral value)
  const enriched = await Promise.all(
    matches.map(async (p) => {
      if (p.rc) {
        try {
          const full = await lookupByRC(p.rc);
          if (full) return { ...p, ...full, matchScore: p.matchScore };
        } catch {
          // Return what we have from WFS
        }
      }
      return p;
    })
  );

  return enriched.filter(p => p.address || p.rc);
}

// ── GEOCODE via Nominatim ────────────────────────────────────────────────────
async function geocode(searchTerm) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchTerm)}&format=json&limit=1&accept-language=en&countrycodes=es`;
  const data = await fetchJSON(url, { 'User-Agent': 'Parcela/1.0 (property-finder; contact@parcela.io)' });
  if (!data || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name };
}

// ── CATASTRO WFS QUERY ────────────────────────────────────────────────────────
async function queryWFS(bbox, geo) {
  // Query Catastro INSPIRE WFS for building units (BU) in the bounding box
  // The BuildingUnit layer contains per-unit data including area and number of floors
  const wfsUrl = `https://ovc.catastro.meh.es/INSPIRE/wfsBU.aspx?` +
    `SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=BU:BuildingUnit` +
    `&BBOX=${bbox},EPSG:4326` +
    `&outputFormat=application/json` +
    `&Count=100`;

  const wfsData = await fetchJSON(wfsUrl);

  if (wfsData?.features && wfsData.features.length > 0) {
    return wfsData.features.map(f => parseWFSBuilding(f)).filter(Boolean);
  }

  // Fallback: try the CadastralParcel layer
  const parcelUrl = `https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx?` +
    `SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=CP:CadastralParcel` +
    `&BBOX=${bbox},EPSG:4326` +
    `&outputFormat=application/json` +
    `&Count=100`;

  const parcelData = await fetchJSON(parcelUrl);
  if (parcelData?.features && parcelData.features.length > 0) {
    return parcelData.features.map(f => parseWFSParcel(f)).filter(Boolean);
  }

  // Second fallback: use OVC callejero to search by municipality
  // Extract municipality from geo display name
  if (geo?.display) {
    const parts = geo.display.split(',').map(s => s.trim());
    const muni = parts[1] || parts[0];
    return await searchByMunicipality(muni, geo);
  }

  return [];
}

function parseWFSBuilding(feature) {
  if (!feature?.properties) return null;
  const p = feature.properties;

  // Extract RC from various possible field names
  const rc = p.reference || p.localId || p.inspireId?.localId || p.RC || null;
  if (!rc) return null;

  return {
    rc: rc.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    builtArea: p.officialArea || p.currentUseArea || p.totalArea || null,
    floors: p.numberOfFloorsAboveGround || p.floors || null,
    yearBuilt: p.beginLifespanVersion ? parseInt(p.beginLifespanVersion) : null,
    buildingNature: p.buildingNature || p.currentUse || null,
    geometry: feature.geometry,
    source: 'WFS_BuildingUnit',
  };
}

function parseWFSParcel(feature) {
  if (!feature?.properties) return null;
  const p = feature.properties;
  const rc = p.nationalCadastralReference || p.reference || p.localId || null;
  if (!rc) return null;

  return {
    rc: rc.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    builtArea: p.areaValue || p.area || null,
    yearBuilt: null,
    floors: null,
    source: 'WFS_CadastralParcel',
  };
}

// ── OVC CALLEJERO — MUNICIPALITY SEARCH FALLBACK ─────────────────────────────
async function searchByMunicipality(municipality, geo) {
  // Use Consulta_DNPLOC to search by partial address in the area
  // We need province name too — extract from geo display
  const parts = (geo?.display || '').split(',').map(s => s.trim());
  const province = parts[parts.length - 2] || '';

  // Search for residential properties in the municipality
  const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPLOC?` +
    `Provincia=${encodeURIComponent(province)}&Municipio=${encodeURIComponent(municipality)}` +
    `&Sigla=CL&Calle=&Numero=&Bloque=&Escalera=&Planta=&Puerta=`;

  const xml = await fetchXML(url);
  if (!xml) return [];

  // Parse list of properties returned
  return parseOVCList(xml);
}

// ── XML PARSERS ───────────────────────────────────────────────────────────────
function parseOVCProperty(xml, rcInput) {
  if (!xml || xml.includes('<err>') || xml.includes('<cuerr>')) {
    const errMatch = xml?.match(/<des>([^<]+)<\/des>/i);
    if (errMatch) throw new Error(`Catastro: ${errMatch[1]}`);
    return null;
  }

  // Extract fields from the OVC XML response
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };

  const getAll = (tag) => {
    const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))];
    return matches.map(m => m[1].trim());
  };

  // Address components
  const tipoVia   = get('tv') || get('sigla') || '';
  const nombreVia = get('nv') || get('calle') || '';
  const numero    = get('pnp') || get('numero') || '';
  const bloque    = get('bq') || '';
  const escalera  = get('es') || '';
  const planta    = get('pt') || '';
  const puerta    = get('pu') || '';
  const municipio = get('nm') || get('municipio') || '';
  const provincia = get('np') || get('provincia') || '';
  const cp        = get('dp') || get('cp') || '';

  // Build human-readable address
  const addressParts = [
    [tipoVia, nombreVia].filter(Boolean).join(' '),
    numero ? `nº ${numero}` : '',
    bloque ? `Bloque ${bloque}` : '',
    escalera ? `Esc. ${escalera}` : '',
    planta ? `Planta ${planta}` : '',
    puerta ? `Pta. ${puerta}` : '',
  ].filter(Boolean).join(', ');

  const fullAddress = [addressParts, cp, municipio, provincia].filter(Boolean).join(', ');

  // Property data
  const rc      = get('rc1') && get('rc2') ? (get('rc1') + get('rc2')) : (get('rc') || rcInput || '');
  const use     = get('luso') || get('uso') || null;
  const builtM2 = get('sfc') ? parseFloat(get('sfc')) : null;
  const yearVal = get('ant') || null;
  const catValue = get('vv') ? parseFloat(get('vv')) : null;
  const numFloors = get('npr') ? parseInt(get('npr')) : null;

  // Use/type mapping
  const useMap = {
    'V': 'Residential (dwelling)',
    'R': 'Residential (multi-unit)',
    'I': 'Industrial',
    'O': 'Office',
    'C': 'Commercial',
    'A': 'Agricultural',
    'T': 'Tourism',
    'G': 'Garage',
    'Y': 'Sports / leisure',
    'E': 'Cultural / educational',
    'M': 'Religious',
    'P': 'Public administration',
    'B': 'Storage',
    'Z': 'Other',
  };

  // Extract all sub-parcelas (for buildings with multiple units)
  const subunits = [];
  const bienes = xml.match(/<bico>([\s\S]*?)<\/bico>/gi) || [];
  bienes.forEach(b => {
    const su = get.call({ xml: b }, 'dt') || '';
    const sm2 = b.match(/<sfc>([^<]*)<\/sfc>/i)?.[1];
    const sus = b.match(/<uso>([^<]*)<\/uso>/i)?.[1];
    if (sm2) subunits.push({ description: su, m2: parseFloat(sm2), use: sus });
  });

  return {
    rc,
    address: fullAddress || null,
    addressComponents: {
      streetType: tipoVia,
      streetName: nombreVia,
      number: numero,
      block: bloque || null,
      staircase: escalera || null,
      floor: planta || null,
      door: puerta || null,
      postcode: cp,
      municipality: municipio,
      province: provincia,
    },
    cadastralData: {
      use: useMap[use] || use || 'Unknown',
      builtAreaM2: builtM2,
      yearBuilt: yearVal ? parseInt(yearVal) : null,
      cadastralValue: catValue,
      numberOfFloors: numFloors,
      subunits: subunits.length > 0 ? subunits : null,
    },
    catastroUrl: rc ? `https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?RC1=${rc.substring(0,7)}&RC2=${rc.substring(7,14)}&esBice=&RCBice1=&RCBice2=&DenoBice=&pest=rc&final=&RCCompleta=${rc}&from=OVCBusqueda&tipoCarto=nuevo` : null,
    source: 'Catastro OVC — Ministerio de Hacienda',
  };
}

function parseOVCList(xml) {
  if (!xml) return [];
  const results = [];
  const entries = xml.match(/<inmueble>([\s\S]*?)<\/inmueble>/gi) || [];
  entries.forEach(entry => {
    const rcMatch = entry.match(/<rc>([^<]+)<\/rc>/i) || entry.match(/<rc1>([^<]+)<\/rc1>/i);
    if (rcMatch) {
      results.push({
        rc: rcMatch[1].trim().toUpperCase(),
        source: 'OVC_list',
        builtArea: null,
        floors: null,
        yearBuilt: null,
      });
    }
  });
  return results;
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json, text/plain', ...headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchXML(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/xml, application/xml, */*' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
