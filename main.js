import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* Sample fixture                                                      */
/* ------------------------------------------------------------------ */
const MATCH = { home: 'Redvale City', away: 'Harbour Town', ground: 'Redvale Park', when: 'Sat 28 Nov, 20:00' };
const FEE = 1.75;
const MAX_SEATS = 8;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, like most grounds
const money = (v) => '£' + (Number.isInteger(v) ? v : v.toFixed(2));

/* ------------------------------------------------------------------ */
/* Bowl layout: the stands are offsets of a rounded rectangle.         */
/* A point is (segment, t along it, rho = distance out from the core). */
/* ------------------------------------------------------------------ */
const AX = 49, AZ = 30, R0 = 11;
const HALF = Math.PI / 2;
const SEGS = [
  { kind: 'side', stand: 'Main Stand', a: [-AX, AZ], b: [AX, AZ], n: [0, 1], sections: 5, gate: 1 },
  { kind: 'corner', stand: 'Canal corner', c: [AX, AZ], th0: HALF, th1: 0, sections: 2, gate: 5 },
  { kind: 'side', stand: 'Canal End', a: [AX, AZ], b: [AX, -AZ], n: [1, 0], sections: 3, gate: 6 },
  { kind: 'corner', stand: 'Riverside corner', c: [AX, -AZ], th0: 0, th1: -HALF, sections: 2, gate: 8 },
  { kind: 'side', stand: 'Riverside Stand', a: [AX, -AZ], b: [-AX, -AZ], n: [0, -1], sections: 5, gate: 9 },
  { kind: 'corner', stand: 'Station corner', c: [-AX, -AZ], th0: -HALF, th1: -Math.PI, sections: 2, gate: 13 },
  { kind: 'side', stand: 'Station End', a: [-AX, -AZ], b: [-AX, AZ], n: [-1, 0], sections: 3, gate: 14 },
  { kind: 'corner', stand: 'Main corner', c: [-AX, AZ], th0: -Math.PI, th1: -3 * HALF, sections: 2, gate: 16 },
];
const TIERS = {
  lower: { key: 'lower', name: 'Lower tier', rows: 18, d0: 0, rd: 0.85, h0: 1.1, rh: 0.42 },
  club: { key: 'club', name: 'Club boxes', rows: 2, d0: 15.5, rd: 0.9, h0: 9.4, rh: 0.5 },
  upper: { key: 'upper', name: 'Upper tier', rows: 20, d0: 16.8, rd: 0.9, h0: 13.8, rh: 0.55 },
};

function segPoint(seg, t, rho) {
  if (seg.kind === 'side') {
    const x = seg.a[0] + (seg.b[0] - seg.a[0]) * t, z = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
    return { x: x + seg.n[0] * rho, z: z + seg.n[1] * rho, nx: seg.n[0], nz: seg.n[1] };
  }
  const th = seg.th0 + (seg.th1 - seg.th0) * t, nx = Math.cos(th), nz = Math.sin(th);
  return { x: seg.c[0] + nx * rho, z: seg.c[1] + nz * rho, nx, nz };
}
function segLen(seg, rho) {
  return seg.kind === 'side' ? Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) : Math.abs(seg.th1 - seg.th0) * rho;
}
function loopSamples(steps = 24) {
  const out = [];
  SEGS.forEach((seg, k) => { const n = seg.kind === 'side' ? 1 : steps; for (let i = 0; i <= n; i++) out.push({ seg: k, t: i / n }); });
  return out;
}
function rangeSamples(k, t0, t1, steps = 24) {
  const n = SEGS[k].kind === 'side' ? 1 : Math.max(2, Math.ceil(steps * (t1 - t0)));
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ seg: k, t: t0 + (t1 - t0) * i / n });
  return out;
}
/* Sweep a 2D profile [[d, height], ...] along the bowl outline. */
function sweep(profile, samples, opt = {}) {
  const P = profile.length, S = samples.length;
  const pos = new Float32Array(P * S * 3), uv = new Float32Array(P * S * 2);
  const vs = [0];
  for (let j = 1; j < P; j++) vs[j] = vs[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]);
  const vt = vs[P - 1] || 1;
  const ref = opt.uRho ?? profile[0][0];
  const us = [0];
  let prev = segPoint(SEGS[samples[0].seg], samples[0].t, R0 + ref);
  for (let i = 1; i < S; i++) {
    const p = segPoint(SEGS[samples[i].seg], samples[i].t, R0 + ref);
    us[i] = us[i - 1] + Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  const unit = opt.uUnit ? us[S - 1] / Math.max(1, Math.round(us[S - 1] / opt.uUnit)) : 1;
  for (let i = 0; i < S; i++) {
    const seg = SEGS[samples[i].seg];
    for (let j = 0; j < P; j++) {
      const p = segPoint(seg, samples[i].t, R0 + profile[j][0]), k = i * P + j;
      pos[k * 3] = p.x; pos[k * 3 + 1] = profile[j][1]; pos[k * 3 + 2] = p.z;
      uv[k * 2] = (opt.flipU ? -1 : 1) * us[i] / unit; uv[k * 2 + 1] = vs[j] / vt;
    }
  }
  const idx = [];
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < P - 1; j++) {
    const a = i * P + j, b = a + P;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */
const canvas = $('#scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (err) {
  $('#loader p').textContent = 'This seat map needs WebGL, which this browser has turned off.';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#07050a');
scene.fog = new THREE.Fog('#07050a', 380, 1100);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 2500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;

const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

scene.add(new THREE.HemisphereLight('#ffe1ea', '#1a0710', 1.1));
const key = new THREE.DirectionalLight('#ffffff', 2.1);
key.position.set(40, 120, 70);
scene.add(key);
const rim = new THREE.DirectionalLight('#ff9ab8', 0.9);
rim.position.set(-90, 80, -60);
scene.add(rim);

const M = {
  concrete: new THREE.MeshStandardMaterial({ color: '#3a3035', roughness: 0.92, flatShading: true, side: THREE.DoubleSide }),
  seat: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: '#ffb3c6', roughness: 0.1, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  roof: new THREE.MeshStandardMaterial({ color: '#1d151b', roughness: 0.8, transparent: true, side: THREE.DoubleSide }),
  girder: new THREE.MeshStandardMaterial({ color: '#4a3e46', roughness: 0.6, transparent: true }),
  strip: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.3, 1.7, 1.95), side: THREE.DoubleSide }),
  ring: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 1.0, 1.12), side: THREE.DoubleSide }),
  boxGlow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.05, 0.12), side: THREE.DoubleSide }),
  boxCeil: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.45, 0.5), side: THREE.DoubleSide }),
  white: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.3, roughness: 0.4 }),
  net: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
  ground: new THREE.MeshStandardMaterial({ color: '#0d0a0c', roughness: 1 }),
  boardBack: new THREE.MeshStandardMaterial({ color: '#1a1216', roughness: 0.9, side: THREE.FrontSide }),
};
const maxAniso = renderer.capabilities.getMaxAnisotropy();

