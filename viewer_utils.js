// Pure helper functions for the viewer (no browser APIs, so they can be tested).

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;
const EARTH_C = 40075016.686;
const TAU = Math.PI * 2;
const NO_FROM = -99999, NO_TO = 99999;          // "no date" sentinels (match the map filters)

// [west, south, east, north] of a rectangle centred on [lon, lat] with half-extents in metres [halfWidth, halfHeight].
export function areaBounds(centre, halfM) {
  const [lon, lat] = centre;
  const dLon = halfM[0] / (M_PER_DEG_LON_EQ * Math.cos(lat * Math.PI / 180));
  const dLat = halfM[1] / M_PER_DEG_LAT;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export function padBounds(b, deg) {
  return [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];
}

export function inBounds([lon, lat], b) {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

// Footprint centroid [lon, lat] (first/largest ring; offsets from vertex 0 for precision)
export function centroid(geom) {
  const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
  const [ox, oy] = ring[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x0 = ring[j][0] - ox, y0 = ring[j][1] - oy, x1 = ring[i][0] - ox, y1 = ring[i][1] - oy;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a *= 0.5;
  return a ? [ox + cx / (6 * a), oy + cy / (6 * a)] : [ox, oy];
}

// MapLibre icon-size expression that keeps an icon a fixed real-world width (metres) at any zoom.
// (No longer used by index.html now that the outside of the area is plain black; kept for compatibility.)
export function iconSizeExpr(realWidthM, imageWidthPx, lat) {
  const C = EARTH_C * Math.cos(lat * Math.PI / 180);
  const s = z => realWidthM / ((C / (512 * 2 ** z)) * imageWidthPx);
  return ['interpolate', ['exponential', 2], ['zoom'], 10, s(10), 20, s(20)];
}

// (Unused by index.html any more; kept so existing tests/imports don't break.)
export function decorPoints(centre, halfM, { stepM = 1500, reachM = 13500, clearM = 550 } = {}) {
  const [lon0, lat0] = centre;
  const mLon = M_PER_DEG_LON_EQ * Math.cos(lat0 * Math.PI / 180);
  const icons = ['serpent', 'label-dragons', 'serpent-r', 'label-incognita', 'serpent-r', 'serpent'];
  const feats = [];
  const n = Math.floor(reachM / stepM);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const jitterX = (((i * 37 + j * 11) % 7) - 3) * 70;
      const jitterY = (((i * 13 + j * 29) % 7) - 3) * 70;
      const dx = i * stepM + jitterX, dy = j * stepM + jitterY;
      if (Math.abs(dx) < halfM[0] + clearM && Math.abs(dy) < halfM[1] + clearM) continue;
      const k = ((i * 7 + j * 3) % icons.length + icons.length) % icons.length;
      feats.push({
        type: 'Feature',
        properties: { icon: icons[k], rot: (((i * 53 + j * 31) % 41) + 41) % 41 - 20 },
        geometry: { type: 'Point', coordinates: [lon0 + dx / mLon, lat0 + dy / M_PER_DEG_LAT] }
      });
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

// Date "events": the years at which the set of visible features can change.
// While the slider moves within one bucket nothing needs re-filtering.
export class EventIndex {
  constructor() { this.years = new Set(); this.sorted = null; }
  add(y) { if (y != null && Number.isFinite(y)) { this.years.add(y); this.sorted = null; } }
  addFeature(p, undatedStart = null) {
    if (p.from_year != null) this.add(p.from_year); else if (undatedStart != null) this.add(undatedStart);
    if (p.to_year != null) this.add(p.to_year + 1);   // to_year is the LAST year shown
  }
  bucket(y) {
    if (!this.sorted) this.sorted = [...this.years].sort((a, b) => a - b);
    let lo = 0, hi = this.sorted.length;               // count of events <= y
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sorted[mid] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const U = (rnd, a, b) => a + (b - a) * rnd();
const yearOr = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : d;

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function polygonContains(rings, x, y) {          // rings[0] outer, the rest holes
  if (!ringContains(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], x, y)) return false;
  return true;
}
function polygonsOf(geom) {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
}

// Bounding box [w, s, e, n] of any GeoJSON geometry, and an overlap test.
export function geomBBox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = c => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [w, s, e, n];
}
export function bboxesOverlap(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

// ---------------------------------------------------------------------------------------------
// Clipping to the area rectangle, so nothing is ever drawn outside it.

const clipPass = (pts, inside, cross) => {
  if (!pts.length) return pts;
  const out = [];
  let prev = pts[pts.length - 1], pin = inside(prev);
  for (const cur of pts) {
    const cin = inside(cur);
    if (cin) { if (!pin) out.push(cross(prev, cur)); out.push(cur); }
    else if (pin) out.push(cross(prev, cur));
    prev = cur; pin = cin;
  }
  return out;
};

// Sutherland-Hodgman clip of one closed ring [[x,y],...] to box [w,s,e,n]. Returns a closed ring or null.
export function clipRingToBox(ring, [w, s, e, n]) {
  let pts = ring.slice();
  const f = pts[0], l = pts[pts.length - 1];
  if (f[0] === l[0] && f[1] === l[1]) pts.pop();
  const atX = X => (a, b) => [X, a[1] + (X - a[0]) / (b[0] - a[0]) * (b[1] - a[1])];
  const atY = Y => (a, b) => [a[0] + (Y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]), Y];
  pts = clipPass(pts, p => p[0] >= w, atX(w));
  pts = clipPass(pts, p => p[0] <= e, atX(e));
  pts = clipPass(pts, p => p[1] >= s, atY(s));
  pts = clipPass(pts, p => p[1] <= n, atY(n));
  if (pts.length < 3) return null;
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

// Clip a Polygon/MultiPolygon to the box. Returns the same object when it is already inside, null when
// nothing is left. Other geometry types are returned unchanged.
export function clipGeometryToBox(geom, box) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return geom;
  const bb = geomBBox(geom);
  if (bb[0] >= box[0] && bb[2] <= box[2] && bb[1] >= box[1] && bb[3] <= box[3]) return geom;
  if (!bboxesOverlap(bb, box)) return null;
  const clipPoly = rings => {
    const outer = clipRingToBox(rings[0], box);
    if (!outer) return null;
    const out = [outer];
    for (let k = 1; k < rings.length; k++) { const h = clipRingToBox(rings[k], box); if (h) out.push(h); }
    return out;
  };
  if (geom.type === 'Polygon') {
    const p = clipPoly(geom.coordinates);
    return p && { type: 'Polygon', coordinates: p };
  }
  const polys = geom.coordinates.map(clipPoly).filter(Boolean);
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

// Liang-Barsky clip of a polyline to the box. Returns an array of runs (each an array of [x,y]).
export function clipLineToBox(coords, [w, s, e, n]) {
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < coords.length; i++) {
    const x0 = coords[i][0], y0 = coords[i][1], x1 = coords[i + 1][0], y1 = coords[i + 1][1];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { cur = null; continue; }
    if (!cur || t0 > 0) { cur = [[x0 + t0 * dx, y0 + t0 * dy]]; runs.push(cur); }
    cur.push([x0 + t1 * dx, y0 + t1 * dy]);
    if (t1 < 1) cur = null;
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Local frame for everything drawn with Three.js.
//
// MapLibre's mercator coordinates are 0..1 over the whole world, so a float32 vertex there is only
// good to ~2 m. Instead every vertex is stored in metres east/north/up of the area centre (float32 is
// then good to a fraction of a millimetre) and one double-precision matrix maps that frame to
// mercator: T(origin) * S(s0, -s0, s0).

export const mercX = lon => (lon + 180) / 360;
export const mercY = lat => {
  const s = Math.sin(lat * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export function makeFrame(centre) {
  const [lon0, lat0] = centre;
  const ox = mercX(lon0), oy = mercY(lat0);
  const s0 = 1 / (EARTH_C * Math.cos(lat0 * Math.PI / 180));     // mercator units per metre at the centre
  return {
    ox, oy, s0,
    toLocal: (lon, lat) => [(mercX(lon) - ox) / s0, -(mercY(lat) - oy) / s0],
    toMerc: (e, n) => [ox + e * s0, oy - n * s0],
  };
}

// ---------------------------------------------------------------------------------------------
// Terrain heights. A regular grid in mercator space (cell (0,0) centre at x0,y0; cell size dx,dy),
// stored as decimetres in an Int16Array. Trees, water, mist and models all sample the same field.

export const terrariumM = (r, g, b) => r * 256 + g + b / 256 - 32768;

export class Heightfield {
  constructor({ x0, y0, dx, dy, nx, ny, data, scale = 0.1 }) {
    Object.assign(this, { x0, y0, dx, dy, nx, ny, data, scale });
  }
  sampleMerc(x, y) {
    const { nx, ny, data, scale } = this;
    let u = (x - this.x0) / this.dx, v = (y - this.y0) / this.dy;
    u = u < 0 ? 0 : u > nx - 1 ? nx - 1 : u;
    v = v < 0 ? 0 : v > ny - 1 ? ny - 1 : v;
    const i = Math.min(nx - 2, Math.floor(u)), j = Math.min(ny - 2, Math.floor(v));
    if (i < 0 || j < 0) return data[0] * scale;                   // 1-cell-wide grid
    const fu = u - i, fv = v - j, k = j * nx + i;
    return ((data[k] * (1 - fu) + data[k + 1] * fu) * (1 - fv) +
            (data[k + nx] * (1 - fu) + data[k + nx + 1] * fu) * fv) * scale;
  }
}

// Height for a surface (water, road, rail) that must stay visible on the terrain MapLibre actually
// draws. The GPU samples DEM texels slightly differently from our CPU-side field (typically by one to
// two texels, i.e. a few metres), which on a slope means the true surface can sit a few decimetres above
// our number and bury a flat mesh. So: look at the ground a few metres either side too, and return the
// ground height PLUS a share (`share` 0..1) of how much higher the highest neighbour is. On flat ground
// this is just the height; on a slope it adds roughly (slope x radius) of safety margin automatically.
export function tolerantHeight(heightAt, e, n, share = 1, R = 3.5) {
  const h = heightAt(e, n);
  let hi = h;
  for (const [de, dn] of [[R, 0], [-R, 0], [0, R], [0, -R]]) {
    const v = heightAt(e + de, n + dn);
    if (v > hi) hi = v;
  }
  return h + share * (hi - h);
}

// ---------------------------------------------------------------------------------------------
// Trees.
//
// Trees are drawn as GPU instances of two tiny low-poly meshes (broadleaf, conifer). A tree is ONE
// instance (position, height, a few shape parameters, colour shade, years); the vertex shader shapes
// the shared mesh with those parameters, so there is no per-tree geometry at all. Dates and seasons
// are shader uniforms, so changing the year or season costs nothing on the CPU.
//
// Proportions are fractions of the tree height H (taken from the FBX pack like before):
//   broadleaf: trunkTop; crown = ellipsoid at height cz with horizontal radius rxy and vertical radius rz
//              (plus `clump` = how much the three small side blobs stick out, 0..1)
//   conifer:   trunkTop; stacked cones from height `base` to H, bottom radius rxy

export const TREE_VARIETIES = {
  broadleaf: [
    { w: 35, name: 'round',  trunkTop: 0.74, trunkR: 0.035, cz: 0.84, rxy: 0.245, rz: 0.17, clump: 1.0 },
    { w: 25, name: 'oval',   trunkTop: 0.62, trunkR: 0.030, cz: 0.75, rxy: 0.155, rz: 0.27, clump: 0.7 },
    { w: 20, name: 'spread', trunkTop: 0.70, trunkR: 0.035, cz: 0.87, rxy: 0.280, rz: 0.13, clump: 1.0 },
    { w: 20, name: 'column', trunkTop: 0.50, trunkR: 0.030, cz: 0.66, rxy: 0.150, rz: 0.34, clump: 0.0 },
  ],
  conifer: [
    { w: 35, name: 'spruce',  trunkTop: 0.55, trunkR: 0.035, base: 0.17, rxy: 0.230 },
    { w: 20, name: 'layered', trunkTop: 0.45, trunkR: 0.035, base: 0.12, rxy: 0.300 },
    { w: 45, name: 'pine',    trunkTop: 0.96, trunkR: 0.028, base: 0.42, rxy: 0.170 },
  ],
};
for (const list of Object.values(TREE_VARIETIES)) {
  let total = 0; for (const s of list) total += s.w;
  let acc = 0; for (const s of list) { acc += s.w / total; s.cum = acc; }
}
const pickVariety = (kind, r) => {
  const list = TREE_VARIETIES[kind === 1 ? 'conifer' : 'broadleaf'];
  for (let i = 0; i < list.length; i++) if (r <= list[i].cum) return i;
  return 0;
};

// Per-row edge index so a point-in-polygon test only looks at the few edges crossing its row.
function makeRowIndex(rings, y0, dy, rows) {
  const edges = [], buckets = Array.from({ length: rows }, () => []);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
      if (ay === by) continue;                                   // horizontal edges never toggle
      const id = edges.length / 4;
      edges.push(ax, ay, bx, by);
      const lo = Math.max(0, Math.floor((Math.min(ay, by) - y0) / dy));
      const hi = Math.min(rows - 1, Math.floor((Math.max(ay, by) - y0) / dy));
      for (let r = lo; r <= hi; r++) buckets[r].push(id);
    }
  }
  return (x, y) => {
    const r = Math.floor((y - y0) / dy);
    if (r < 0 || r >= rows) return false;
    let inside = false;
    for (const id of buckets[r]) {
      const k = id * 4, ay = edges[k + 1], by = edges[k + 3];
      if ((by > y) !== (ay > y) && x < (edges[k + 2] - edges[k]) * (y - ay) / (by - ay) + edges[k]) inside = !inside;
    }
    return inside;
  };
}

// forests: FeatureCollection of polygons with {id, tree_type, density, tree_h, from_year, to_year}.
// Every tree inherits its forest's dates (from_year..to_year inclusive, the same convention as the
// buildings); a forest with no from_year starts at `undatedFrom` (default: always there).
// `clearance(lon, lat)` (see makeCorridors) keeps trees off roads and railways while those exist.
// Returns trees as parallel typed arrays (see below). Only trees inside `box` ([W,S,E,N], inset by
// insetM so crowns never poke out) are made, thinned evenly to at most maxTrees.
export function generateTrees(forests, box, { maxTrees = 40000, insetM = 4, undatedFrom = NO_FROM, clearance = null } = {}) {
  const lat0 = (box[1] + box[3]) / 2;
  const mLon = M_PER_DEG_LON_EQ * Math.cos(lat0 * Math.PI / 180);
  const ix = insetM / mLon, iy = insetM / M_PER_DEG_LAT;
  const bx = [box[0] + ix, box[1] + iy, box[2] - ix, box[3] - iy];
  const c = { lon: [], lat: [], h: [], yaw: [], tone: [], jit: [], clump: [], kind: [], variety: [], shade: [], from: [], to: [] };

  forests.features.forEach((f, fi) => {
    const p = f.properties || {};
    const rnd = mulberry32(hashString(String(p.id ?? fi)));
    const density = Number(p.density) > 0 ? Number(p.density) : 80;
    const spacing = Math.sqrt(10000 / density);
    const dLon = spacing / mLon, dLat = spacing / M_PER_DEG_LAT;
    const type = p.tree_type === 'conifer' || p.tree_type === 'broadleaf' ? p.tree_type : 'mixed';
    const meanH = Number(p.tree_h) > 0 ? Number(p.tree_h) : 12;
    // Same timeline rule as the buildings: shown from from_year (or `undatedFrom` when there is none)
    // up to and including to_year (forever when there is none).
    const from = yearOr(p.from_year, undatedFrom), to = yearOr(p.to_year, NO_TO);
    for (const rings of polygonsOf(f.geometry)) {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const [x, y] of rings[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      w = Math.max(w, bx[0]); e = Math.min(e, bx[2]); s = Math.max(s, bx[1]); n = Math.min(n, bx[3]);
      if (!(w < e && s < n)) continue;
      const rowY0 = Math.floor(s / dLat) * dLat - dLat, rows = Math.ceil((n - rowY0) / dLat) + 2;
      const inside = makeRowIndex(rings, rowY0, dLat, rows);
      for (let y = Math.floor(s / dLat) * dLat; y < n; y += dLat) {
        for (let x = Math.floor(w / dLon) * dLon; x < e; x += dLon) {
          const px = x + (rnd() - 0.5) * 0.9 * dLon, py = y + (rnd() - 0.5) * 0.9 * dLat;
          if (px < bx[0] || px > bx[2] || py < bx[1] || py > bx[3]) continue;
          if (!inside(px, py)) continue;
          // all random numbers are drawn before the clearance test, so adding a road never moves other trees
          const kind = (type === 'mixed' ? rnd() < 0.5 : type === 'conifer') ? 1 : 0;
          const h = meanH * (0.75 + 0.5 * rnd()), variety = pickVariety(kind, rnd()), yaw = rnd() * TAU;
          const tone = U(rnd, 0.9, 1.12), jit = U(rnd, 0.88, 1.12), clump = U(rnd, 0.8, 1.15), shade = Math.floor(rnd() * 4);
          // a tree on a road corridor is hidden for the years the road exists (it can come back after it closes)
          const blocks = clearance && clearance(px, py);
          const pieces = blocks ? subtractYears(from, to, blocks) : [[from, to]];
          for (const [pf, pt] of pieces) {
            c.lon.push(px); c.lat.push(py); c.h.push(h); c.kind.push(kind); c.variety.push(variety); c.yaw.push(yaw);
            c.tone.push(tone); c.jit.push(jit); c.clump.push(clump); c.shade.push(shade); c.from.push(pf); c.to.push(pt);
          }
        }
      }
    }
  });

  const candidates = c.lon.length;
  let keep = null, thin = 1;
  if (candidates > maxTrees) {                            // deterministic, even thinning to the cap
    thin = maxTrees / candidates;
    const rnd = mulberry32(12345);
    keep = [];
    for (let i = 0; i < candidates; i++) if (rnd() < thin) keep.push(i);
  }
  const count = keep ? keep.length : candidates;
  const pick = (arr, Type) => {
    const out = new Type(count);
    if (keep) for (let i = 0; i < count; i++) out[i] = arr[keep[i]];
    else for (let i = 0; i < count; i++) out[i] = arr[i];
    return out;
  };
  return {
    count, candidates, thin,
    lon: pick(c.lon, Float64Array), lat: pick(c.lat, Float64Array),
    h: pick(c.h, Float32Array), yaw: pick(c.yaw, Float32Array), tone: pick(c.tone, Float32Array),
    jit: pick(c.jit, Float32Array), clump: pick(c.clump, Float32Array),
    kind: pick(c.kind, Uint8Array), variety: pick(c.variety, Uint8Array), shade: pick(c.shade, Uint8Array),
    from: pick(c.from, Float32Array), to: pick(c.to, Float32Array),
  };
}

// Place trees in the local frame: east/north in metres and ground height (sunk a little so trunks
// never float on slopes). heightAt(e, n) -> metres.
export function localiseTrees(t, frame, heightAt, sinkM = 0.35) {
  const e = new Float32Array(t.count), n = new Float32Array(t.count), z = new Float32Array(t.count);
  for (let i = 0; i < t.count; i++) {
    const [x, y] = frame.toLocal(t.lon[i], t.lat[i]);
    const h = heightAt(x, y);
    e[i] = x; n[i] = y; z[i] = (Number.isFinite(h) ? h : 0) - sinkM;
  }
  return { e, n, z };
}

// Pack the trees `ids` (all of one `kind`: 0 broadleaf, 1 conifer) into instance attribute arrays
// (4 floats each):
//   A = east, north, ground z, height
//   B = yaw, trunkTop, crown a, crown b       (broadleaf: cz, rxy   | conifer: base, rxy)
//   C = crown c, trunkR, tone, shade          (broadleaf: rz        | conifer: unused)
//   D = from year, to year, clump, 0
// plus the chunk's bounds [minE, minN, minZ, maxE, maxN, maxZ] (including tree height).
export function packTreeChunk(t, loc, ids, kind) {
  const n = ids.length;
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4), D = new Float32Array(n * 4);
  const list = TREE_VARIETIES[kind === 1 ? 'conifer' : 'broadleaf'];
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const i = ids[k], v = list[t.variety[i]], o = k * 4, H = t.h[i];
    A[o] = loc.e[i]; A[o + 1] = loc.n[i]; A[o + 2] = loc.z[i]; A[o + 3] = H;
    B[o] = t.yaw[i]; B[o + 1] = v.trunkTop;
    if (kind === 1) { B[o + 2] = v.base; B[o + 3] = v.rxy * t.jit[i]; C[o] = 0; D[o + 2] = 0; }
    else { B[o + 2] = v.cz; B[o + 3] = v.rxy * t.jit[i]; C[o] = v.rz * t.jit[i]; D[o + 2] = Math.min(1.15, v.clump * t.clump[i]); }
    C[o + 1] = v.trunkR; C[o + 2] = t.tone[i]; C[o + 3] = t.shade[i];
    D[o] = t.from[i]; D[o + 1] = t.to[i];
    const r = (kind === 1 ? v.rxy : v.rxy * 1.4) * H * t.jit[i];                 // crown reach
    bounds[0] = Math.min(bounds[0], loc.e[i] - r); bounds[1] = Math.min(bounds[1], loc.n[i] - r);
    bounds[2] = Math.min(bounds[2], loc.z[i]);
    bounds[3] = Math.max(bounds[3], loc.e[i] + r); bounds[4] = Math.max(bounds[4], loc.n[i] + r);
    bounds[5] = Math.max(bounds[5], loc.z[i] + H * 1.05);
  }
  return { A, B, C, D, count: n, bounds };
}

// The two shared tree meshes in "unit" space, as flat non-indexed arrays with a face normal per
// vertex. part: 0 = trunk, 1 = crown (main), 2 = side clump (broadleaf only).
//   trunk:  radius 1 at z=0 tapering to 0.6 at z=1
//   crown:  broadleaf: unit icosahedron + 3 small octahedra;   conifer: 3 stacked cones spanning z 0..1
// All faces wind counter-clockwise seen from outside, in a right-handed east/north/up frame.
export function buildTreeMeshes() {
  const make = () => {
    const position = [], normal = [], part = [];
    const tri = (a, b, c, centre, p) => {
      let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const gx = (a[0] + b[0] + c[0]) / 3 - centre[0], gy = (a[1] + b[1] + c[1]) / 3 - centre[1], gz = (a[2] + b[2] + c[2]) / 3 - centre[2];
      if (nx * gx + ny * gy + nz * gz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      for (const q of [a, b, c]) { position.push(q[0], q[1], q[2]); normal.push(nx / l, ny / l, nz / l); part.push(p); }
    };
    return { tri, out: () => ({ position: new Float32Array(position), normal: new Float32Array(normal), part: new Float32Array(part) }) };
  };

  const trunk = m => {
    const R0 = 1, R1 = 0.6, N = 5, c = [0, 0, 0.5];
    for (let i = 0; i < N; i++) {
      const a0 = i / N * TAU + 0.3, a1 = (i + 1) / N * TAU + 0.3;
      const b0 = [Math.cos(a0) * R0, Math.sin(a0) * R0, 0], b1 = [Math.cos(a1) * R0, Math.sin(a1) * R0, 0];
      const t0 = [Math.cos(a0) * R1, Math.sin(a0) * R1, 1], t1 = [Math.cos(a1) * R1, Math.sin(a1) * R1, 1];
      m.tri(b0, b1, t1, c, 0); m.tri(b0, t1, t0, c, 0);
    }
  };

  // broadleaf
  const bl = make();
  trunk(bl);
  const g = (1 + Math.sqrt(5)) / 2;
  const iv = [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]]
    .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
  const ifaces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
                  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let i = 0; i < ifaces.length; i += 3) bl.tri(iv[ifaces[i]], iv[ifaces[i + 1]], iv[ifaces[i + 2]], [0, 0, 0], 1);
  const octa = (cx, cy, cz, r) => {
    const v = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].map(([x, y, z]) => [cx + x, cy + y, cz + z]);
    for (const [a, b, c] of [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]])
      bl.tri(v[a], v[b], v[c], [cx, cy, cz], 2);
  };
  octa(0.78, 0.15, -0.42, 0.55); octa(-0.42, 0.74, -0.38, 0.52); octa(-0.40, -0.72, -0.30, 0.50);

  // conifer
  const co = make();
  trunk(co);
  const cone = (zb, zt, R) => {
    const N = 6, apex = [0, 0, zt], c = [0, 0, (zb + zt) / 2 - 0.05];
    for (let i = 0; i < N; i++) {
      const a0 = i / N * TAU, a1 = (i + 1) / N * TAU;
      co.tri([Math.cos(a0) * R, Math.sin(a0) * R, zb], [Math.cos(a1) * R, Math.sin(a1) * R, zb], apex, c, 1);
    }
  };
  cone(0.00, 0.52, 1.00); cone(0.27, 0.78, 0.72); cone(0.54, 1.00, 0.46);

  return { broadleaf: bl.out(), conifer: co.out() };
}

// ---------------------------------------------------------------------------------------------
// Water.
//
// The animated water surface is real geometry drawn over the terrain: the water polygons are cut into
// small grid pieces and triangulated (so heights follow the terrain), and each waterway line becomes a
// thin ribbon. Every vertex carries a flow velocity (m/s) so the shader can slide the ripples along the
// current: ribbons use their own direction; polygon vertices take the direction of the nearby
// waterway lines (a river polygon flows along its centre line; a pond with no stream nearby is still).

// radius = how far from the line the water still follows its current (a wide river needs this to cover its banks)
const WATERWAY = {
  river:  { speed: 1.1, radius: 220, width: 12 },
  stream: { speed: 0.8, radius: 40,  width: 2.5 },
  canal:  { speed: 0.3, radius: 25,  width: 6 },
  drain:  { speed: 0.4, radius: 18,  width: 1.8 },
};
const waterwayClass = cls => WATERWAY[cls] || (cls === 'ditch' ? WATERWAY.drain : WATERWAY.stream);

// Cut a polygon into small, well-shaped pieces along a regular grid of `cell` metres and hand each
// triangle to push(p, q, r). Why not just triangulate it whole? Ear clipping a long thin river gives
// triangles with edges over a kilometre long; those can't follow the terrain and would need tens of
// thousands of extra triangles to fix. Grid pieces are always <= cell wide, the count scales with the
// water's area, and the polygon boundary stays exact. Pieces that share a grid line share its vertices.
//   rings: [[e,n],...] arrays, NOT closed; rings[0] is the outer ring, the rest are holes (islands).
//   triangulate(flat, holeStarts) -> flat index array (earcut-style) for the odd-shaped pieces.
function tessellatePolygon(rings, cell, triangulate, push) {
  const closed = r => [...r, r[0]];
  const bboxOf = r => { let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return [w, s, e, n]; };
  const area = pts => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return a / 2; };
  const convex = pts => {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-9) continue;
      if (sign && (cr > 0) !== (sign > 0)) return false;
      sign = cr;
    }
    return true;
  };
  const holes = rings.slice(1).map(r => ({ ring: closed(r), bb: bboxOf(r) }));

  const emit = (piece, pieceHoles) => {                       // piece: closed ring from the clipper
    const pts = piece.slice(0, -1);
    if (pts.length < 3 || Math.abs(area(pts)) < 1e-3) return;
    if (!pieceHoles.length && (pts.length === 3 || (pts.length === 4 && convex(pts)))) {
      push(pts[0], pts[1], pts[2]);
      if (pts.length === 4) push(pts[0], pts[2], pts[3]);
      return;
    }
    const all = [...pts], starts = [];
    for (const h of pieceHoles) { starts.push(all.length); all.push(...h.slice(0, -1)); }
    let idx;
    try { idx = triangulate(all.flatMap(p => p), starts); } catch (_) { return; }
    for (let i = 0; i < idx.length; i += 3) push(all[idx[i]], all[idx[i + 1]], all[idx[i + 2]]);
  };
  const inRing = (ring, x, y) => ringContains(ring, x, y);

  const outer = closed(rings[0]);
  const handle = (x0, y0, x1, y1, source, depth) => {
    const piece = clipRingToBox(source, [x0, y0, x1, y1]);
    if (!piece) return;
    const touching = holes.filter(h => h.bb[0] <= x1 && h.bb[2] >= x0 && h.bb[1] <= y1 && h.bb[3] >= y0);
    if (!touching.length) return emit(piece, []);
    if (touching.every(h => h.bb[0] > x0 && h.bb[2] < x1 && h.bb[1] > y0 && h.bb[3] < y1)) return emit(piece, touching.map(h => h.ring));
    if (depth >= 2) {                                         // an island's shore crosses this cell: decide per small piece
      let cx = 0, cy = 0; const n = piece.length - 1;
      for (let i = 0; i < n; i++) { cx += piece[i][0]; cy += piece[i][1]; }
      if (!touching.some(h => inRing(h.ring, cx / n, cy / n))) emit(piece, []);
      return;
    }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    handle(x0, y0, mx, my, piece, depth + 1); handle(mx, y0, x1, my, piece, depth + 1);
    handle(x0, my, mx, y1, piece, depth + 1); handle(mx, my, x1, y1, piece, depth + 1);
  };

  const [w, s, e, n] = bboxOf(rings[0]);
  const i0 = Math.floor(w / cell), i1 = Math.floor(e / cell), j0 = Math.floor(s / cell), j1 = Math.floor(n / cell);
  for (let j = j0; j <= j1; j++) {
    // clip to the row first (cheap), then each cell of the row against that smaller ring
    const row = clipRingToBox(outer, [w - 1, j * cell, e + 1, (j + 1) * cell]);
    if (!row) continue;
    for (let i = i0; i <= i1; i++) handle(i * cell, j * cell, (i + 1) * cell, (j + 1) * cell, row, 0);
  }
}

