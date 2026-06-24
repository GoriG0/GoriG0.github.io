#!/usr/bin/env node
'use strict';

const http = require('http');
const { URL } = require('url');

const { generateMap, DENSITY_FACTORS } = require('./sphereMapGenerator');

// Hosting platforms (Render, Fly, Railway, etc.) inject PORT and expect the
// server to bind on 0.0.0.0, not localhost, so external traffic can reach it.
const PORT = process.env.PORT || 8765;
const HOST = process.env.HOST || '0.0.0.0';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function handleGenerate(req, res, parsedUrl) {
  try {
    const params = parsedUrl.searchParams;

    // Extract parameters with defaults
    const nodes = parseInt(params.get('nodes') ?? '40', 10);
    const kNearest = parseInt(params.get('k_nearest') ?? '10', 10);
    const jitter = parseFloat(params.get('jitter') ?? '0.15');
    const density = params.get('density') ?? 'high';
    const seedRaw = params.get('seed');
    const goodPct = parseFloat(params.get('good_pct') ?? '20');
    const badPct = parseFloat(params.get('bad_pct') ?? '20');
    const shopPct = parseFloat(params.get('shop_pct') ?? '5');

    // Validate parameters
    if (Number.isNaN(nodes) || nodes < 8 || nodes > 500) {
      throw new Error('Nodes must be between 8 and 500');
    }
    if (Number.isNaN(kNearest) || kNearest < 2 || kNearest >= nodes) {
      throw new Error(`k-nearest must be between 2 and ${nodes - 1}`);
    }
    if (Number.isNaN(jitter) || jitter < 0 || jitter > 1) {
      throw new Error('Jitter must be between 0 and 1');
    }
    if (!Object.keys(DENSITY_FACTORS).includes(density)) {
      throw new Error('Density must be low, medium, or high');
    }
    if (goodPct < 0 || badPct < 0 || shopPct < 0) {
      throw new Error('Node-type percentages cannot be negative');
    }
    if (goodPct + badPct + shopPct > 100) {
      throw new Error('good/bad/shop percentages cannot add up to more than 100');
    }

    let seed;
    if (seedRaw && seedRaw !== 'random') {
      seed = parseInt(seedRaw, 10);
      if (Number.isNaN(seed)) {
        throw new Error('seed must be an integer');
      }
    }

    // Run generator directly in-process (no subprocess, no disk access needed).
    const { seed: usedSeed, map, degreeRange, nodeTypes, edgeCount } = generateMap({
      nodes,
      kNearest,
      jitter,
      density,
      seed,
      writeToDisk: false,
      goodPct,
      badPct,
      shopPct,
    });

    const generatorOutput = [
      `Seed: ${usedSeed}`,
      `Density: ${density}`,
      `Nodes: ${nodes}, Edges: ${edgeCount}`,
      'Node types: ' +
        `normal=${nodeTypes.filter((t) => t === 'normal').length}, ` +
        `good=${nodeTypes.filter((t) => t === 'good').length}, ` +
        `bad=${nodeTypes.filter((t) => t === 'bad').length}, ` +
        `shop=${nodeTypes.filter((t) => t === 'shop').length}`,
      `Degree range: ${degreeRange[0]}..${degreeRange[1]}`,
    ].join('\n');

    sendJson(res, 200, {
      success: true,
      map,
      generator_output: generatorOutput,
    });
  } catch (err) {
    sendJson(res, 400, {
      success: false,
      error: err.message,
    });
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && parsedUrl.pathname === '/api/generate') {
    handleGenerate(req, res, parsedUrl);
  } else if (req.method === 'GET' && parsedUrl.pathname === '/') {
    // Simple health check most hosting platforms (Render, Fly, etc.) ping
    // to confirm the service is alive.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sphere map generator is running.');
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Map server running at http://${HOST}:${PORT}`);
  console.log('Press Ctrl+C to stop');
});

process.on('SIGINT', () => {
  console.log('\nServer stopped');
  server.close(() => process.exit(0));
});