/* ------------------------------------------------------------------ */
/* Canvas textures: pitch markings and LED ribbon boards               */
/* ------------------------------------------------------------------ */
try { await Promise.race([document.fonts.load('800 64px Archivo'), new Promise((r) => setTimeout(r, 2500))]); } catch { /* fallback font */ }

function pitchTexture() {
  const W = 120, H = 82, S = 16;
  const c = document.createElement('canvas');
  c.width = W * S; c.height = H * S;
  const x = c.getContext('2d');
  const X = (m) => (m + W / 2) * S, Y = (m) => (m + H / 2) * S;
  x.fillStyle = '#1c5c2a'; x.fillRect(0, 0, c.width, c.height);
  const n = 20;
  for (let i = 0; i < n; i++) { x.fillStyle = i % 2 ? '#2f9442' : '#268238'; x.fillRect(X(-52.5 + i * 105 / n), Y(-34), 105 / n * S + 1, 68 * S); }
  x.strokeStyle = 'rgba(255,255,255,.92)'; x.fillStyle = 'rgba(255,255,255,.92)'; x.lineWidth = 0.16 * S;
  const box = (x0, z0, x1, z1) => x.strokeRect(X(Math.min(x0, x1)), Y(Math.min(z0, z1)), Math.abs(x1 - x0) * S, Math.abs(z1 - z0) * S);
  const arc = (cx, cz, r, a0, a1) => { x.beginPath(); x.arc(X(cx), Y(cz), r * S, a0, a1); x.stroke(); };
  const spot = (cx, cz) => { x.beginPath(); x.arc(X(cx), Y(cz), 0.25 * S, 0, 7); x.fill(); };
  box(-52.5, -34, 52.5, 34);
  x.beginPath(); x.moveTo(X(0), Y(-34)); x.lineTo(X(0), Y(34)); x.stroke();
  arc(0, 0, 9.15, 0, 7); spot(0, 0);
  for (const sg of [-1, 1]) {
    const gx = sg * 52.5;
    box(gx, -20.16, gx - sg * 16.5, 20.16);
    box(gx, -9.16, gx - sg * 5.5, 9.16);
    spot(gx - sg * 11, 0);
    const a = Math.acos(5.5 / 9.15);
    if (sg > 0) arc(gx - 11, 0, 9.15, Math.PI - a, Math.PI + a); else arc(gx + 11, 0, 9.15, -a, a);
  }
  x.save(); x.beginPath(); x.rect(X(-52.5), Y(-34), 105 * S, 68 * S); x.clip();
  for (const [cx, cz] of [[-52.5, -34], [52.5, -34], [-52.5, 34], [52.5, 34]]) arc(cx, cz, 1, 0, 7);
  x.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  return t;
}

const leds = [];
function ledTexture(chunks, bg = '#08040a', speed = 0.035) {
  const H = 128, GAP = 44;
  const c = document.createElement('canvas'), x = c.getContext('2d');
  const font = (w) => { x.font = `${w} 74px Archivo, "Arial Black", Arial, sans-serif`; try { x.fontStretch = 'expanded'; } catch { /* older canvas */ } };
  const widths = chunks.map((ch) => { font(ch.w || 800); return x.measureText(ch.t).width; });
  c.width = Math.ceil(widths.reduce((a, w) => a + w + GAP, 0)); c.height = H;
  x.fillStyle = bg; x.fillRect(0, 0, c.width, H);
  x.textBaseline = 'middle';
  let px = GAP / 2;
  chunks.forEach((ch, i) => { font(ch.w || 800); x.fillStyle = ch.c || '#ffffff'; x.fillText(ch.t, px, H / 2 + 5); px += widths[i] + GAP; });
  x.fillStyle = 'rgba(0,0,0,.36)';
  for (let y = 0; y < H; y += 4) x.fillRect(0, y, c.width, 1);
  for (let i = 0; i < c.width; i += 4) x.fillRect(i, 0, 1, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = maxAniso;
  const led = { tex, ratio: c.width / H, speed };
  leds.push(led);
  return led;
}
/* Sweep faces point away from the pitch, so the lit side of a board is its back face. */
function ribbon(d, y0, y1, led, tint = 1.15, freeStanding = false) {
  const g = sweep([[d, y0], [d, y1]], loopSamples(32), { uUnit: led.ratio * (y1 - y0), flipU: true });
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: led.tex, color: new THREE.Color(tint, tint, tint), side: THREE.BackSide })));
  if (freeStanding) scene.add(new THREE.Mesh(g, M.boardBack));
}

