// api/collect.js
// Fetches all Tier 1 data sources for a given postcode/municipality
// All sources are free and require no API key except AEMET (optional)
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { postcode, municipality, province } = req.body;
  if (!postcode && !municipality) return res.status(400).json({ error: 'postcode or municipality required' });
 
  const results = await collectAll({ postcode, municipality, province });
  return res.status(200).json(results);
}
 
// ─── Main collector ───────────────────────────────────────────────────────────
export async function collectAll({ postcode, municipality, province }) {
  const muni = municipality || '';
  const pc   = (postcode || '').replace(/\s/g, '');
 
  // Run all sources in parallel — failures return null, never crash the pipeline
  const [catastro, ine, aemet, snczi, caib, boe] = await Promise.all([
    fetchCatastro(pc, muni).catch(e => ({ error: e.message, source: 'catastro' })),
    fetchINE(pc, muni, province).catch(e => ({ error: e.message, source: 'ine' })),
    fetchAEMET(pc, muni).catch(e => ({ error: e.message, source: 'aemet' })),
    fetchSNCZI(pc, muni).catch(e => ({ error: e.message, source: 'snczi' })),
    fetchCAIB(pc, muni).catch(e => ({ error: e.message, source: 'caib' })),
    fetchBOE(muni).catch(e => ({ error: e.message, source: 'boe' })),
  ]);
 
  return { postcode: pc, municipality: muni, collected_at: new Date().toISOString(), catastro, ine, aemet, snczi, caib, boe };
}
 
