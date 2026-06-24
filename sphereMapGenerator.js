#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const NODE_TYPES = ['normal', 'good', 'bad', 'shop'];

const DENSITY_FACTORS = {
  low: 0.28,
  medium: 0.52,
  high: 0.82,
};

/**
 * Minimal seedable PRNG (mulberry32) so results are reproducible given a seed,
 * similar in spirit to Python's random.Random(seed).
 */
class SeededRandom {
  constructor(seed) {
    // Normalize seed into a 32-bit unsigned integer.
    this.state = (seed >>> 0) || 1;
  }

  // Returns a float in [0, 1)
  random() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Returns an integer in [0, n)
  randrange(n) {
    return Math.floor(this.random() * n);
  }

  // Returns a float in [min, max)
  uniform(min, max) {
    return min + this.random() * (max - min);
  }

  // Random element from an array
  choice(arr) {
    return arr[this.randrange(arr.length)];
  }

  // In-place Fisher-Yates shuffle (mirrors random.shuffle)
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randrange(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // Triangular distribution sample, mirrors Python's random.triangular(low, high, mode)
  triangular(low, high, mode) {
    const u = this.random();
    const c = (mode - low) / (high - low);
    if (u <= c) {
      return low + Math.sqrt(u * (high - low) * (mode - low));
    }
    return high - Math.sqrt((1 - u) * (high - low) * (high - mode));
  }
}

/**
 * Generate approximately uniform points on a unit sphere.
 * @param {number} count
 * @param {number} jitter
 * @param {SeededRandom} rng
 * @returns {Array<[number, number, number]>}
 */
function fibonacciSpherePoints(count, jitter, rng) {
  if (count < 2) {
    throw new Error('count must be at least 2');
  }

  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * i) / (count - 1);
    const radius = Math.sqrt(Math.max(0.0, 1 - y * y));

    let theta = goldenAngle * i;
    if (jitter > 0) {
      theta += rng.uniform(-jitter, jitter);
    }

    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;

    points.push([x, y, z]);
  }

  return points;
}

function euclideanDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * @param {Array<[number, number, number]>} points
 * @returns {number[][]}
 */