/* ------------------------------------------------------------------ */
/* Build the ground                                                    */
/* ------------------------------------------------------------------ */
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), M.ground);
ground.rotation.x = -HALF; ground.position.y = -0.5;
scene.add(ground);

const pitchTex = pitchTexture();
const pitch = new THREE.Mesh(new THREE.PlaneGeometry(120, 82), new THREE.MeshStandardMaterial({ map: pitchTex, emissive: '#ffffff', emissiveMap: pitchTex, emissiveIntensity: 0.26, roughness: 0.9 }));
pitch.rotation.x = -HALF;
scene.add(pitch);

function addGoal(sg) {
  const g = new THREE.Group();
  const post = new THREE.CylinderGeometry(0.07, 0.07, 2.44, 8);
  for (const z of [-3.66, 3.66]) { const m = new THREE.Mesh(post, M.white); m.position.set(0, 1.22, z); g.add(m); }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7.46, 8), M.white);
  bar.rotation.x = HALF; bar.position.y = 2.44; g.add(bar);
  const net = new THREE.Mesh(new THREE.BoxGeometry(2, 2.44, 7.32), M.net);
  net.position.set(sg, 1.22, 0); g.add(net);
  g.position.x = sg * 52.5;
  scene.add(g);
}
addGoal(-1); addGoal(1);

/* One profile for the whole bowl: lower tier, club level, upper tier, back wall. */
const TL = TIERS.lower, TU = TIERS.upper;
const bowlProfile = [[0, 0], [0, TL.h0]];
for (let i = 0; i < TL.rows; i++) { const y = TL.h0 + i * TL.rh; if (i) bowlProfile.push([i * TL.rd, y]); bowlProfile.push([(i + 1) * TL.rd, y]); }
const lowBack = TL.rows * TL.rd; // 15.3
bowlProfile.push([lowBack, 10.1], [lowBack + 0.2, 10.1], [lowBack + 0.2, 9.4], [16.4, 9.4], [16.4, 9.9], [23, 9.9], [23, 12.4], [16.8, 12.4], [16.8, 13.8]);
for (let i = 0; i < TU.rows; i++) { const y = TU.h0 + i * TU.rh; if (i) bowlProfile.push([TU.d0 + i * TU.rd, y]); bowlProfile.push([TU.d0 + (i + 1) * TU.rd, y]); }
const upBack = TU.d0 + TU.rows * TU.rd; // 34.8
bowlProfile.push([upBack, 26.4], [36.5, 26.4], [36.5, 0]);
scene.add(new THREE.Mesh(sweep(bowlProfile, loopSamples(24)), M.concrete));

/* Club boxes: glass fronts, glowing back walls, partitions. */
scene.add(new THREE.Mesh(sweep([[17.6, 9.9], [17.6, 12.4]], loopSamples(24)), M.glass));
scene.add(new THREE.Mesh(sweep([[22.95, 9.9], [22.95, 12.35]], loopSamples(24)), M.boxGlow));
scene.add(new THREE.Mesh(sweep([[17.7, 12.36], [22.9, 12.36]], loopSamples(24)), M.boxCeil));
const dummy = new THREE.Object3D();
{
  const spots = [];
  SEGS.forEach((seg) => { const n = Math.floor(segLen(seg, R0 + 20) / 5.2); for (let i = 1; i < n; i++) spots.push(segPoint(seg, i / n, R0 + 20.3)); });
  const parts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 2.5, 5.4), M.concrete, spots.length);
  spots.forEach((p, i) => { dummy.position.set(p.x, 11.15, p.z); dummy.rotation.set(0, Math.atan2(p.nx, p.nz), 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); parts.setMatrixAt(i, dummy.matrix); });
  scene.add(parts);
}

/* Roof (fades away when you look from above), girders and the light ring. */
const roofGroup = new THREE.Group();
roofGroup.add(new THREE.Mesh(sweep([[6, 30.6], [37.2, 27.2]], loopSamples(24)), M.roof));
{
  const ends = [];
  SEGS.forEach((seg) => { const n = Math.max(1, Math.round(segLen(seg, R0 + 30) / 8)); for (let i = 0; i < n; i++) ends.push([segPoint(seg, (i + 0.5) / n, R0 + 37), segPoint(seg, (i + 0.5) / n, R0 + 6.2)]); });
  const girders = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.6, 1), M.girder, ends.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  ends.forEach(([p0, p1], i) => {
    a.set(p0.x, 26.8, p0.z); b.set(p1.x, 30.2, p1.z);
    dummy.position.copy(a).add(b).multiplyScalar(0.5); dummy.scale.set(1, 1, a.distanceTo(b)); dummy.lookAt(b); dummy.updateMatrix();
    girders.setMatrixAt(i, dummy.matrix);
  });
  roofGroup.add(girders);
}
scene.add(roofGroup);
scene.add(new THREE.Mesh(sweep([[5.75, 30.66], [6.1, 30.66]], loopSamples(32)), M.ring));
scene.add(new THREE.Mesh(sweep([[6, 30.0], [6, 30.6]], loopSamples(32)), M.strip));