// ─── 1. CATASTRO INSPIRE ──────────────────────────────────────────────────────
// Catastro provides free WFS/REST endpoints — no auth required
// Docs: https://www.catastro.minhap.es/webinspire/index.html
async function fetchCatastro(postcode, municipality) {
  const results = {};
 
  // Get municipality code from postcode (first 2 digits = province, next 3 = municipality)
  // We use the OVC (Online Consultation) service which is the most accessible
  const baseUrl = 'https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx';
 
  // 1a. Get streets in the municipality by postcode
  if (postcode) {
    const streetUrl = `${baseUrl}/ConsultaMunicipioCodPostal?CodigoCPP=${postcode}&CodigoCPV=${postcode}`;
    const streetRes = await fetchXML(streetUrl);
    if (streetRes) {
      results.municipality_data = parseCatastroMunicipality(streetRes);
    }
  }
 
  // 1b. Get summary statistics via the INSPIRE WFS endpoint
  // This gives us aggregate property data for the area
  const inspireBase = 'https://inspire.catastro.meh.es/wfs';
  const wfsUrl = `${inspireBase}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=CP:CadastralParcel&outputFormat=application/json` +
    `&CQL_FILTER=postCode='${postcode}'&count=50`;
 
  const wfsRes = await fetchJSON(wfsUrl);
  if (wfsRes && wfsRes.features) {
    results.parcels = summariseParcels(wfsRes.features);
  }
 
  // 1c. Get property value statistics via the Catastro value endpoint
  if (postcode) {
    const valueUrl = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/ConsultaCPMunicipio?CodigoCPP=${postcode}&CodigoCPV=${postcode}`;
    const valueRes = await fetchXML(valueUrl);
    if (valueRes) {
      results.value_data = parseCatastroValues(valueRes);
    }
  }
 
  results.source = 'Catastro INSPIRE — Ministerio de Hacienda';
  results.url = 'https://www.catastro.minhap.es';
  return results;
}
 
function summariseParcels(features) {
  if (!features || features.length === 0) return { count: 0 };
  const areas = features.map(f => f.properties?.areaValue || 0).filter(a => a > 0);
  const values = features.map(f => f.properties?.value || 0).filter(v => v > 0);
  return {
    total_parcels_sampled: features.length,
    avg_parcel_area_m2: areas.length ? Math.round(areas.reduce((a,b)=>a+b,0)/areas.length) : null,
    avg_cadastral_value_eur: values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : null,
    land_use_types: [...new Set(features.map(f => f.properties?.currentUse).filter(Boolean))],
  };
}
 
function parseCatastroMunicipality(xml) {
  // Extract municipality name and province from XML response
  const muniMatch = xml.match(/<nmun>([^<]+)<\/nmun>/i);
  const provMatch = xml.match(/<nprov>([^<]+)<\/nprov>/i);
  const cpMatch   = xml.match(/<cp>([^<]+)<\/cp>/i);
  return {
    municipality: muniMatch?.[1] || null,
    province: provMatch?.[1] || null,
    postcode: cpMatch?.[1] || null,
  };
}
 
function parseCatastroValues(xml) {
  const vmatch = xml.match(/<vc>([^<]+)<\/vc>/i);
  return { cadastral_value_indicator: vmatch?.[1] || null };
}
 
// ─── 2. INE — National Statistics Institute ───────────────────────────────────
// Free JSON API, no auth required
// Docs: https://www.ine.es/dyngs/DataLab/es/manual.htm?cid=1259945948443
async function fetchINE(postcode, municipality, province) {
  const results = {};
 
  // INE municipality code: derive from postcode (province = first 2 digits)
  const provinceCode = postcode ? postcode.substring(0, 2) : null;
 
  // 2a. Population by municipality (operation 2852 = Padrón municipal)
  // We search by municipality name if we have it
  if (municipality) {
    const searchUrl = `https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/2852?` +
      `date=20230101:20240101&tip=AM&lang=ES`;
    const popData = await fetchJSON(searchUrl);
    if (popData) {
      results.population_data = parseINEPopulation(popData, municipality);
    }
  }
 
  // 2b. Household income by postcode area (operation 30896 = Atlas distribución renta)
  // This is one of the most valuable datasets — median income per postal zone
  if (provinceCode) {
    const incomeUrl = `https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/37677?` +
      `date=20210101:20220101&tip=AM&lang=ES`;
    const incomeData = await fetchJSON(incomeUrl);
    if (incomeData) {
      results.income_data = parseINEIncome(incomeData, postcode);
    }
  }
 
  // 2c. Building statistics (operation 20298 = Estadística de Construcción)
  const buildUrl = `https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/20298?` +
    `date=20220101:20240101&tip=AM&lang=ES`;
  const buildData = await fetchJSON(buildUrl);
  if (buildData) {
    results.construction_data = parseINEConstruction(buildData, provinceCode);
  }
 
  // 2d. Direct municipality data lookup
  if (municipality) {
    const muniSearchUrl = `https://servicios.ine.es/wstempus/js/ES/DATOS_METADATAOPERACION/padron?` +
      `lang=ES&tip=A`;
    const muniData = await fetchJSON(muniSearchUrl);
    if (muniData) {
      results.municipality_metadata = { available: true, query: municipality };
    }
  }
 
  results.source = 'INE — Instituto Nacional de Estadística';
  results.url = 'https://www.ine.es';
  return results;
}
 
function parseINEPopulation(data, municipality) {
  if (!Array.isArray(data)) return null;
  // Find entries matching municipality name
  const matches = data.filter(d =>
    d.Nombre && d.Nombre.toLowerCase().includes(municipality.toLowerCase())
  ).slice(0, 3);
  return {
    query: municipality,
    entries_found: matches.length,
    sample: matches.map(m => ({
      name: m.Nombre,
      value: m.Data?.[0]?.Valor,
      year: m.Data?.[0]?.Anyo,
    })),
  };
}
 
function parseINEIncome(data, postcode) {
  if (!Array.isArray(data)) return null;
  const pc = postcode ? postcode.substring(0, 5) : null;
  const match = pc ? data.find(d => d.Nombre?.includes(pc)) : null;
  return {
    postcode_searched: pc,
    median_income_indicator: match?.Data?.[0]?.Valor || null,
    year: match?.Data?.[0]?.Anyo || null,
    note: 'Renta neta media por persona — Atlas distribución renta INE',
  };
}
 