// Remove repeated consecutive points (and a last point equal to the first): the triangulator drops
// those itself, which would shift the vertex numbering we rely on.
function dedupeRing(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

// features: GeoJSON features of kind 'water' (polygons) and 'waterway' (lines), with optional
// from_year / to_year. Options:
//   frame      makeFrame() result;  box [W,S,E,N] in degrees (geometry is clipped to it)
//   heightAt   (east, north) -> ground height in metres
//   triangulate(flat [x0,y0,x1,y1,...], holeStartIndices) -> flat triangle index array (earcut-style)
//   maxEdge    grid size in metres for cutting the water polygons;  speed multiplier;  reverse flips every flow
// Returns { position(e,n,z), flow(e,n), years(from,to) as Float32Arrays, index Uint32Array } or null.
export function buildWater(features, { frame, box, heightAt, triangulate, maxEdge = 30, speed = 1, reverse = false }) {
  const sgn = (reverse ? -1 : 1) * speed;
  const lines = [], polys = [];
  // Water follows the terrain with a margin on slopes (see tolerantHeight), so it is never buried.
  const lowAt = (e, n) => tolerantHeight(heightAt, e, n, 0.7);

  for (const f of features) {
    const p = f.properties || {}, g = f.geometry;
    if (!g) continue;
    const from = yearOr(p.from_year, NO_FROM), to = yearOr(p.to_year, NO_TO);
    if (p.kind === 'waterway' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
      const cls = waterwayClass(p.cls);
      for (const part of g.type === 'LineString' ? [g.coordinates] : g.coordinates)
        for (const run of clipLineToBox(part, box))
          if (run.length >= 2) lines.push({ pts: run.map(([lo, la]) => frame.toLocal(lo, la)), cls, from, to });
    } else if (p.kind === 'water' && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      const clipped = clipGeometryToBox(g, box);
      if (!clipped) continue;
      for (const rings of polygonsOf(clipped)) {
        const local = rings.map(r => dedupeRing(r.slice(0, -1).map(([lo, la]) => frame.toLocal(lo, la))));
        if (local[0].length < 3) continue;                       // need a valid outer ring
        polys.push({ rings: local.filter(r => r.length >= 3), from, to });
      }
    }
  }
  if (!polys.length && !lines.length) return null;

  // ---- flow field from the waterway lines: spatial hash of segments, each listed in every cell its
  // influence radius touches, so a lookup only reads one cell.
  const CELL = 80, cells = new Map();
  const cellKey = (i, j) => (i + 4096) * 8192 + (j + 4096);
  for (const ln of lines) {
    for (let i = 0; i + 1 < ln.pts.length; i++) {
      const [x0, y0] = ln.pts[i], [x1, y1] = ln.pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1e-6) continue;
      const seg = { x0, y0, x1, y1, len, vx: (x1 - x0) / len * ln.cls.speed * sgn, vy: (y1 - y0) / len * ln.cls.speed * sgn,
                    r: ln.cls.radius, from: ln.from, to: ln.to };
      const r = seg.r;
      for (let ci = Math.floor((Math.min(x0, x1) - r) / CELL); ci <= Math.floor((Math.max(x0, x1) + r) / CELL); ci++)
        for (let cj = Math.floor((Math.min(y0, y1) - r) / CELL); cj <= Math.floor((Math.max(y0, y1) + r) / CELL); cj++) {
          const k = cellKey(ci, cj);
          let list = cells.get(k);
          if (!list) cells.set(k, list = []);
          list.push(seg);
        }
    }
  }
  const out = { x: 0, y: 0 };
  const flowAt = (e, n, y0, y1) => {
    out.x = 0; out.y = 0;
    const list = cells.get(cellKey(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (!list) return out;
    let sx = 0, sy = 0, sw = 0;
    for (const s of list) {
      if (s.to < y0 || s.from > y1) continue;                  // only lines that exist in the same years
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
      const t = Math.max(0, Math.min(1, ((e - s.x0) * dx + (n - s.y0) * dy) / (s.len * s.len)));
      const d = Math.hypot(e - (s.x0 + t * dx), n - (s.y0 + t * dy));
      if (d >= s.r) continue;
      const w = (1 - d / s.r) ** 2;
      sx += w * s.vx; sy += w * s.vy; sw += w;
    }
    if (sw > 0) { const k = 1 / Math.max(sw, 1); out.x = sx * k; out.y = sy * k; }
    return out;
  };

  const P = [], F = [], Y = [], I = [];
  const addVertex = (e, n, z, fe, fn, from, to) => { P.push(e, n, z); F.push(fe, fn); Y.push(from, to); return P.length / 3 - 1; };

  // ---- polygons
  for (const poly of polys) {
    const X = [], Yc = [], tris = [], seen = new Map();
    const vert = ([e, n]) => {                                 // shared vertices (merged to a millimetre)
      const key = Math.round(e * 1000) + '_' + Math.round(n * 1000);
      let k = seen.get(key);
      if (k === undefined) { k = X.length; X.push(e); Yc.push(n); seen.set(key, k); }
      return k;
    };
    tessellatePolygon(poly.rings, maxEdge, triangulate, (a, b, c) => tris.push(vert(a), vert(b), vert(c)));
    if (!tris.length) continue;
    // heights: lowest nearby ground; small closed waters (ponds, lochs) are made dead flat
    const h = new Float32Array(X.length);
    for (let i = 0; i < X.length; i++) { const v = lowAt(X[i], Yc[i]); h[i] = Number.isFinite(v) ? v : 0; }
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [e, n] of poly.rings[0]) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
    if (Math.hypot(maxE - minE, maxN - minN) < 500) {
      const sorted = Array.from(h).sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      h.fill(med);
    }
    const base = P.length / 3;
    for (let i = 0; i < X.length; i++) {
      const fl = flowAt(X[i], Yc[i], poly.from, poly.to);
      addVertex(X[i], Yc[i], h[i], fl.x, fl.y, poly.from, poly.to);
    }
    for (let i = 0; i < tris.length; i++) I.push(base + tris[i]);
  }

  // ---- ribbons for the waterway lines (skipping stretches already covered by a water polygon)
  const covered = (e, n, from, to) => {
    for (const poly of polys) {
      if (poly.from > from || poly.to < to) continue;
      if (e < poly.minE || e > poly.maxE || n < poly.minN || n > poly.maxN) continue;
      if (polygonContains(poly.rings, e, n)) return true;
    }
    return false;
  };
  for (const poly of polys) {
    poly.minE = Infinity; poly.maxE = -Infinity; poly.minN = Infinity; poly.maxN = -Infinity;
    for (const [e, n] of poly.rings[0]) { poly.minE = Math.min(poly.minE, e); poly.maxE = Math.max(poly.maxE, e); poly.minN = Math.min(poly.minN, n); poly.maxN = Math.max(poly.maxN, n); }
  }
  const STEP = 10;
  for (const ln of lines) {
    // resample the line every ~STEP metres
    const pts = ln.pts, s = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / STEP));
      for (let k = 1; k <= n; k++) s.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
    }
    if (s.length < 2) continue;
    let hs = s.map(([e, n]) => { const v = lowAt(e, n); return Number.isFinite(v) ? v : 0; });
    for (let pass = 0; pass < 2; pass++) hs = hs.map((v, i) => (hs[Math.max(0, i - 1)] + v * 2 + hs[Math.min(hs.length - 1, i + 1)]) / 4);
    const half = ln.cls.width / 2, base = P.length / 3, hidden = [];
    for (let i = 0; i < s.length; i++) {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const nx = -ty * half, ny = tx * half, fe = tx * ln.cls.speed * sgn, fn = ty * ln.cls.speed * sgn;
      addVertex(s[i][0] - nx, s[i][1] - ny, hs[i], fe, fn, ln.from, ln.to);
      addVertex(s[i][0] + nx, s[i][1] + ny, hs[i], fe, fn, ln.from, ln.to);
      hidden.push(covered(s[i][0], s[i][1], ln.from, ln.to));
    }
    for (let i = 0; i + 1 < s.length; i++) {
      if (hidden[i] && hidden[i + 1]) continue;
      const v = base + i * 2;
      I.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }

  if (!I.length) return null;
  return { position: new Float32Array(P), flow: new Float32Array(F), years: new Float32Array(Y),
           index: new Uint32Array(I), vertexCount: P.length / 3, triangleCount: I.length / 3 };
}