/* LED ribbons: pitch-side boards, the tier fascias and the back wall. */
const G = MATCH.ground.toUpperCase();
ribbon(-4.5, 0.05, 1.0, ledTexture([{ t: 'REDVALE CITY', w: 900 }, { t: 'v', w: 500 }, { t: 'HARBOUR TOWN', w: 900 }, { t: '•' }, { t: 'MATCHDAY AT ' + G, w: 700 }, { t: '•' }], '#b40f31', 0.06), 0.9, true);
ribbon(lowBack - 0.02, 9.2, 10.05, ledTexture([{ t: 'LOWER TIER', w: 900 }, { t: 'FROM £48', w: 600, c: '#ff9ab6' }, { t: '•', c: '#e0173f' }, { t: G, w: 900 }, { t: '•', c: '#e0173f' }]));
ribbon(16.78, 12.5, 13.7, ledTexture([{ t: 'CLUB BOXES', w: 900 }, { t: 'FROM £240', w: 600, c: '#ff9ab6' }, { t: '•', c: '#e0173f' }, { t: G, w: 900 }, { t: '•', c: '#e0173f' }], '#08040a', -0.03));
ribbon(upBack - 0.02, 24.55, 25.95, ledTexture([{ t: 'UPPER TIER', w: 900 }, { t: 'FROM £34', w: 600, c: '#ff9ab6' }, { t: '•', c: '#e0173f' }, { t: G, w: 900 }, { t: '•', c: '#e0173f' }]));

/* ------------------------------------------------------------------ */
/* Seats and sections                                                  */
/* ------------------------------------------------------------------ */
const seatGeo = (() => {
  const pan = new THREE.BoxGeometry(0.5, 0.08, 0.42); pan.translate(0, 0.42, 0.04);
  const back = new THREE.BoxGeometry(0.5, 0.5, 0.07); back.rotateX(-0.18); back.translate(0, 0.7, -0.17);
  return mergeGeometries([pan, back]);
})();
function seatMatrix(s, scale = 1, out = new THREE.Matrix4()) {
  dummy.position.set(s.x, s.y, s.z); dummy.rotation.set(0, Math.atan2(-s.nx, -s.nz), 0); dummy.scale.setScalar(scale); dummy.updateMatrix();
  return out.copy(dummy.matrix);
}

const state = { mode: 'overview', active: null, hover: null, filter: null, qty: 2, basket: [], viewSeat: null, touch: false };
const COL = {
  free: new THREE.Color('#d3173d'), taken: new THREE.Color('#40161f'), away: new THREE.Color('#4f4350'), mine: new THREE.Color('#ff8a2a'),
  dimFree: new THREE.Color('#3a0d17'), dimTaken: new THREE.Color('#1c0a0e'),
};
let seed = 20261128;
const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;