function parseINEConstruction(data, provinceCode) {
  if (!Array.isArray(data)) return null;
  const match = provinceCode ? data.find(d => d.Nombre?.startsWith(provinceCode)) : data[0];
  return {
    province_code: provinceCode,
    construction_indicator: match?.Data?.[0]?.Valor || null,
    year: match?.Data?.[0]?.Anyo || null,
  };
}
 
// ─── 3. AEMET — Meteorología ───────────────────────────────────────────────────
// Requires free API key: https://opendata.aemet.es/centrodedescargas/altaUsuario
// Falls back gracefully if key not set
async function fetchAEMET(postcode, municipality) {
  const apiKey = process.env.AEMET_API_KEY;
  const results = { source: 'AEMET — Agencia Estatal de Meteorología', url: 'https://opendata.aemet.es' };
 
  if (!apiKey) {
    results.note = 'AEMET_API_KEY not configured — add free key from opendata.aemet.es for climate data';
    results.status = 'not_configured';
    return results;
  }
 
  // 3a. Find nearest weather station to postcode
  const stationsUrl = `https://opendata.aemet.es/opendata/api/valores/climatologicos/inventarioestaciones/todasestaciones?api_key=${apiKey}`;
  const stationsRes = await fetchJSON(stationsUrl);
 
  if (stationsRes?.datos) {
    // Follow the data URL (AEMET uses a two-step fetch)
    const stationData = await fetchJSON(stationsRes.datos);
    if (Array.isArray(stationData)) {
      // Pick closest station — for now pick first in same province (postcode prefix)
      const provincePrefix = postcode?.substring(0, 2);
      const station = stationData.find(s => s.provincia?.toLowerCase().includes(municipality?.toLowerCase().split(' ')[0] || ''))
        || stationData[0];
 
      if (station) {
        results.nearest_station = {
          name: station.nombre,
          province: station.provincia,
          altitude_m: station.altitud,
          latitude: station.latitud,
          longitude: station.longitud,
        };
 
        // 3b. Get climate normals for that station
        const climateUrl = `https://opendata.aemet.es/opendata/api/valores/climatologicos/normales/estacion/${station.indicativo}?api_key=${apiKey}`;
        const climateRes = await fetchJSON(climateUrl);
        if (climateRes?.datos) {
          const climateData = await fetchJSON(climateRes.datos);
          if (Array.isArray(climateData) && climateData.length > 0) {
            const c = climateData[0];
            results.climate_normals = {
              annual_avg_temp_c: c.tm_med || null,
              annual_rainfall_mm: c.p_med || null,
              avg_sunshine_hours: c.inso || null,
              hottest_month_avg_c: c.tm_mes_max || null,
              coldest_month_avg_c: c.tm_mes_min || null,
              note: 'Climate normals 1981–2010',
            };
          }
        }
      }
    }
  }
 
  return results;
}
 