// ---------------------------------------------------------------------------------------------
// Transport: railway, roads, tracks and trails as low-poly 3D ribbons that follow the terrain.
//
// Built at runtime from roads.geojson with the same height field as the trees and water, so every
// vertex sits on the ground (a pre-built GLB per feature is one rigid model and cannot follow a hillside,
// and hundreds of GLBs mean hundreds of render calls per frame). A whole network is a few typed arrays,
// split into map-cell chunks, drawn with one material. Dates and surfaces are shader uniforms/attributes.
//
// Surfaces change over time (see TRANSPORT.schedule): dirt and mud -> cobbles -> tarmac. Each vertex
// carries the two years at which its road changes surface, so the year slider needs no rebuild.
//
// Railway dimensions are the ones from build_transport_meshes.py. Sleepers are drawn as a pattern on the
// ballast rather than as thousands of boxes; rails are slightly wider than real (RAIL_VISUAL_WIDTH) so
// they do not shimmer away to nothing at map scale.

export const TRANSPORT = {
  // width in metres, lift = extra height so that where two roads overlap the bigger one wins (no z-fighting)
  classes: {
    major: { id: 0, width: 6.5, lift: 0.24, skirt: 0.6 },
    minor: { id: 1, width: 4.5, lift: 0.16, skirt: 0.5 },
    track: { id: 2, width: 3.0, lift: 0.08, skirt: 0.4 },
    trail: { id: 3, width: 1.4, lift: 0.00, skirt: 0.3 },
  },
  // Year each surface starts, per class: before `cobble` it is dirt and mud; from `tarmac` it is tarmac.
  // Infinity = never. (Wade's military roads arrive in the 1730s-50s; tarmac spreads in the 1920s-30s.)
  schedule: {
    major: { cobble: 1750, tarmac: 1925 },
    minor: { cobble: 1800, tarmac: 1940 },
    track: { cobble: Infinity, tarmac: Infinity },
    trail: { cobble: Infinity, tarmac: Infinity },
  },
  rail: { id: 4, gauge: 1.435, ballastBottom: 3.0, ballastTop: 2.6, ballastHeight: 0.20,
          sleeperHeight: 0.14, railHeight: 0.14, railVisualWidth: 0.18, lift: 0.10 },
  tolerance: 3.5,        // metres either side that the ground is checked (see tolerantHeight)
};

