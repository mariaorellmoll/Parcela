// api/mapimage.js
// Server-side map: geocodes address, fetches OSM tiles, stitches into PNG
// Returns a real PNG image — browser just uses <img src="/api/mapimage?address=...">

import { createCanvas, loadImage } from '@napi-rs/canvas';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query || {};
  if (!address) return res.status(400).send('address required');

  try {
    // Step 1: Geocode
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', España')}&format=json&limit=1&countrycodes=es`,
      { headers: { 'User-Agent': 'Parcela/1.0' } }
    );
    const geoData = await geoRes.json();
    if (!geoData?.length) return res.status(404).send('not found');

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: Calculate tiles
    const zoom = 16;
    const W = 680, H = 280;
    const TILE = 256;
    const n = Math.pow(2, zoom);
    const exactX = (lon + 180) / 360 * n;
    const exactY = (1 - Math.log(Math.tan(lat * Math.PI/180) + 1/Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * n;
    const centerTX = Math.floor(exactX);
    const centerTY = Math.floor(exactY);
    const offX = (exactX - centerTX) * TILE;
    const offY = (exactY - centerTY) * TILE;

    const tilesWide = Math.ceil(W / TILE) + 2;
    const tilesHigh = Math.ceil(H / TILE) + 2;
    const startTX = centerTX - Math.floor(tilesWide / 2);
    const startTY = centerTY - Math.floor(tilesHigh / 2);
    const drawX = Math.round(W/2 - offX - Math.floor(tilesWide/2) * TILE);
    const drawY = Math.round(H/2 - offY - Math.floor(tilesHigh/2) * TILE);

    // Step 3: Fetch all tiles in parallel
    const tilePromises = [];
    for (let dy = 0; dy < tilesHigh; dy++) {
      for (let dx = 0; dx < tilesWide; dx++) {
        const tx = startTX + dx, ty = startTY + dy;
        tilePromises.push(
          fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
            headers: { 'User-Agent': 'Parcela/1.0' }
          })
          .then(r => r.ok ? r.arrayBuffer() : null)
          .then(buf => buf ? { dx, dy, buf } : null)
          .catch(() => null)
        );
      }
    }
    const tiles = (await Promise.all(tilePromises)).filter(Boolean);

    // Step 4: Stitch onto canvas
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, W, H);

    for (const { dx, dy, buf } of tiles) {
      const img = await loadImage(Buffer.from(buf));
      ctx.drawImage(img, drawX + dx * TILE, drawY + dy * TILE, TILE, TILE);
    }

    // Step 5: Draw pin
    const pinX = W / 2, pinY = H / 2;
    // Shadow
    ctx.shadowColor = 'rgba(26,86,219,0.4)';
    ctx.shadowBlur = 8;
    // Outer white ring
    ctx.beginPath(); ctx.arc(pinX, pinY, 9, 0, 2*Math.PI);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.shadowBlur = 0;
    // Blue dot
    ctx.beginPath(); ctx.arc(pinX, pinY, 6, 0, 2*Math.PI);
    ctx.fillStyle = '#1a56db'; ctx.fill();

    // Attribution
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(W - 130, H - 18, 128, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText('© OpenStreetMap contributors', W - 128, H - 6);

    const png = canvas.toBuffer('image/png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(png);

  } catch(e) {
    console.error('[mapimage]', e.message);
    res.status(500).send('error: ' + e.message);
  }
}