// ─── 4. SNCZI — Flood zones ───────────────────────────────────────────────────
// MITERD Sistema Nacional de Cartografía de Zonas Inundables
// Free WMS/WFS service, no auth required
async function fetchSNCZI(postcode, municipality) {
  const results = { source: 'SNCZI — Sistema Nacional Cartografía Zonas Inundables', url: 'https://snczi.miteco.gob.es' };
 
  // We need lat/lon to query the flood zone WMS
  // Use Nominatim (OSM) to geocode the postcode — free, no auth
  const geocodeUrl = `https://nominatim.openstreetmap.org/search?` +
    `postalcode=${postcode}&country=es&format=json&limit=1&accept-language=en`;
 
  const geoHeaders = { 'User-Agent': 'Parcela/1.0 (property intelligence; contact@parcela.io)' };
  const geoRes = await fetchJSON(geocodeUrl, geoHeaders);
 
  if (!geoRes || geoRes.length === 0) {
    // Try municipality name
    const muniGeoUrl = `https://nominatim.openstreetmap.org/search?` +
      `q=${encodeURIComponent(municipality + ', Spain')}&format=json&limit=1&accept-language=en`;
    const muniGeo = await fetchJSON(muniGeoUrl, geoHeaders);
    if (!muniGeo || muniGeo.length === 0) {
      results.note = 'Could not geocode location for flood zone lookup';
      return results;
    }
    geoRes.push(muniGeo[0]);
  }
 
  const lat = parseFloat(geoRes[0].lat);
  const lon = parseFloat(geoRes[0].lon);
  results.coordinates = { lat, lon, display_name: geoRes[0].display_name };
 
  // Query SNCZI WMS GetFeatureInfo for flood zone at this location
  // EPSG:4326 bounding box centred on the point
  const delta = 0.001;
  const bbox = `${lon-delta},${lat-delta},${lon+delta},${lat+delta}`;
  const width = 101, height = 101, x = 50, y = 50;
 
  const wmsUrl = `https://snczi.miteco.gob.es/geoserver/ows?` +
    `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo` +
    `&LAYERS=SNCZI:ZI_T10,SNCZI:ZI_T100,SNCZI:ZI_T500` +
    `&QUERY_LAYERS=SNCZI:ZI_T10,SNCZI:ZI_T100,SNCZI:ZI_T500` +
    `&BBOX=${bbox}&WIDTH=${width}&HEIGHT=${height}` +
    `&X=${x}&Y=${y}&INFO_FORMAT=application/json&SRS=EPSG:4326`;
 
  const floodRes = await fetchJSON(wmsUrl);
 
  if (floodRes?.features) {
    const zones = floodRes.features.map(f => f.properties?.ZONA || f.properties?.tipo_zona).filter(Boolean);
    results.flood_zones_detected = zones;
    results.flood_risk = zones.length === 0 ? 'none_detected'
      : zones.some(z => z.includes('T10') || z.includes('10')) ? 'high'
      : zones.some(z => z.includes('T100') || z.includes('100')) ? 'medium'
      : 'low';
    results.in_flood_zone = zones.length > 0;
  } else {
    // WMS returned no features = not in a mapped flood zone
    results.flood_zones_detected = [];
    results.flood_risk = 'none_detected';
    results.in_flood_zone = false;
    results.note = 'No flood zone data returned for this location — likely outside mapped risk areas';
  }
 
  return results;
}
 
// ─── 5. CAIB — Balearic Islands Open Data ────────────────────────────────────
// Portal: https://www.caib.es/dadescaib/es/inici.htm
// Free CKAN API, no auth required
async function fetchCAIB(postcode, municipality) {
  const results = { source: 'CAIB — Govern de les Illes Balears Open Data', url: 'https://www.caib.es/dadescaib' };
 
  // Only meaningful for Balearic postcodes (07xxx)
  const isBalearic = postcode && postcode.startsWith('07');
  if (!isBalearic) {
    results.note = 'CAIB data is specific to the Balearic Islands (postcodes 07xxx)';
    results.applicable = false;
    return results;
  }
 
  results.applicable = true;
 
  // 5a. STR (tourist licence) data — ATIB registry
  // Search for datasets related to tourist accommodation and licences
  const ckanBase = 'https://www.caib.es/dadescaib/api/3/action';
 
  // Search for STR/tourist licence datasets
  const strSearch = await fetchJSON(`${ckanBase}/package_search?q=habitatge+turistic+llicencies&rows=5`);
  if (strSearch?.result?.results) {
    results.str_datasets_found = strSearch.result.results.map(d => ({
      title: d.title,
      id: d.id,
      last_modified: d.metadata_modified,
      notes: d.notes?.substring(0, 150),
    }));
 
    // Try to fetch the actual STR data from the most recent dataset
    const strDataset = strSearch.result.results[0];
    if (strDataset?.resources?.length > 0) {
      const csvResource = strDataset.resources.find(r => r.format === 'CSV' || r.format === 'JSON');
      if (csvResource) {
        results.str_data_url = csvResource.url;
        results.str_note = 'STR licence registry available — fetch str_data_url for full dataset';
      }
    }
  }
 
  // 5b. Urban planning data
  const planSearch = await fetchJSON(`${ckanBase}/package_search?q=planejament+urbanistic+municipal&rows=5`);
  if (planSearch?.result?.results) {
    results.planning_datasets_found = planSearch.result.results.length;
    results.planning_datasets = planSearch.result.results.map(d => ({
      title: d.title,
      last_modified: d.metadata_modified,
    }));
  }
 
  // 5c. Tourism statistics
  const tourSearch = await fetchJSON(`${ckanBase}/package_search?q=turisme+estadistiques+visitants&rows=3`);
  if (tourSearch?.result?.results) {
    results.tourism_datasets_found = tourSearch.result.results.length;
  }
 
  // 5d. Get postcode-specific municipality from CAIB
  const muniSearch = await fetchJSON(`${ckanBase}/package_search?q=municipi+${encodeURIComponent(municipality || '')}&rows=3`);
  if (muniSearch?.result?.count > 0) {
    results.municipality_datasets_found = muniSearch.result.count;
  }
 
  return results;
}
 