const CLASS_ALIASES = {
  major: 'major', primary: 'major', trunk: 'major', secondary: 'major', motorway: 'major',
  minor: 'minor', tertiary: 'minor', residential: 'minor', unclassified: 'minor', service: 'minor', street: 'minor', lane: 'minor', road: 'minor',
  track: 'track', farm: 'track',
  trail: 'trail', path: 'trail', footway: 'trail', bridleway: 'trail', cycleway: 'trail', steps: 'trail', pedestrian: 'trail',
};
// A road's modern surface caps how far its history can go: 0 stays dirt, 1 stops at cobbles, 2 = tarmac.
const SURFACE_CAP = {
  unpaved: 0, dirt: 0, ground: 0, earth: 0, mud: 0, grass: 0, gravel: 0, fine_gravel: 0, compacted: 0, sand: 0,
  cobblestone: 1, cobbles: 1, sett: 1, unhewn_cobblestone: 1, paving_stones: 1,
  asphalt: 2, paved: 2, concrete: 2, tarmac: 2, bitumen: 2, chipseal: 2,
};

// 'rail' | 'major' | 'minor' | 'track' | 'trail' | null for a roads.geojson feature's properties.
export function transportClass(p) {
  const kind = String(p.kind ?? p.road_type ?? '').toLowerCase();
  const cls = String(p.cls ?? p.road_class ?? '').toLowerCase();
  if (kind === 'rail' || kind === 'railway') return 'rail';
  if (kind === 'track' || kind === 'trail' || kind === 'path' || kind === 'footway') return CLASS_ALIASES[kind];
  if (kind === 'road') return CLASS_ALIASES[cls] || 'minor';
  return null;
}