function computeDistanceMatrix(points) {
  const n = points.length;
  const dist = Array.from({ length: n }, () => new Array(n).fill(0.0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = euclideanDistance(points[i], points[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }
  return dist;
}

/**
 * @param {number[][]} dist
 * @param {number} k
 * @returns {Map<number, Set<number>>}
 */
function buildImmediateNeighbors(dist, k) {
  const n = dist.length;
  const neighbors = new Map();

  for (let i = 0; i < n; i++) {
    const ranked = Array.from({ length: n }, (_, j) => j).sort((a, b) => {
      const da = a === i ? Infinity : dist[i][a];
      const db = b === i ? Infinity : dist[i][b];
      return da - db;
    });
    const selected = new Set(ranked.slice(0, k).filter((idx) => idx !== i));
    neighbors.set(i, selected);
  }

  // Make neighbor relationship symmetric for stable local geography.
  for (let i = 0; i < n; i++) {
    for (const j of Array.from(neighbors.get(i))) {
      neighbors.get(j).add(i);
    }
  }

  return neighbors;
}

/**
 * @param {Map<number, Set<number>>} immediate
 * @returns {Map<number, Set<number>>}
 */
function buildTwoLayerCandidates(immediate) {
  const twoLayer = new Map();

  for (const [i, firstLayer] of immediate.entries()) {
    const candidates = new Set(firstLayer);
    for (const n1 of firstLayer) {
      for (const v of immediate.get(n1)) {
        candidates.add(v);
      }
    }
    candidates.delete(i);
    twoLayer.set(i, candidates);
  }

  return twoLayer;
}

/**
 * Edges are represented as "a,b" strings with a < b for set membership,
 * mirroring the Python tuple-based Set[Edge].
 */
function edgeKey(a, b) {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function addEdge(edges, degree, a, b) {
  if (a === b) return;
  const key = edgeKey(a, b);
  if (edges.has(key)) return;
  edges.set(key, a < b ? [a, b] : [b, a]);
  degree[a] += 1;
  degree[b] += 1;
}

/**
 * @param {number[][]} dist
 * @param {Map<number, Set<number>>} immediate
 * @param {Map<number, Set<number>>} twoLayer
 * @param {string} density
 * @param {SeededRandom} rng
 * @returns {Map<string, [number, number]>}
 */
function generateConnectedGraph(dist, immediate, twoLayer, density, rng) {
  const n = dist.length;
  const maxDegree = 6;
  const minDegree = 1;

  const edges = new Map();
  const degree = new Array(n).fill(0);

  // Step 1: Build a connected base with a randomized Prim-style growth.
  const start = rng.randrange(n);
  const visited = new Set([start]);
  const unvisited = new Set();
  for (let i = 0; i < n; i++) {
    if (i !== start) unvisited.add(i);
  }

  while (unvisited.size > 0) {
    let frontier = [];

    for (const u of visited) {
      if (degree[u] >= maxDegree) continue;
      for (const v of twoLayer.get(u)) {
        if (unvisited.has(v)) {
          frontier.push([dist[u][v], u, v]);
        }
      }
    }

    if (frontier.length === 0) {
      // Fallback to nearest global nodes if local 2-layer cannot continue.
      for (const u of visited) {
        if (degree[u] >= maxDegree) continue;
        const nearestUnvisited = Array.from(unvisited).sort(
          (a, b) => dist[u][a] - dist[u][b]
        );
        for (const v of nearestUnvisited.slice(0, 5)) {
          frontier.push([dist[u][v], u, v]);
        }
      }
    }

    if (frontier.length === 0) {
      throw new Error('Unable to connect all nodes while respecting max degree.');
    }

    frontier.sort((x, y) => x[0] - y[0]);
    // Sample from short edges mostly, but keep randomness.
    const pickFrom = frontier.slice(0, Math.min(12, frontier.length));
    const [, u, v] = rng.choice(pickFrom);

    addEdge(edges, degree, u, v);
    visited.add(v);
    unvisited.delete(v);
  }

  // Step 2: Choose target degree (1..6) per node based on requested density.
  const densityFactor = DENSITY_FACTORS[density];
  const densityCenter = minDegree + densityFactor * (maxDegree - minDegree);
  const targetDegree = [];
  for (let i = 0; i < n; i++) {
    // Triangular distribution keeps results random but centered on density level.
    const sampled = rng.triangular(minDegree, maxDegree, densityCenter);
    let target = Math.max(degree[i], Math.round(sampled));
    target = Math.max(minDegree, Math.min(maxDegree, target));
    targetDegree.push(target);
  }

  // Step 3: Add extra edges from local/two-layer candidates until targets are reached.
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (const j of twoLayer.get(i)) {
      if (i < j) {
        pairs.push([dist[i][j], i, j]);
      }
    }
  }

  // Closer edges are preferred to keep geography coherent.
  pairs.sort((a, b) => a[0] - b[0]);

  let progress = true;
  while (progress) {
    progress = false;
    for (const [d, a, b] of pairs) {
      if (degree[a] >= targetDegree[a] || degree[b] >= targetDegree[b]) continue;
      if (degree[a] >= maxDegree || degree[b] >= maxDegree) continue;
      const key = edgeKey(a, b);
      if (edges.has(key)) continue;

      // Add some randomness so maps differ more strongly across runs.
      const nearChance = 0.6 + 0.35 * densityFactor;
      const farChance = 0.3 + 0.45 * densityFactor;
      const chance = d < 0.9 ? nearChance : farChance;
      if (rng.random() <= chance) {
        addEdge(edges, degree, a, b);
        progress = true;
      }
    }
  }

  // Step 4: Guarantee minimum degree of 1 (normally already true after base connectivity).
  for (let i = 0; i < n; i++) {
    if (degree[i] >= minDegree) continue;

    const choices = Array.from(twoLayer.get(i)).sort((a, b) => dist[i][a] - dist[i][b]);
    let chosen = null;
    for (const j of choices) {
      if (degree[j] < maxDegree) {
        chosen = j;
        break;
      }
    }
    if (chosen === null) {
      // Fallback to global nearest with available degree.
      const allNodes = Array.from({ length: n }, (_, j) => j).sort(
        (a, b) => dist[i][a] - dist[i][b]
      );
      for (const j of allNodes) {
        if (j !== i && degree[j] < maxDegree) {
          chosen = j;
          break;
        }
      }
    }

    if (chosen === null) {
      throw new Error('Could not enforce minimum degree for all nodes.');
    }

    addEdge(edges, degree, i, chosen);
  }

  return edges;
}

/**
 * @param {number} nodeCount
 * @param {Map<string, [number, number]>} edges
 * @returns {Map<number, number[]>}
 */
function buildAdjacency(nodeCount, edges) {
  const adjacency = new Map();
  for (let i = 0; i < nodeCount; i++) adjacency.set(i, []);

  const sortedEdges = Array.from(edges.values()).sort((a, b) =>
    a[0] - b[0] !== 0 ? a[0] - b[0] : a[1] - b[1]
  );

  for (const [a, b] of sortedEdges) {
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }

  // Ensure stable output ordering.
  const ordered = new Map();
  for (let i = 0; i < nodeCount; i++) {
    ordered.set(i, adjacency.get(i).slice().sort((x, y) => x - y));
  }
  return ordered;
}

/**
 * @param {number} nodeCount
 * @param {SeededRandom} rng
 * @param {number} goodPct
 * @param {number} badPct
 * @param {number} shopPct
 * @returns {string[]}
 */
function assignNodeTypes(nodeCount, rng, goodPct, badPct, shopPct) {
  const totalPct = goodPct + badPct + shopPct;
  if (totalPct > 100) {
    throw new Error('good/bad/shop percentages cannot add up to more than 100.');
  }

  let goodCount = Math.ceil(nodeCount * (goodPct / 100.0));
  let badCount = Math.ceil(nodeCount * (badPct / 100.0));
  let shopCount = Math.ceil(nodeCount * (shopPct / 100.0));

  // If rounding pushed us over node_count, trim the largest non-normal buckets first.
  const counts = { good: goodCount, bad: badCount, shop: shopCount };
  while (counts.good + counts.bad + counts.shop > nodeCount) {
    const largest = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    counts[largest] -= 1;
  }

  const normalCount = nodeCount - (counts.good + counts.bad + counts.shop);
  const types = [
    ...Array(normalCount).fill('normal'),
    ...Array(counts.good).fill('good'),
    ...Array(counts.bad).fill('bad'),
    ...Array(counts.shop).fill('shop'),
  ];
  rng.shuffle(types);
  return types;
}

function formatTimestamp(date) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Build the map JSON payload entirely in memory (no disk access).
 *
 * @param {number} seed
 * @param {Array<[number, number, number]>} points
 * @param {Map<string, [number, number]>} edges
 * @param {Map<number, Set<number>>} immediate
 * @param {Map<number, Set<number>>} twoLayer
 * @param {string[]} nodeTypes
 * @returns {object} the map payload
 */
function buildMapPayload(seed, points, edges, immediate, twoLayer, nodeTypes) {
  const now = new Date();

  const adjacency = buildAdjacency(points.length, edges);
  const nodeTypeCounts = {};
  for (const t of NODE_TYPES) {
    nodeTypeCounts[t] = nodeTypes.filter((nt) => nt === t).length;
  }

  const sortedEdges = Array.from(edges.values()).sort((a, b) =>
    a[0] - b[0] !== 0 ? a[0] - b[0] : a[1] - b[1]
  );

  const adjacencyObj = {};
  for (const [k, v] of adjacency.entries()) {
    adjacencyObj[String(k)] = v;
  }

  return {
    meta: {
      generated_at: now.toISOString().slice(0, 19),
      seed,
      node_count: points.length,
      edge_count: edges.size,
      node_type_counts: nodeTypeCounts,
      notes: 'Nodes are on a unit sphere. Edges are undirected local/two-layer links.',
    },
    nodes: points.map((p, idx) => ({
      id: idx,
      position: { x: p[0], y: p[1], z: p[2] },
      type: nodeTypes[idx],
      degree: adjacency.get(idx).length,
      immediate_neighbors: Array.from(immediate.get(idx)).sort((a, b) => a - b),
      two_layer_candidates: Array.from(twoLayer.get(idx)).sort((a, b) => a - b),
    })),
    edges: sortedEdges.map(([a, b]) => ({ a, b })),
    adjacency: adjacencyObj,
  };
}

/**
 * Build the map payload and write it to disk as JSON (used by the CLI).
 *
 * @param {string} outDir
 * @param {number} seed
 * @param {Array<[number, number, number]>} points
 * @param {Map<string, [number, number]>} edges
 * @param {Map<number, Set<number>>} immediate
 * @param {Map<number, Set<number>>} twoLayer
 * @param {string[]} nodeTypes
 * @returns {{ outFile: string, payload: object }}
 */
function exportMap(outDir, seed, points, edges, immediate, twoLayer, nodeTypes) {
  fs.mkdirSync(outDir, { recursive: true });
  const payload = buildMapPayload(seed, points, edges, immediate, twoLayer, nodeTypes);
  const timestamp = formatTimestamp(new Date());
  const outFile = path.join(outDir, `sphere_map_${timestamp}_${seed}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf-8');
  return { outFile, payload };
}

/**
 * Core generation routine usable both by the CLI and by other modules (e.g. a server).
 *
 * @param {object} options
 * @param {number} options.nodes
 * @param {number} [options.kNearest=10]
 * @param {number} [options.jitter=0.15]
 * @param {string} [options.density='high']
 * @param {number} [options.seed] - if omitted, a random seed is generated
 * @param {string} [options.outDir='generated_maps'] - only used when writeToDisk is true
 * @param {boolean} [options.writeToDisk=true] - set false to skip the filesystem entirely
 *   (use this on hosted servers with ephemeral/read-only disks)
 * @param {number} [options.goodPct=20]
 * @param {number} [options.badPct=20]
 * @param {number} [options.shopPct=5]
 * @returns {{ outFile: string|null, seed: number, map: object, degreeRange: [number, number] }}
 */
function generateMap(options) {
  const {
    nodes,
    kNearest = 10,
    jitter = 0.15,
    density = 'high',
    seed: seedOption,
    outDir = 'generated_maps',
    writeToDisk = true,
    goodPct = 20.0,
    badPct = 20.0,
    shopPct = 5.0,
  } = options;

  if (nodes < 8) {
    throw new Error('Use at least 8 nodes for a meaningful map.');
  }
  if (!(kNearest >= 2 && kNearest <= Math.max(2, nodes - 1))) {
    throw new Error('k-nearest must be at least 2 and smaller than node count.');
  }
  if (jitter < 0) {
    throw new Error('jitter cannot be negative.');
  }
  if (goodPct < 0 || badPct < 0 || shopPct < 0) {
    throw new Error('Node-type percentages cannot be negative.');
  }
  if (goodPct + badPct + shopPct > 100) {
    throw new Error('good/bad/shop percentages cannot add up to more than 100.');
  }
  if (!Object.keys(DENSITY_FACTORS).includes(density)) {
    throw new Error('Density must be low, medium, or high.');
  }

  const seed =
    seedOption !== undefined && seedOption !== null
      ? seedOption
      : Math.floor(Math.random() * 1e9) + 1;
  const rng = new SeededRandom(seed);

  const points = fibonacciSpherePoints(nodes, jitter, rng);
  const dist = computeDistanceMatrix(points);
  const immediate = buildImmediateNeighbors(dist, kNearest);
  const twoLayer = buildTwoLayerCandidates(immediate);
  const nodeTypes = assignNodeTypes(nodes, rng, goodPct, badPct, shopPct);

  const edges = generateConnectedGraph(dist, immediate, twoLayer, density, rng);

  let outFile = null;
  let map;
  if (writeToDisk) {
    const result = exportMap(outDir, seed, points, edges, immediate, twoLayer, nodeTypes);
    outFile = result.outFile;
    map = result.payload;
  } else {
    map = buildMapPayload(seed, points, edges, immediate, twoLayer, nodeTypes);
  }

  const adjacency = buildAdjacency(points.length, edges);
  const degrees = Array.from(adjacency.values()).map((v) => v.length);
  const degreeRange = [Math.min(...degrees), Math.max(...degrees)];

  return { outFile, seed, map, degreeRange, nodeTypes, edgeCount: edges.size };
}

function parseArgs(argv) {
  const args = {
    nodes: 40,
    kNearest: 10,
    jitter: 0.15,
    density: 'high',
    seed: null,
    outDir: 'generated_maps',
    goodPct: 20.0,
    badPct: 20.0,
    shopPct: 5.0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--nodes':
        args.nodes = parseInt(next(), 10);
        break;
      case '--k-nearest':
        args.kNearest = parseInt(next(), 10);
        break;
      case '--jitter':
        args.jitter = parseFloat(next());
        break;
      case '--density':
        args.density = next();
        break;
      case '--seed':
        args.seed = parseInt(next(), 10);
        break;
      case '--out-dir':
        args.outDir = next();
        break;
      case '--good-pct':
        args.goodPct = parseFloat(next());
        break;
      case '--bad-pct':
        args.badPct = parseFloat(next());
        break;
      case '--shop-pct':
        args.shopPct = parseFloat(next());
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Generate a hidden board-game map as a graph on a sphere.
Each node gets 1 to 6 local/two-layer connections.

Options:
  --nodes <n>        Number of dots on the sphere. (default: 40)
  --k-nearest <n>     Immediate neighborhood size used to build local 2-layer candidates. (default: 10)
  --jitter <f>        Small angular noise for less predictable point placement. (default: 0.15)
  --density <s>       Connection density profile: low, medium, or high. (default: high)
  --seed <n>          Random seed for reproducibility. If omitted, a random seed is used.
  --out-dir <path>    Folder where the JSON map file will be saved. (default: generated_maps)
  --good-pct <f>      Percentage of nodes marked as good. (default: 20)
  --bad-pct <f>       Percentage of nodes marked as bad. (default: 20)
  --shop-pct <f>      Percentage of nodes marked as shop. (default: 5)
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    const { outFile, seed, degreeRange, nodeTypes, edgeCount } = generateMap({
      nodes: args.nodes,
      kNearest: args.kNearest,
      jitter: args.jitter,
      density: args.density,
      seed: args.seed,
      outDir: args.outDir,
      goodPct: args.goodPct,
      badPct: args.badPct,
      shopPct: args.shopPct,
    });

    console.log(`Map generated: ${outFile}`);
    console.log(`Seed: ${seed}`);
    console.log(`Density: ${args.density}`);
    console.log(`Nodes: ${args.nodes}, Edges: ${edgeCount}`);
    console.log(
      'Node types: ' +
        `normal=${nodeTypes.filter((t) => t === 'normal').length}, ` +
        `good=${nodeTypes.filter((t) => t === 'good').length}, ` +
        `bad=${nodeTypes.filter((t) => t === 'bad').length}, ` +
        `shop=${nodeTypes.filter((t) => t === 'shop').length}`
    );
    console.log(`Degree range: ${degreeRange[0]}..${degreeRange[1]}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SeededRandom,
  fibonacciSpherePoints,
  euclideanDistance,
  computeDistanceMatrix,
  buildImmediateNeighbors,
  buildTwoLayerCandidates,
  generateConnectedGraph,
  buildAdjacency,
  assignNodeTypes,
  buildMapPayload,
  exportMap,
  generateMap,
  DENSITY_FACTORS,
  NODE_TYPES,
};