// ─── 6. BOE / BOIB — Official State Gazette ───────────────────────────────────
// BOE API: https://www.boe.es/datosabiertos/documentos/ConsultasDisponibles.pdf
// Free, no auth required
async function fetchBOE(municipality) {
  const results = { source: 'BOE/BOIB — Boletín Oficial del Estado / Illes Balears', url: 'https://www.boe.es/datosabiertos' };
 
  if (!municipality) {
    results.note = 'Municipality name required for BOE search';
    return results;
  }
 
  // 6a. Search BOE for recent mentions of the municipality (urban planning, investment, regulations)
  const searchTerms = [municipality, `${municipality} urbanismo`, `${municipality} inversión`];
  results.boe_results = [];
 
  for (const term of searchTerms) {
    const boeUrl = `https://www.boe.es/datosabiertos/api/buscar/actos?q=${encodeURIComponent(term)}` +
      `&desde=20240101&hasta=${new Date().toISOString().split('T')[0].replace(/-/g,'')}` +
      `&rows=5&campo=titulo`;
 
    const boeRes = await fetchJSON(boeUrl);
    if (boeRes?.response?.docs && boeRes.response.docs.length > 0) {
      results.boe_results.push({
        query: term,
        total_found: boeRes.response.numFound,
        recent_items: boeRes.response.docs.map(d => ({
          title: d.titulo,
          date: d.fecha_publicacion,
          section: d.seccion_nombre,
          department: d.departamento_nombre,
          url: `https://www.boe.es/diario_boe/txt.php?id=${d.identificador}`,
        })),
      });
    }
  }
 
  // 6b. Check BOIB (Balearic official gazette) for Balearic-specific planning
  const boibUrl = `https://www.caib.es/boib/api/3/action/package_search?q=` +
    `${encodeURIComponent(municipality)}&rows=5`;
  const boibRes = await fetchJSON(boibUrl);
  if (boibRes?.result?.results) {
    results.boib_results = boibRes.result.results.map(d => ({
      title: d.title,
      date: d.metadata_modified,
    }));
  }
 
  // Summary
  results.total_mentions_found = results.boe_results.reduce((sum, r) => sum + (r.total_found || 0), 0);
  results.regulatory_activity_signal = results.total_mentions_found > 10 ? 'high'
    : results.total_mentions_found > 3 ? 'medium' : 'low';
 
  return results;
}
 
// ─── Utility fetchers ────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', ...headers },
      signal: AbortSignal.timeout(8000),
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
      headers: { 'Accept': 'text/xml, application/xml' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