// Years at which a road becomes cobbled / tarmac (99999 = never), honouring an explicit modern surface.
export function surfaceSchedule(cls, props = {}) {
  const base = TRANSPORT.schedule[cls] || TRANSPORT.schedule.track;
  let cobble = base.cobble, tarmac = base.tarmac;
  const cap = SURFACE_CAP[String(props.surface ?? '').toLowerCase().replace(/[\s-]+/g, '_')];
  if (cap === 0) { cobble = Infinity; tarmac = Infinity; } else if (cap === 1) tarmac = Infinity;
  const y = v => Number.isFinite(v) ? v : NO_TO;
  return [y(cobble), y(tarmac)];
}

// Is a point inside any water polygon? Used to carry roads across rivers as a level deck instead of
// letting them dive into the valley (the terrain model has no bridges).
export function makeWaterTest(features, frame, box) {
  const polys = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p.kind !== 'water' || !f.geometry) continue;
    const g = clipGeometryToBox(f.geometry, box);
    if (!g) continue;
    for (const rings of polygonsOf(g)) {
      const local = rings.map(r => r.slice(0, -1).map(([lo, la]) => frame.toLocal(lo, la)));
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const [x, y] of local[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
      polys.push({ rings: local, bb: [w, s, e, n] });
    }
  }
  return (x, y) => {
    for (const p of polys) if (x >= p.bb[0] && x <= p.bb[2] && y >= p.bb[1] && y <= p.bb[3] && polygonContains(p.rings, x, y)) return true;
    return false;
  };
}