const sections = [], pickers = [], byId = new Map();
const pickBase = new THREE.MeshBasicMaterial({ color: '#ff7aa2', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

function paint(sec) {
  const dim = state.mode === 'section' ? sec !== state.active : state.mode === 'overview' && state.filter && state.filter !== sec.tier.key;
  let free = 0;
  sec.seats.forEach((s, i) => {
    if (s.status === 0) free++;
    const c = s.status === 2 ? COL.mine : sec.away ? (dim ? COL.dimTaken : COL.away) : s.status === 1 ? (dim ? COL.dimTaken : COL.taken) : (dim ? COL.dimFree : COL.free);
    sec.mesh.setColorAt(i, c);
  });
  sec.free = sec.away ? 0 : free;
  sec.mesh.instanceColor.needsUpdate = true;
}

function addSection(tier, k, q, id) {
  const seg = SEGS[k], t0 = q / seg.sections, t1 = (q + 1) / seg.sections;
  const centre = seg.sections === 5 ? [0, 1, 2, 1, 0][q] : -1;
  const side = seg.kind === 'side';
  const price = tier.key === 'lower' ? (centre >= 0 ? [52, 60, 72][centre] : side ? 50 : 48)
    : tier.key === 'upper' ? (centre >= 0 ? [38, 40, 46][centre] : side ? 36 : 34)
      : [240, 280, 320][centre];
  const sec = { id, tier, k, q, seg, stand: seg.stand, price, away: tier.key === 'upper' && k === 2, gate: seg.gate + (q % 2), rows: [], seats: [], glow: 0, free: 0 };
  for (let r = 0; r < tier.rows; r++) {
    const d = tier.d0 + r * tier.rd + 0.45, y = tier.h0 + r * tier.rh, rho = R0 + d;
    const L = segLen(seg, rho) * (t1 - t0), count = Math.floor((L - 1.2) / 0.68), start = (L - count * 0.68) / 2 + 0.34;
    const row = { letter: LETTERS[r], seats: [] };
    for (let i = 0; i < count; i++) {
      const p = segPoint(seg, t0 + (t1 - t0) * (start + i * 0.68) / L, rho);
      const s = { sec, r, num: i + 1, x: p.x, y, z: p.z, nx: p.nx, nz: p.nz, status: 0 };
      row.seats.push(s); sec.seats.push(s);
    }
    sec.rows.push(row);
  }
  const busy = 0.26 + (centre === 2 ? 0.22 : centre === 1 ? 0.12 : 0) + (tier.key === 'club' ? 0.12 : 0);
  for (const s of sec.seats) if (rnd() < busy + Math.sin(s.num * 0.42 + s.r * 1.37 + q * 2.3 + k) * 0.2) s.status = 1;

  const mesh = new THREE.InstancedMesh(seatGeo, M.seat, sec.seats.length);
  const mtx = new THREE.Matrix4();
  sec.seats.forEach((s, i) => mesh.setMatrixAt(i, seatMatrix(s, 1, mtx)));
  mesh.setColorAt(0, COL.free);
  mesh.computeBoundingSphere();
  sec.mesh = mesh; scene.add(mesh);

  const back = tier.h0 + (tier.rows - 1) * tier.rh;
  const pg = sweep([[tier.d0 + 0.05, tier.h0 + 1.0], [tier.d0 + tier.rows * tier.rd - 0.1, back + 1.0]], rangeSamples(k, t0 + 0.004, t1 - 0.004));
  const pk = new THREE.Mesh(pg, pickBase.clone());
  if (sec.away) pk.material.color.set('#9a90b0');
  pk.userData.sec = sec; pk.renderOrder = 2; pk.visible = false;
  sec.picker = pk; pickers.push(pk); scene.add(pk);

  const midRow = sec.rows[Math.floor(tier.rows / 2)], ms = midRow.seats[Math.floor(midRow.seats.length / 2)];
  sec.center = new THREE.Vector3(ms.x, ms.y, ms.z);
  sec.n = new THREE.Vector3(ms.nx, 0, ms.nz);
  sec.width = segLen(seg, R0 + tier.d0 + tier.rows * tier.rd / 2) * (t1 - t0);
  sections.push(sec); byId.set(id, sec);
  paint(sec);
}
{
  let lo = 101, up = 201, cl = 1;
  SEGS.forEach((seg, k) => { for (let q = 0; q < seg.sections; q++) addSection(TIERS.lower, k, q, String(lo++)); });
  SEGS.forEach((seg, k) => { if (seg.sections === 5) for (let q = 0; q < 5; q++) addSection(TIERS.club, k, q, 'C' + cl++); });
  SEGS.forEach((seg, k) => { for (let q = 0; q < seg.sections; q++) addSection(TIERS.upper, k, q, String(up++)); });
}
const seatName = (s) => `Row ${s.sec.rows[s.r].letter}, seat ${s.num}`;

/* Your seats glow orange; the hovered seat glows white. */
const glow = new THREE.InstancedMesh(seatGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.0, 0.25) }), MAX_SEATS);
glow.count = 0; glow.frustumCulled = false; scene.add(glow);
const hoverSeat = new THREE.Mesh(seatGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.0, 2.05) }));
hoverSeat.matrixAutoUpdate = false; hoverSeat.visible = false; scene.add(hoverSeat);
function refreshGlow() {
  const m = new THREE.Matrix4();
  state.basket.forEach((s, i) => glow.setMatrixAt(i, seatMatrix(s, 1.07, m)));
  glow.count = state.basket.length;
  glow.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Camera moves                                                        */
/* ------------------------------------------------------------------ */
let fly = null;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
function flyTo(pos, target, { dur = 1.6, fov = 40, after } = {}) {
  fly = { p0: camera.position.clone(), p1: pos, t0: controls.target.clone(), t1: target, f0: camera.fov, f1: fov, k: 0, dur: reduceMotion ? 0.01 : dur, after };
  controls.enabled = false;
}
function stepFly(dt) {
  if (!fly) return;
  fly.k = Math.min(1, fly.k + dt / fly.dur);
  const e = ease(fly.k);
  camera.position.lerpVectors(fly.p0, fly.p1, e);
  camera.position.y += Math.sin(Math.PI * e) * fly.p0.distanceTo(fly.p1) * 0.1;
  controls.target.lerpVectors(fly.t0, fly.t1, e);
  camera.fov = fly.f0 + (fly.f1 - fly.f0) * e;
  camera.updateProjectionMatrix();
  camera.lookAt(controls.target);
  if (fly.k >= 1) { const after = fly.after; fly = null; controls.enabled = true; controls.update(); if (after) after(); }
}
function limits(mode, far = 320) {
  Object.assign(controls, mode === 'overview'
    ? { minDistance: 60, maxDistance: Math.max(320, far * 1.3), minPolarAngle: 0, maxPolarAngle: 1.25, enableZoom: true, rotateSpeed: 0.6 }
    : mode === 'section'
      ? { minDistance: 8, maxDistance: 120, minPolarAngle: 0.2, maxPolarAngle: 1.5, enableZoom: true, rotateSpeed: 0.5 }
      : { minDistance: 0.6, maxDistance: 0.6, minPolarAngle: 0.35, maxPolarAngle: 2.6, enableZoom: false, rotateSpeed: -0.32 });
}

/* Keep the stadium centred in the part of the screen the panels leave free. */
const view = { ox: 0, oy: 0, tx: 0, ty: 0 };
function freeRect() {
  const W = innerWidth, H = innerHeight, desk = W >= 860;
  let l = 0, r = W, t = state.mode === 'seat' ? 0 : 64, b = H;
  for (const el of [$('#intro'), $('#sheet'), $('#seatbar')]) {
    if (el.hidden) continue;
    const R = el.getBoundingClientRect();
    if (el.id === 'seatbar') { if (!desk) b = Math.min(b, R.top); continue; }
    if (desk) { if (R.left < W / 2) l = Math.max(l, R.right); else r = Math.min(r, R.left); } else b = Math.min(b, R.top);
  }
  const bk = $('#basket');
  if (!bk.hidden && !desk) b = Math.min(b, bk.getBoundingClientRect().top);
  return { l, r, t, b, W, H };
}
function aimView() { const f = freeRect(); view.tx = (f.l + f.r) / 2 - f.W / 2; view.ty = (f.t + f.b) / 2 - f.H / 2; }
function overviewPose() {
  const f = freeRect(), tan = Math.tan(THREE.MathUtils.degToRad(40 / 2));
  const fw = f.r - f.l, fh = f.b - f.t, portrait = fw / fh < 0.95;
  const along = portrait ? 84 : 104, across = portrait ? 100 : 84;
  const D = Math.max(along / (tan * fw / f.H), across / (tan * fh / f.H));
  return { pos: new THREE.Vector3().setFromSphericalCoords(D, 0.42, portrait ? HALF : 0), target: new THREE.Vector3(), D };
}
function sectionPose(sec) {
  const f = freeRect(), tan = Math.tan(THREE.MathUtils.degToRad(21));
  const back = Math.max(30, sec.width * 0.55 / (tan * (f.r - f.l) / f.H), 11 / (tan * (f.b - f.t) / f.H));
  const c = sec.center, n = sec.n;
  return { pos: new THREE.Vector3(c.x - n.x * back, c.y + 7 + back * 0.08, c.z - n.z * back), target: new THREE.Vector3(c.x, c.y - 1.5, c.z) };
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */
function setHash(h) { try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch { /* sandboxed */ } }
let paintedMode = '';
function ui() {
  const m = state.mode;
  if (m !== paintedMode || m === 'section') { paintedMode = m; sections.forEach(paint); }
  $('#intro').hidden = m !== 'overview';
  $('#sheet').hidden = m !== 'section';
  $('#seatbar').hidden = m !== 'seat';
  renderBasket();
  setHover(null);
}
function toOverview() {
  state.mode = 'overview'; state.active = null; ui();
  const o = overviewPose(); limits('overview', o.D); aimView();
  flyTo(o.pos, o.target, { dur: 1.5, fov: 40 });
  setHash('');
}
function openSection(sec) {
  if (sec.away) { flash(`Section ${sec.id} is the away end, sold by ${MATCH.away}.`); return; }
  state.mode = 'section'; state.active = sec; ui(); renderSheet();
  const p = sectionPose(sec); limits('section'); aimView();
  flyTo(p.pos, p.target, { dur: 1.7, fov: 42 });
  setHash('section-' + sec.id);
}
function centreSeat(sec) {
  const row = sec.rows[Math.floor(sec.rows.length * 0.45)];
  return row.seats[Math.floor(row.seats.length / 2)];
}
function enterSeat(s) {
  state.mode = 'seat'; state.viewSeat = s; ui(); renderSeatbar();
  const eye = new THREE.Vector3(s.x + s.nx * 0.05, s.y + 1.22, s.z + s.nz * 0.05);
  const dir = new THREE.Vector3(s.x * 0.35, 0, s.z * 0.35).sub(eye).normalize();
  limits('seat'); aimView();
  flyTo(eye, eye.clone().addScaledVector(dir, 0.6), { dur: 1.9, fov: 58 });
}
function closeUp(s) {
  const p = new THREE.Vector3(s.x - s.nx * 13, s.y + 5.5, s.z - s.nz * 13);
  flyTo(p, new THREE.Vector3(s.x, s.y + 0.5, s.z), { dur: 1.3, fov: 42 });
}

/* ------------------------------------------------------------------ */
/* Seats in the basket                                                 */
/* ------------------------------------------------------------------ */
let toastTimer = 0;
function flash(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function toggleSeat(s) {
  if (s.status === 1) { flash('That seat is taken.'); return; }
  if (s.status === 2) {
    s.status = 0; state.basket = state.basket.filter((x) => x !== s);
    if (state.touch) flash(`${seatName(s)} removed.`);
  } else {
    if (state.basket.length >= MAX_SEATS) { flash(`You can book up to ${MAX_SEATS} seats in one order.`); return; }
    s.status = 2; state.basket.push(s);
    if (state.touch) flash(`${seatName(s)} added.`);
  }
  paint(s.sec); refreshGlow(); renderSheet(); renderBasket(); renderSeatbar();
}
function bestRun(sec, q) {
  const ideal = sec.tier.key === 'club' ? 0 : Math.round(sec.rows.length * (sec.tier.key === 'lower' ? 0.45 : 0.3));
  let best = null;
  sec.rows.forEach((row, r) => {
    const n = row.seats.length;
    for (let i = 0; i + q <= n; i++) {
      const run = row.seats.slice(i, i + q);
      if (run.some((s) => s.status !== 0)) continue;
      const score = Math.abs(r - ideal) * 1.2 + Math.abs(i + (q - 1) / 2 - (n - 1) / 2) / n * 14;
      if (!best || score < best.score) best = { score, run };
    }
  });
  return best && best.run;
}
function findBest() {
  const sec = state.active;
  state.basket.filter((s) => s.sec === sec).forEach((s) => { s.status = 0; });
  state.basket = state.basket.filter((s) => s.sec !== sec);
  const q = Math.min(state.qty, MAX_SEATS - state.basket.length);
  const run = q > 0 ? bestRun(sec, q) : null;
  if (!run) flash(q > 0 ? `No ${q} seats together here. Try fewer seats or another section.` : `Your basket is full (${MAX_SEATS} seats).`);
  else { run.forEach((s) => { s.status = 2; state.basket.push(s); }); closeUp(run[Math.floor(run.length / 2)]); }
  paint(sec); refreshGlow(); renderSheet(); renderBasket();
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */
function renderSheet() {
  const sec = state.active;
  if (!sec) return;
  const mine = state.basket.filter((s) => s.sec === sec);
  $('#sh-crumb').textContent = `${sec.stand}, ${sec.tier.name.toLowerCase()}`;
  $('#sh-id').textContent = sec.id;
  $('#sh-price').textContent = money(sec.price);
  $('#sh-left').textContent = sec.free;
  $('#sh-rows').textContent = `${sec.rows[0].letter}–${sec.rows[sec.rows.length - 1].letter}`;
  $('#qty').textContent = state.qty;
  $('#best').textContent = state.qty === 1 ? 'Find the best seat' : `Find the best ${state.qty} together`;
  $('#view').textContent = mine.length ? `View from ${seatName(mine[0]).toLowerCase()}` : 'View from the middle of this section';
  $('#mine').innerHTML = mine.length
    ? mine.map((s) => `<li><span>${seatName(s)}</span><b>${money(sec.price)}</b><button type="button" data-rm="${state.basket.indexOf(s)}" aria-label="Remove ${seatName(s)}">✕</button></li>`).join('')
    : '<li class="empty">Tap a red seat to add it, or let us find the best ones.</li>';
}
function renderSeatbar() {
  const s = state.viewSeat;
  if (state.mode !== 'seat' || !s) return;
  $('#sb-label').textContent = `Section ${s.sec.id}, ${seatName(s).toLowerCase()}`;
  const add = $('#sb-add');
  add.hidden = s.status === 1;
  add.textContent = s.status === 2 ? 'Remove this seat' : `Add this seat, ${money(s.sec.price)}`;
}
function renderBasket() {
  const n = state.basket.length;
  $('#basket').hidden = n === 0 || !$('#checkout').hidden;
  document.body.classList.toggle('has-basket', n > 0);
  $('#bk-count').textContent = `${n} seat${n === 1 ? '' : 's'}`;
  $('#bk-total').textContent = money(state.basket.reduce((a, s) => a + s.sec.price, 0));
}
function fillJump() {
  const groups = new Map();
  sections.forEach((s) => { const g = `${s.stand}, ${s.tier.name.toLowerCase()}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
  $('#jump').innerHTML = '<option value="">Jump to a section</option>' + [...groups].map(([g, list]) =>
    `<optgroup label="${g}">${list.map((s) => `<option value="${s.id}"${s.away ? ' disabled' : ''}>Section ${s.id}, ${s.away ? 'away fans' : money(s.price)}</option>`).join('')}</optgroup>`).join('');
}

/* Checkout (demo only) */
function openCheckout() {
  const list = state.basket, sub = list.reduce((a, s) => a + s.sec.price, 0), fee = list.length * FEE;
  $('#co-lines').innerHTML = list.map((s) => `<li><span>Section ${s.sec.id}, ${seatName(s).toLowerCase()}<small>${s.sec.stand}, ${s.sec.tier.name.toLowerCase()}, gate ${s.sec.gate}</small></span><b>${money(s.sec.price)}</b></li>`).join('');
  $('#co-sub').textContent = money(sub);
  $('#co-feelabel').textContent = `Booking fee (${list.length} × ${money(FEE)})`;
  $('#co-fee').textContent = money(fee);
  $('#co-total').textContent = money(sub + fee);
  $('#co-step1').hidden = false; $('#co-step2').hidden = true;
  $('#checkout').hidden = false; renderBasket();
  $('#co-reserve').focus();
}
function closeCheckout() { $('#checkout').hidden = true; renderBasket(); }
function reserve() {
  const ref = 'RDV-' + Math.floor(rnd() * 36 ** 5).toString(36).toUpperCase().padStart(5, '0');
  const list = [...state.basket];
  $('#co-tickets').innerHTML = list.map((s, i) => `<article class="ticket"><div class="t-main">
    <p class="t-match">${MATCH.home} v ${MATCH.away}</p><p class="t-when">${MATCH.when}, ${MATCH.ground}. Ticket ${ref}-${i + 1}</p>
    <dl><div><dt>Gate</dt><dd>${s.sec.gate}</dd></div><div><dt>Section</dt><dd>${s.sec.id}</dd></div><div><dt>Row</dt><dd>${s.sec.rows[s.r].letter}</dd></div><div><dt>Seat</dt><dd>${s.num}</dd></div></dl>
    </div><div class="t-stub"><span>Admit one</span></div></article>`).join('');
  $('#co-ref').textContent = ref;
  list.forEach((s) => { s.status = 1; });
  state.basket = [];
  new Set(list.map((s) => s.sec)).forEach(paint);
  refreshGlow(); renderSheet(); renderSeatbar();
  $('#co-step1').hidden = true; $('#co-step2').hidden = false;
}

/* ------------------------------------------------------------------ */
/* Pointer                                                             */
/* ------------------------------------------------------------------ */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(x, y) {
  ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (state.mode === 'section' && state.active) {
    const hit = ray.intersectObject(state.active.mesh, false)[0];
    if (hit) return { sec: state.active, seat: state.active.seats[hit.instanceId] };
  }
  for (const h of ray.intersectObjects(pickers, false)) {
    const sec = h.object.userData.sec;
    if (sec !== state.active) return { sec };
  }
  return null;
}
const tip = $('#tip');
function setHover(h, e) {
  state.hover = h ? h.sec : null;
  if (h && h.seat && h.seat.status !== 1) { seatMatrix(h.seat, 1.09, hoverSeat.matrix); hoverSeat.visible = true; } else hoverSeat.visible = false;
  canvas.style.cursor = h ? 'pointer' : '';
  if (!h || !e || state.touch) { tip.hidden = true; return; }
  if (h.seat) {
    const s = h.seat;
    tip.innerHTML = `<b>${seatName(s)}</b><span>${s.status === 1 ? 'Taken' : s.status === 2 ? 'In your basket, tap to remove' : money(s.sec.price) + ', tap to add'}</span>`;
  } else {
    const sec = h.sec;
    tip.innerHTML = `<b>Section ${sec.id}</b><span>${sec.stand}, ${sec.tier.name.toLowerCase()}</span><span>${sec.away ? `Away fans, sold by ${MATCH.away}` : `${money(sec.price)}, ${sec.free} seats left`}</span>`;
  }
  tip.hidden = false;
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  const x = Math.min(e.clientX + 18, innerWidth - w - 12), y = Math.min(e.clientY + 18, innerHeight - ht - 12);
  tip.style.transform = `translate(${Math.max(12, x)}px, ${Math.max(12, y)}px)`;
}
let lastMove = null, movePending = false, down = null;
canvas.addEventListener('pointermove', (e) => {
  state.touch = e.pointerType === 'touch';
  if (down) down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
  if (state.touch) return;
  lastMove = e;
  if (movePending) return;
  movePending = true;
  requestAnimationFrame(() => {
    movePending = false;
    if (fly || state.mode === 'seat' || down) { setHover(null); return; }
    setHover(pick(lastMove.clientX, lastMove.clientY), lastMove);
  });
});
canvas.addEventListener('pointerleave', () => setHover(null));
canvas.addEventListener('pointerdown', (e) => { state.touch = e.pointerType === 'touch'; down = { x: e.clientX, y: e.clientY, moved: 0 }; });
addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
  down = null;
  if (moved > 8 || fly || e.target !== canvas) return;
  const h = pick(e.clientX, e.clientY);
  if (state.mode === 'overview' && h) openSection(h.sec);
  else if (state.mode === 'section' && h) { if (h.seat) toggleSeat(h.seat); else openSection(h.sec); }
});

/* ------------------------------------------------------------------ */
/* Controls wiring                                                     */
/* ------------------------------------------------------------------ */
document.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', () => {
  state.filter = state.filter === b.dataset.tier ? null : b.dataset.tier;
  document.querySelectorAll('[data-tier]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tier === state.filter)));
  sections.forEach(paint);
}));
$('#jump').addEventListener('change', (e) => { const s = byId.get(e.target.value); e.target.value = ''; if (s) openSection(s); });
$('#sh-close').addEventListener('click', toOverview);
$('#q-minus').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); renderSheet(); });
$('#q-plus').addEventListener('click', () => { state.qty = Math.min(MAX_SEATS, state.qty + 1); renderSheet(); });
$('#best').addEventListener('click', findBest);
$('#view').addEventListener('click', () => enterSeat(state.basket.find((s) => s.sec === state.active) || centreSeat(state.active)));
$('#mine').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) toggleSeat(state.basket[+b.dataset.rm]); });
$('#sb-add').addEventListener('click', () => toggleSeat(state.viewSeat));
$('#sb-back').addEventListener('click', () => openSection(state.viewSeat.sec));
$('#bk-go').addEventListener('click', openCheckout);
$('#co-reserve').addEventListener('click', reserve);
$('#checkout').addEventListener('click', (e) => { if (e.target.id === 'checkout' || e.target.closest('[data-close]')) closeCheckout(); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#checkout').hidden) closeCheckout();
  else if (state.mode === 'seat') openSection(state.viewSeat.sec);
  else if (state.mode === 'section') toOverview();
});
const panelsRO = new ResizeObserver(() => aimView());
['#intro', '#sheet', '#seatbar', '#basket'].forEach((s) => panelsRO.observe($(s)));

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  camera.aspect = w / h;
  aimView();
}
addEventListener('resize', resize);

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  stepFly(dt);
  if (!fly) controls.update();

  const lift = camera.position.y / Math.max(1, camera.position.length());
  const roof = state.mode === 'seat' ? 1 : 1 - THREE.MathUtils.smoothstep(lift, 0.55, 0.78);
  M.roof.opacity = roof; M.girder.opacity = roof;
  M.roof.depthWrite = M.girder.depthWrite = roof > 0.98;
  roofGroup.visible = roof > 0.01;

  for (const sec of sections) {
    const want = sec === state.active ? 0 : sec === state.hover ? 0.38 : state.mode === 'overview' && state.filter === sec.tier.key ? 0.1 : 0;
    sec.glow += (want - sec.glow) * Math.min(1, dt * 12);
    sec.picker.material.opacity = sec.glow;
    sec.picker.visible = sec.glow > 0.004;
  }
  if (!reduceMotion) for (const l of leds) l.tex.offset.x += dt * l.speed;

  camera.near = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.004, 0.05, 1.5);
  view.ox += (view.tx - view.ox) * Math.min(1, dt * 8);
  view.oy += (view.ty - view.oy) * Math.min(1, dt * 8);
  camera.setViewOffset(innerWidth, innerHeight, -view.ox, -view.oy, innerWidth, innerHeight);
  camera.updateProjectionMatrix();

  composer.render();
  window.__stadiumBusy = !!fly;
  if (!window.__stadiumReady) { window.__stadiumReady = true; $('#loader').classList.add('gone'); }
}

fillJump();
resize();
ui();
{
  const o = overviewPose();
  limits('overview', o.D);
  aimView(); view.ox = view.tx; view.oy = view.ty;
  camera.position.setFromSphericalCoords(o.D * 1.9, 0.05, (o.pos.x > 1 ? HALF : 0) - 0.7);
  controls.target.set(0, 0, 0);
  camera.lookAt(0, 0, 0);
  const wanted = (location.hash.match(/^#section-(\w+)$/) || [])[1];
  flyTo(o.pos, o.target, { dur: 2.8, fov: 40, after: () => { const s = byId.get(wanted); if (s) openSection(s); } });
}
renderer.setAnimationLoop(frame);
