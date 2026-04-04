// api/report.js
// 1. Collects real data from all Tier 1 sources
// 2. Passes the data to Claude to write a grounded intelligence report
 
import { collectAll } from './collect.js';
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { area, postcode, type, lang } = req.body;
  if (!area && !postcode) return res.status(400).json({ error: 'area or postcode required' });
 
  const anthropicKey = process.env.ANTHROPIC_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_KEY not configured' });
 
  // Step 1: Collect real data
  let liveData = null;
  let dataCollectionNotes = [];
 
  try {
    const { pc, muni, prov } = parseArea(area || postcode);
    liveData = await collectAll({ postcode: pc, municipality: muni, province: prov });
 
    if (liveData.catastro?.parcels?.total_parcels_sampled) dataCollectionNotes.push('Catastro property registry');
    if (liveData.ine?.income_data?.median_income_indicator) dataCollectionNotes.push('INE median income data');
    if (liveData.ine?.population_data?.entries_found > 0) dataCollectionNotes.push('INE population statistics');
    if (liveData.aemet?.climate_normals) dataCollectionNotes.push('AEMET climate normals');
    if (liveData.snczi?.flood_risk) dataCollectionNotes.push('SNCZI flood zone assessment');
    if (liveData.caib?.applicable) dataCollectionNotes.push('CAIB Balearic open data');
    if (liveData.boe?.total_mentions_found > 0) dataCollectionNotes.push(`BOE gazette (${liveData.boe.total_mentions_found} mentions)`);
  } catch (e) {
    dataCollectionNotes.push(`Data collection partial: ${e.message}`);
  }
 
  // Step 2: Build data context string
  const dataContext = liveData ? buildDataContext(liveData) : 'No live data available.';
  const prompt = buildPrompt({ area: area || postcode, type, lang, dataContext, dataCollectionNotes });
 
  // Step 3: Generate report
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: `You are a senior property intelligence analyst at Parcela. You write reports with the authority and precision of a private bank research note. You have been provided with REAL data collected from official Spanish government sources. Use this data as the factual backbone of your analysis. Where data is available, cite it specifically. Where data is unavailable, say so clearly — do not invent figures. Write in ${lang}.`,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
 
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: result.error?.message || 'Anthropic error' });
 
    return res.status(200).json({
      text: result.content[0].text,
      data_sources_used: dataCollectionNotes,
      live_data_summary: liveData ? summariseLiveData(liveData) : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 
function parseArea(area) {
  const clean = (area || '').trim();
  const postcodeMatch = clean.match(/\b(0[7-9]\d{3}|[1-4]\d{4}|5[0-2]\d{3})\b/);
  const pc = postcodeMatch ? postcodeMatch[1] : null;
  const muni = clean.replace(/\d{5}/, '').replace(/,.*$/, '').trim() || clean;
  const prov = clean.includes(',') ? clean.split(',').slice(-1)[0].trim() : null;
  return { pc, muni, prov };
}
 
function buildDataContext(d) {
  const lines = [];
 
  if (d.catastro?.parcels?.total_parcels_sampled) {
    const p = d.catastro.parcels;
    lines.push(`CATASTRO (official land registry):`);
    lines.push(`  - ${p.total_parcels_sampled} parcels sampled`);
    if (p.avg_parcel_area_m2) lines.push(`  - Average parcel size: ${p.avg_parcel_area_m2} m2`);
    if (p.avg_cadastral_value_eur) lines.push(`  - Average cadastral value: EUR ${p.avg_cadastral_value_eur.toLocaleString()}`);
    if (p.land_use_types?.length) lines.push(`  - Land use types: ${p.land_use_types.join(', ')}`);
  }
  if (d.catastro?.municipality_data?.municipality) {
    lines.push(`  - Municipality: ${d.catastro.municipality_data.municipality}, ${d.catastro.municipality_data.province}`);
  }
 
  if (d.ine?.income_data?.median_income_indicator) {
    lines.push(`\nINE STATISTICS:`);
    lines.push(`  - Median income indicator: ${d.ine.income_data.median_income_indicator} (${d.ine.income_data.year || 'recent'})`);
  }
  if (d.ine?.population_data?.sample?.[0]?.value) {
    lines.push(`  - Population indicator: ${d.ine.population_data.sample[0].value}`);
  }
  if (d.ine?.construction_data?.construction_indicator) {
    lines.push(`  - Construction activity: ${d.ine.construction_data.construction_indicator}`);
  }
 
  if (d.aemet?.climate_normals) {
    const c = d.aemet.climate_normals;
    lines.push(`\nAEMET CLIMATE (station: ${d.aemet.nearest_station?.name || 'local'}):`);
    if (c.annual_avg_temp_c) lines.push(`  - Annual avg temp: ${c.annual_avg_temp_c}C`);
    if (c.annual_rainfall_mm) lines.push(`  - Annual rainfall: ${c.annual_rainfall_mm}mm`);
    if (c.avg_sunshine_hours) lines.push(`  - Sunshine hours/year: ${c.avg_sunshine_hours}`);
  } else {
    lines.push(`\nCLIMATE: AEMET key not configured — use general knowledge`);
  }
 
  if (d.snczi?.flood_risk) {
    lines.push(`\nSNCZI FLOOD RISK:`);
    lines.push(`  - Risk level: ${d.snczi.flood_risk.toUpperCase()}`);
    lines.push(`  - In mapped flood zone: ${d.snczi.in_flood_zone ? 'YES' : 'NO'}`);
    if (d.snczi.flood_zones_detected?.length > 0) lines.push(`  - Zones: ${d.snczi.flood_zones_detected.join(', ')}`);
  }
 
  if (d.caib?.applicable) {
    lines.push(`\nCAIB BALEARIC DATA:`);
    if (d.caib.str_datasets_found?.length > 0) lines.push(`  - STR licence registry: available (${d.caib.str_datasets_found.length} datasets)`);
    if (d.caib.planning_datasets_found) lines.push(`  - Urban planning datasets: ${d.caib.planning_datasets_found}`);
    if (d.caib.tourism_datasets_found) lines.push(`  - Tourism datasets: ${d.caib.tourism_datasets_found}`);
  } else {
    lines.push(`\nCAIB: Not applicable (non-Balearic area)`);
  }
 
  if (d.boe) {
    lines.push(`\nBOE REGULATORY GAZETTE:`);
    lines.push(`  - Regulatory mentions (2024-present): ${d.boe.total_mentions_found || 0}`);
    lines.push(`  - Activity signal: ${d.boe.regulatory_activity_signal?.toUpperCase() || 'LOW'}`);
    d.boe.boe_results?.forEach(r => {
      r.recent_items?.slice(0, 2).forEach(item => {
        lines.push(`  - "${item.title}" (${item.date})`);
      });
    });
  }
 
  return lines.length > 0 ? lines.join('\n') : 'Data collection returned no structured results.';
}
 
function buildPrompt({ area, type, lang, dataContext, dataCollectionNotes }) {
  const dataSummary = dataCollectionNotes.length > 0
    ? `Data collected from: ${dataCollectionNotes.join(', ')}.`
    : 'Limited data available — note gaps in the report.';
 
  const sections = {
    neighbourhood: `
Generate a Neighbourhood Intelligence Report for: ${area}, Spain.
${dataSummary}
 
REAL DATA FROM OFFICIAL SOURCES:
${dataContext}
 
Write a professional report with these sections. Reference the real data by source name wherever available. Do not invent numbers:
 
## EXECUTIVE SUMMARY
## PARCELA FUTURE SCORE: [X]/100 — [RATING]
### Rationale (cite specific data points)
## SIGNAL BREAKDOWN (8 signals, each scored /100, each citing its data source)
  - Planning & Development
  - Flood & Environmental Risk (use SNCZI data directly)
  - Economic Vitality (use INE data)
  - Climate & Liveability (use AEMET data if available)
  - Property Market (use Catastro data)
  - STR & Tourism Pressure (use CAIB data if applicable)
  - Regulatory Environment (use BOE signal)
  - Infrastructure
## 5-YEAR TRAJECTORY
## KEY RISKS
## COMPARABLE AREAS
## ANALYST NOTE
## DATA SOURCES USED
List exactly which sources returned data and flag any gaps.`,
 
    region: `
Generate a Region Intelligence Report for: ${area}, Spain.
${dataSummary}
 
REAL DATA:
${dataContext}
 
Write a regional report with: Executive Overview, Top 5 Rising Neighbourhoods (with data-backed reasoning), Top 3 Areas to Approach with Caution, Price vs Trajectory Matrix, International Buyer Concentration, STR & Regulatory Risk, Infrastructure Pipeline, Climate Risk Summary, Data Sources Used.`,
 
    spain: `
Generate a Spain Intelligence Atlas.
${dataSummary}
 
REAL DATA:
${dataContext}
 
Write a national atlas with: Executive Overview, Top 10 Rising Areas, Top 5 to Avoid, Regional Analysis (Mallorca, Madrid, Barcelona + wider Spain), Value vs Trajectory Matrix, International Buyer Dynamics, Regulatory Risk Map, Infrastructure Pipeline 2025-2030, Climate & Environmental Risk, Analyst Conclusion, Data Sources Used.`,
 
    dossier: `
Generate a Property Dossier for: ${area}, Spain.
${dataSummary}
 
REAL DATA:
${dataContext}
 
Write a property dossier with: Catastro Record Summary (cite actual data), Legal Status Assessment, Cadastral Value vs Market, Flood & Environmental Risk (cite SNCZI directly), Urban Classification, STR Regulatory Status (cite CAIB if applicable), Data Sources Used.`,
 
    negotiation: `
Generate a Negotiation Intelligence Report for: ${area}, Spain.
${dataSummary}
 
REAL DATA:
${dataContext}
 
Write a negotiation report with: Market Context (cite INE income and Catastro values), Price Benchmarking, Regulatory Signals (cite BOE), STR Risk (cite CAIB if applicable), Flood & Risk Flags (cite SNCZI), AI Negotiation Brief (opening offer range, leverage points, red flags — all grounded in the data), Data Sources Used.`,
  };
 
  return (sections[type] || sections.neighbourhood).trim();
}
 
function summariseLiveData(d) {
  return {
    catastro_parcels: d.catastro?.parcels?.total_parcels_sampled || 0,
    catastro_avg_value_eur: d.catastro?.parcels?.avg_cadastral_value_eur || null,
    ine_income_indicator: d.ine?.income_data?.median_income_indicator || null,
    flood_risk: d.snczi?.flood_risk || null,
    in_flood_zone: d.snczi?.in_flood_zone || false,
    climate_avg_temp_c: d.aemet?.climate_normals?.annual_avg_temp_c || null,
    caib_applicable: d.caib?.applicable || false,
    str_data_available: !!d.caib?.str_data_url,
    boe_mentions: d.boe?.total_mentions_found || 0,
    regulatory_signal: d.boe?.regulatory_activity_signal || null,
  };
}