const resampleRun = (pts, step) => {
  const out = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 1; j <= k; j++) out.push([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k]);
  }
  return out;
};
const smoothAlong = (a, passes) => {
  let cur = Array.from(a);
  for (let p = 0; p < passes; p++) {
    const nxt = new Array(cur.length);
    for (let i = 0; i < cur.length; i++) nxt[i] = (cur[Math.max(0, i - 1)] + 2 * cur[i] + cur[Math.min(cur.length - 1, i + 1)]) / 4;
    cur = nxt;
  }
  return cur;
};

// features: roads.geojson features. Options: frame, box ([W,S,E,N] degrees), heightAt(e,n), waterTest(e,n),
// step (max metres between cross-sections). Returns typed arrays (all per vertex) or null:
//   position(3) normal(3) uv(2: metres along, -1..1 across) info(4: material, class, width m, -)
//   sched(4: cobble year, tarmac year, from year, to year) and a Uint32Array index.
// Materials: 0 road surface, 1 ballast top, 2 rail, 3 verge/skirt, 4 ballast slope.
export function buildTransport(features, { frame, box, heightAt, waterTest = null, step = 3 }) {
  const T = TRANSPORT, tol = T.tolerance;
  const P = [], UV = [], INFO = [], SCHED = [], I = [];
  const stats = { features: 0, runs: 0, length: 0, bridges: 0, byClass: { rail: 0, major: 0, minor: 0, track: 0, trail: 0 } };

  for (const f of features) {
    const p = f.properties || {}, g = f.geometry;
    const cls = transportClass(p);
    if (!cls || !g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const from = yearOr(p.from_year, NO_FROM), to = yearOr(p.to_year, NO_TO);
    const [yCobble, yTarmac] = cls === 'rail' ? [NO_TO, NO_TO] : surfaceSchedule(cls, p);
    const C = T.classes[cls];
    stats.features++;

    for (const part of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
      for (const run of clipLineToBox(part, box)) {
        if (run.length < 2) continue;
        const pts = resampleRun(run.map(([lo, la]) => frame.toLocal(lo, la)), step);
        const S = pts.length;
        if (S < 2) continue;

        // ---- frames: mitred tangent, across vector (to the right), distance along
        const tx = new Float64Array(S), ty = new Float64Array(S), u = new Float64Array(S);
        for (let i = 0; i < S; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(S - 1, i + 1)];
          let dx = b[0] - a[0], dy = b[1] - a[1];
          const l = Math.hypot(dx, dy) || 1;
          tx[i] = dx / l; ty[i] = dy / l;
          if (i) u[i] = u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        }
        if (u[S - 1] < 0.5) continue;
        stats.runs++; stats.length += u[S - 1]; stats.byClass[cls]++;
        const ax = i => ty[i], ay = i => -tx[i];

        // ---- ground height under rows at lateral offsets; bridges carry the road level across water
        const flags = waterTest ? pts.map(([e, n]) => waterTest(e, n)) : null;
        const rowHeights = off => {
          const raw = pts.map(([e, n], i) => tolerantHeight(heightAt, e + ax(i) * off, n + ay(i) * off, 1, tol)).map(v => Number.isFinite(v) ? v : 0);
          if (flags) {
            for (let i = 0; i < S; i++) {
              if (!flags[i]) continue;
              let j = i; while (j < S && flags[j]) j++;                // flags[i..j-1] are over water
              const len = u[Math.min(j, S) - 1] - u[i];
              if (i > 0 && j < S && len < 300) {
                const h0 = raw[i - 1], h1 = raw[j], span = u[j] - u[i - 1];
                for (let k = i; k < j; k++) raw[k] = h0 + (h1 - h0) * (u[k] - u[i - 1]) / span + 0.25;
                if (off === 0) stats.bridges++;
              }
              i = j;
            }
          }
          return raw;
        };
        const settle = (raw, passes, slack) => smoothAlong(raw, passes).map((v, i) => Math.max(v, raw[i] - slack));   // never sinks below the ground

        // ---- emit a strip of quads between consecutive rows. ref = [across, up] says which way the
        // front face should point so triangles wind correctly whatever the line's direction.
        const strip = (rows, vs, mat, ref) => {
          const base = P.length / 3;
          for (const row of rows) for (let i = 0; i < S; i++) {
            P.push(pts[i][0] + ax(i) * row.off, pts[i][1] + ay(i) * row.off, row.z[i]);
          }
          rows.forEach((row, r) => { for (let i = 0; i < S; i++) {
            UV.push(u[i], vs[r]); INFO.push(mat, cls === 'rail' ? T.rail.id : C.id, row.width ?? 1, 0);
            SCHED.push(yCobble, yTarmac, from, to);
          } });
          for (let r = 0; r + 1 < rows.length; r++) for (let i = 0; i + 1 < S; i++) {
            const a = base + r * S + i, b = a + 1, c = base + (r + 1) * S + i, d = c + 1;
            for (const tri of [[a, b, d], [a, d, c]]) {
              const [i0, i1, i2] = tri.map(v => v * 3);
              const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
              const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
              const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
              const dot = nx * ax(i) * ref[0] + ny * ay(i) * ref[0] + nz * ref[1];
              if (dot >= 0) I.push(tri[0], tri[1], tri[2]); else I.push(tri[0], tri[2], tri[1]);
            }
          }
        };

        

        if (cls !== 'rail') {
          const w = C.width, lift = 0.06 + C.lift;
          const zL = settle(rowHeights(-w / 2), 2, 0.2).map(v => v + lift);
          const zC = settle(rowHeights(0), 2, 0.2).map(v => v + lift);
          const zR = settle(rowHeights(w / 2), 2, 0.2).map(v => v + lift);
          strip([{ off: -w / 2, z: zL, width: w }, { off: 0, z: zC, width: w }, { off: w / 2, z: zR, width: w }], [-1, 0, 1], 0, [0, 1]);
          // skirts: a short wall down each edge, so a gap at the edge never shows daylight from a low angle
          const sk = C.skirt;
          strip([{ off: -w / 2, z: zL, width: w }, { off: -w / 2 - 0.05, z: zL.map(v => v - sk), width: w }], [-1, -1], 3, [-1, 0]);
          strip([{ off: w / 2, z: zR, width: w }, { off: w / 2 + 0.05, z: zR.map(v => v - sk), width: w }], [1, 1], 3, [1, 0]);
        } else {
          const R = T.rail, bh = R.ballastHeight, top = settle(rowHeights(0), 5, 0.3).map(v => v + R.lift);
          const edgeL = settle(rowHeights(-R.ballastBottom / 2), 3, 0.3), edgeR = settle(rowHeights(R.ballastBottom / 2), 3, 0.3);
          const topZ = top.map(v => v + bh);
          // the ballast bed: flat across the top, sloping down to the ground on each side
          const toeL = edgeL.map((v, i) => Math.min(v, topZ[i] - 0.04)), toeR = edgeR.map((v, i) => Math.min(v, topZ[i] - 0.04));
          const bw = R.ballastTop;
          strip([{ off: -R.ballastBottom / 2, z: toeL }, { off: -bw / 2, z: topZ }], [-1, -1], 4, [-1, 1]);
          strip([{ off: -bw / 2, z: topZ, width: bw }, { off: bw / 2, z: topZ, width: bw }], [-1, 1], 1, [0, 1]);
          strip([{ off: bw / 2, z: topZ }, { off: R.ballastBottom / 2, z: toeR }], [1, 1], 4, [1, 1]);
          // the two rails: a raised strip each (top and both sides)
          const railTop = topZ.map(v => v + R.sleeperHeight + R.railHeight), railFoot = topZ;
          for (const side of [-1, 1]) {
            const c = side * R.gauge / 2, hw = R.railVisualWidth / 2;
            strip([{ off: c - hw, z: railTop }, { off: c + hw, z: railTop }], [0, 0], 2, [0, 1]);
            strip([{ off: c - hw, z: railFoot }, { off: c - hw, z: railTop }], [0, 0], 2, [-1, 0]);
            strip([{ off: c + hw, z: railFoot }, { off: c + hw, z: railTop }], [0, 0], 2, [1, 0]);
          }
        }
      }
    }
  }
  if (!I.length) return null;

  // vertex normals from the triangles
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
  }
  for (let k = 0; k < N.length; k += 3) {
    const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1;
    N[k] /= l; N[k + 1] /= l; N[k + 2] /= l;
  }
  return { position: new Float32Array(P), normal: N, uv: new Float32Array(UV), info: new Float32Array(INFO),
           sched: new Float32Array(SCHED), index: new Uint32Array(I), vertexCount: P.length / 3, triangleCount: I.length / 3, stats };
}

// Corridors where trees must not grow: every road/rail line, widened by half its width plus a margin.
// Returns (lon, lat) -> null, or the [from, to] year ranges during which that spot is occupied by a road.
export function makeCorridors(features, box, marginM = 2.5) {
  const lat0 = (box[1] + box[3]) / 2, mLon = M_PER_DEG_LON_EQ * Math.cos(lat0 * Math.PI / 180), mLat = M_PER_DEG_LAT;
  const CELL = 40, cells = new Map(), key = (i, j) => (i + 8192) * 16384 + (j + 8192);
  for (const f of features) {
    const p = f.properties || {}, g = f.geometry, cls = transportClass(p);
    if (!cls || !g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const r = (cls === 'rail' ? TRANSPORT.rail.ballastBottom : TRANSPORT.classes[cls].width) / 2 + marginM;
    const from = yearOr(p.from_year, NO_FROM), to = yearOr(p.to_year, NO_TO);
    for (const part of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
      for (let i = 0; i + 1 < part.length; i++) {
        const seg = { x0: part[i][0] * mLon, y0: part[i][1] * mLat, x1: part[i + 1][0] * mLon, y1: part[i + 1][1] * mLat, r, from, to };
        const lenSq = (seg.x1 - seg.x0) ** 2 + (seg.y1 - seg.y0) ** 2;
        if (lenSq < 1e-12) continue;
        seg.lenSq = lenSq;
        for (let ci = Math.floor((Math.min(seg.x0, seg.x1) - r) / CELL); ci <= Math.floor((Math.max(seg.x0, seg.x1) + r) / CELL); ci++)
          for (let cj = Math.floor((Math.min(seg.y0, seg.y1) - r) / CELL); cj <= Math.floor((Math.max(seg.y0, seg.y1) + r) / CELL); cj++) {
            const k = key(ci, cj);
            let list = cells.get(k);
            if (!list) cells.set(k, list = []);
            list.push(seg);
          }
      }
    }
  }
  return (lon, lat) => {
    const x = lon * mLon, y = lat * mLat, list = cells.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!list) return null;
    let out = null;
    for (const s of list) {
      const t = Math.max(0, Math.min(1, ((x - s.x0) * (s.x1 - s.x0) + (y - s.y0) * (s.y1 - s.y0)) / s.lenSq));
      const dx = x - (s.x0 + t * (s.x1 - s.x0)), dy = y - (s.y0 + t * (s.y1 - s.y0));
      if (dx * dx + dy * dy <= s.r * s.r) (out ||= []).push([s.from, s.to]);
    }
    return out;
  };
}

// The parts of [from, to] (years, inclusive) not covered by any of `blocks` ([[from,to],...], inclusive).
export function subtractYears(from, to, blocks) {
  const pieces = [];
  let cursor = from;
  for (const [a, b] of [...blocks].sort((p, q) => p[0] - q[0])) {
    if (b < cursor || a > to) continue;
    if (a > cursor) pieces.push([cursor, a - 1]);
    cursor = Math.max(cursor, b + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) pieces.push([cursor, to]);
  return pieces;
}

// Split a triangle list into square map cells so off-screen cells can be skipped. Chunks share the same
// vertex buffers (only their index differs). Returns [{ index: Uint32Array, bounds: [minE,minN,minZ,maxE,maxN,maxZ] }].
export function chunkTriangles(position, index, cell = 300) {
  let minE = Infinity, minN = Infinity;
  for (let i = 0; i < position.length; i += 3) { if (position[i] < minE) minE = position[i]; if (position[i + 1] < minN) minN = position[i + 1]; }
  const groups = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const cx = (position[a] + position[b] + position[c]) / 3, cy = (position[a + 1] + position[b + 1] + position[c + 1]) / 3;
    const key = Math.floor((cx - minE) / cell) * 4096 + Math.floor((cy - minN) / cell);
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(index[t], index[t + 1], index[t + 2]);
  }
  const out = [];
  for (const g of groups.values()) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of g) {
      const k = v * 3;
      for (let d = 0; d < 3; d++) { if (position[k + d] < b[d]) b[d] = position[k + d]; if (position[k + d] > b[d + 3]) b[d + 3] = position[k + d]; }
    }
    out.push({ index: Uint32Array.from(g), bounds: b });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mountain mist: puffs of soft haze lying above the high ground. heightAt(e, n) -> metres.
// Returns flat Float32Arrays (4 floats per puff):
//   P = east, north, z, phase     S = half-width, half-height, rotation, 0     V = drift east, north, up, 0
export function planMist({ bounds, heightAt, minElevation, maxPuffs = 400, spacing = 145 }) {
  const [minE, minN, maxE, maxN] = bounds, EDGE = 90;
  const cand = [];
  for (let n = minN + spacing / 2; n < maxN; n += spacing)
    for (let e = minE + spacing / 2; e < maxE; e += spacing) {
      const z = heightAt(e, n);
      if (Number.isFinite(z) && z >= minElevation) cand.push([e, n, z]);
    }
  if (!cand.length) return null;
  // deterministic generator: the mist stays in roughly the same places as the slider moves
  let seed = (cand.length * 9301 + minElevation * 49297) >>> 0;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const banks = cand.slice(0, Math.min(100, Math.max(1, Math.ceil(cand.length * 0.68))));
  const P = [], S = [], V = [];
  outer:
  for (const [e, n] of banks) {
    const puffs = 5 + Math.floor(random() * 4);
    for (let i = 0; i < puffs; i++) {
      if (P.length / 4 >= maxPuffs) break outer;
      const pe = e + (random() - 0.5) * 150, pn = n + (random() - 0.5) * 110;
      if (pe < minE + EDGE || pe > maxE - EDGE || pn < minN + EDGE || pn > maxN - EDGE) continue;   // keep haze off the edge
      const g = heightAt(pe, pn), lift = 18 + random() * 38;
      P.push(pe, pn, (Number.isFinite(g) ? g : 0) + lift, random() * TAU);
      S.push(75 + random() * 100, 45 + random() * 65, random() * Math.PI, 0);
      V.push(5 + random() * 12, (random() - 0.5) * 10, (random() - 0.5) * 3, 0);
    }
  }
  return { P: new Float32Array(P), S: new Float32Array(S), V: new Float32Array(V), count: P.length / 4, candidates: cand.length, banks: banks.length };
}

// ---------------------------------------------------------------------------------------------
// Picking 3D models with a ray. `items` have {scene, visible}; `matrixOf(item)` returns the
// THREE.Matrix4 mapping that item's model space to map (mercator) space. `proj` is the map's
// projection matrix. Returns the nearest hit item or null. THREE is passed in to keep this file
// free of imports.
export function pickModelHit(THREE, items, proj, matrixOf, ndcX, ndcY) {
  const rc = new THREE.Raycaster();
  let best = null;
  for (const it of items) {
    if (!it.visible) continue;
    const mvp = proj.clone().multiply(matrixOf(it));
    const inv = mvp.clone().invert();
    const near = new THREE.Vector3(ndcX, ndcY, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(ndcX, ndcY, 1).applyMatrix4(inv);
    rc.ray.origin.copy(near);
    rc.ray.direction.copy(far).sub(near).normalize();
    const hit = rc.intersectObject(it.scene, true)[0];
    if (!hit) continue;
    const depth = hit.point.clone().applyMatrix4(mvp).z;   // clip-space depth, comparable across models
    if (!best || depth < best.depth) best = { item: it, depth };
  }
  return best && best.item;
}