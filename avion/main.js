import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TAU = Math.PI * 2;
const V3 = THREE.Vector3;

/* ------------------------------------------------------------------ */
/* Sample flight                                                       */
/* ------------------------------------------------------------------ */
const FLIGHT = { no: 'MV 210', from: 'CMN', fromCity: 'Casablanca', to: 'JFK', toCity: 'New York', dep: '10:40', arr: '12:45', dur: '8 h 05', gate: 'A4' };
const MAX_PAX = 4;
const nf = new Intl.NumberFormat('fr-FR');
const money = (v) => nf.format(v) + ' €';
const PLANE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0v5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z" fill="currentColor"/></svg>';
const TYPE_LABEL = { window: 'Hublot', aisle: 'Couloir', middle: 'Milieu', centre: 'Centre', extra: 'Espace+' };

/* ------------------------------------------------------------------ */
/* Fuselage shape (metres). Nose points to +x, the roof is cut at CUT. */
/* ------------------------------------------------------------------ */
const R = 3, RI = 2.9, FLOOR = -0.95, CUT = 0.45, DOOR_TOP = 1.1;
const A0 = Math.acos(CUT / R), AI = Math.acos(CUT / RI);
const X_TAIL = -36, X_AFT = -23.6, X_FWD = 26.2, X_NOSE = 32;
const DOORS = [25.2, 19.2, 7.6, -11.4, -22.7];
function radiusAt(x) {
  if (x > X_FWD) { const k = (x - X_FWD) / (X_NOSE - X_FWD); return Math.max(0.05, R * Math.pow(1 - Math.pow(k, 2.2), 0.5)); }
  if (x < X_AFT) { const k = (X_AFT - x) / (X_AFT - X_TAIL); return R * (1 - 0.83 * Math.pow(k, 1.3)); }
  return R;
}
function centreAt(x) {
  if (x > X_FWD) { const k = (x - X_FWD) / (X_NOSE - X_FWD); return -0.35 * k * k; }
  if (x < X_AFT) { const k = (X_AFT - x) / (X_AFT - X_TAIL); return 1.9 * Math.pow(k, 1.5); }
  return 0;
}
const steps = (x0, x1, n, pow = 1) => Array.from({ length: n + 1 }, (_, i) => x0 + (x1 - x0) * Math.pow(i / n, pow));
function tube(xs, a0, a1, na, off = 0) {
  const P = na + 1, S = xs.length;
  const pos = new Float32Array(P * S * 3), uv = new Float32Array(P * S * 2);
  for (let i = 0; i < S; i++) {
    const x = xs[i], r = Math.max(0.03, radiusAt(x) + off), yc = centreAt(x);
    for (let j = 0; j < P; j++) {
      const a = a0 + (a1 - a0) * j / na, k = i * P + j;
      pos[k * 3] = x; pos[k * 3 + 1] = yc + r * Math.cos(a); pos[k * 3 + 2] = r * Math.sin(a);
      uv[k * 2] = (x - X_TAIL) / (X_NOSE - X_TAIL); uv[k * 2 + 1] = a / TAU;
    }
  }
  const idx = [];
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < P - 1; j++) { const a = i * P + j, b = a + P; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
/* A box bent into a tapered, swept slab: wings, stabilisers, fin. */
function slab({ root, span, chordRoot, chordTip, sweep, dihedral = 0, thickRoot, thickTip, up = false }) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const c = 0.5 - p.getX(i), t = p.getY(i), s = p.getZ(i) + 0.5;
    const chord = chordRoot + (chordTip - chordRoot) * s, along = s * span;
    const X = root.x - along * Math.tan(sweep) - c * chord;
    const th = (thickRoot + (thickTip - thickRoot) * s) * (1 - 0.65 * c);
    if (up) p.setXYZ(i, X, root.y + along, root.z + t * th);
    else p.setXYZ(i, X, root.y + along * Math.tan(dihedral) + t * th, root.z + along);
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Renderer, sky and clouds                                            */
/* ------------------------------------------------------------------ */
const canvas = $('#scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (err) {
  $('#loader p').textContent = "Ce plan de cabine a besoin de WebGL, désactivé dans ce navigateur.";
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const HORIZON = new THREE.Color('#e9a385');
scene.fog = new THREE.Fog(HORIZON, 500, 2600);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 7000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.screenSpacePanning = true;

const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.92));
composer.addPass(new OutputPass());

const sunDir = new V3(-0.78, 0.17, -0.6).normalize();
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color('#0d1a42') }, mid: { value: new THREE.Color('#5d6cab') }, hor: { value: new THREE.Color('#ffb07a') }, low: { value: new THREE.Color('#7b6d9c') }, sun: { value: sunDir } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 low; uniform vec3 sun; varying vec3 vDir;
    void main(){ vec3 d = normalize(vDir); float h = d.y;
      vec3 c = mix(hor, mid, smoothstep(0.02, 0.3, h)); c = mix(c, top, smoothstep(0.3, 0.9, h)); c = mix(c, low, smoothstep(0.0, -0.3, h));
      float s = max(dot(d, sun), 0.0); c += vec3(1.0, 0.72, 0.45) * (pow(s, 700.0) * 7.0 + pow(s, 26.0) * 0.5 + pow(s, 4.0) * 0.14);
      gl_FragColor = vec4(c, 1.0); }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(3200, 48, 24), skyMat);
sky.renderOrder = -10;
scene.add(sky);
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(sky.geometry, skyMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02, 1, 6000).texture;
  pmrem.dispose();
}
scene.add(new THREE.HemisphereLight('#c9d6ff', '#e7a27c', 0.55));
const sun = new THREE.DirectionalLight('#ffd6ae', 2.3);
sun.position.copy(sunDir).multiplyScalar(300);
scene.add(sun);
const fill = new THREE.DirectionalLight('#a9b8ff', 0.6);
fill.position.set(60, 90, 110);
scene.add(fill);

function cloudCanvas(seed, cover, soft, size = 256) {
  let s = seed;
  const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
  const octs = [4, 8, 16, 32, 64].map((n) => ({ n, g: Float32Array.from({ length: n * n }, rnd) }));
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d'), img = x.createImageData(size, size);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let v = 0, amp = 0.55, tot = 0;
    for (const { n, g } of octs) {
      const fx = px / size * n, fy = py / size * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % n) * n + x0 % n], b = g[(y0 % n) * n + (x0 + 1) % n], cc = g[((y0 + 1) % n) * n + x0 % n], d = g[((y0 + 1) % n) * n + (x0 + 1) % n];
      v += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (cc * (1 - sx) + d * sx) * sy); tot += amp; amp *= 0.5;
    }
    v /= tot;
    const al = Math.min(1, Math.max(0, (v - cover) / soft)), k = (py * size + px) * 4;
    const shade = 200 + 55 * Math.min(1, Math.max(0, (v - cover) * 4));
    img.data[k] = img.data[k + 1] = img.data[k + 2] = shade; img.data[k + 3] = al * 255;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
  return t;
}
const cloudLayers = [];
[[-22, 0.56, '#fff4ec', 0.013, 11], [-27, 0.5, '#ffe1d4', 0.009, 23], [-34, 0.44, '#e6c4d2', 0.006, 37], [-45, 0.38, '#a99bc2', 0.004, 51]].forEach(([y, cover, col, speed, seed]) => {
  const map = cloudCanvas(seed, cover, 0.22);
  map.repeat.set(6, 6);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3600, 3600), new THREE.MeshBasicMaterial({ map, color: col, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = -5 - cloudLayers.length;
  scene.add(m); cloudLayers.push({ map, speed });
});
{
  const base = new THREE.Mesh(new THREE.PlaneGeometry(3600, 3600), new THREE.MeshBasicMaterial({ color: '#6c6791' }));
  base.rotation.x = -Math.PI / 2; base.position.y = -58; scene.add(base);
}
const puffs = [];
{
  const tex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    let s = 99; const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
    for (let i = 0; i < 26; i++) {
      const px = 64 + (rnd() - 0.5) * 60, py = 70 + (rnd() - 0.5) * 30, r = 18 + rnd() * 24;
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  let s = 7; const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
  for (let i = 0; i < 34; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#ffe9de', transparent: true, depthWrite: false, opacity: 0.9 }));
    let x, z;
    do { x = (rnd() - 0.5) * 1200; z = (rnd() - 0.5) * 1200; } while (Math.hypot(x, z) < 120);
    const sc = 70 + rnd() * 90;
    sp.scale.set(sc, sc * 0.55, 1); sp.position.set(x, -24 + rnd() * 8, z);
    scene.add(sp); puffs.push(sp);
  }
}

/* ------------------------------------------------------------------ */
/* Livery and cabin lining textures                                    */
/* ------------------------------------------------------------------ */
try { await Promise.race([document.fonts.load('800 64px Manrope'), new Promise((r) => setTimeout(r, 2500))]); } catch { /* fallback font */ }

const AWIN = Math.acos(0.15 / R);
const windowXs = [];
for (let x = -22.9; x < 25.7; x += 0.53) if (!DOORS.some((d) => Math.abs(d - x) < 0.75)) windowXs.push(x);

function shellTexture(inside) {
  const W = 4096, H = 1152, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const U = (xm) => (xm - X_TAIL) / (X_NOSE - X_TAIL) * W, V = (a) => ((a % TAU) + TAU) % TAU / TAU * H;
  const ppm = W / (X_NOSE - X_TAIL);
  const sides = [[AWIN, 1], [TAU - AWIN, -1]];
  const rr = (cx, cy, w, h, r) => { x.beginPath(); x.roundRect(cx - w / 2, cy - h / 2, w, h, r); };
  if (inside) {
    x.fillStyle = '#ebe3d5'; x.fillRect(0, 0, W, H);
    for (const [a] of sides) for (const wx of windowXs) {
      x.fillStyle = '#cdbfab'; rr(U(wx), V(a), 0.36 * ppm, 0.62 / R / TAU * H, 12); x.fill();
      x.fillStyle = '#a9c6f2'; rr(U(wx), V(a), 0.25 * ppm, 0.44 / R / TAU * H, 9); x.fill();
    }
  } else {
    x.fillStyle = '#f3f4f7'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#c9cfda'; x.fillRect(0, V(Math.PI - 0.9), W, 1.8 / TAU * H);
    for (const [a, sg] of sides) {
      x.fillStyle = '#c9a24a'; x.fillRect(U(-22), V(a + sg * 0.2) - 4, U(27) - U(-22), 8);
      x.fillStyle = '#14204a'; x.fillRect(U(-22), V(a + sg * 0.27) - 7, U(27) - U(-22), 14);
      x.fillStyle = '#1b2333';
      for (const wx of windowXs) { rr(U(wx), V(a), 0.24 * ppm, 0.4 / R / TAU * H, 6); x.fill(); }
      x.strokeStyle = '#a8b0bf'; x.lineWidth = 3;
      for (const d of DOORS) { rr(U(d), V(a + sg * 0.05), 1.07 * ppm, 1.85 / R / TAU * H, 14); x.stroke(); }
      x.fillStyle = '#1b2333';
      for (const [cx, dx] of [[29.4, 0.5], [30.0, 0.46], [30.55, 0.4]]) { x.beginPath(); x.roundRect(U(cx) - dx * ppm / 2, V(a - sg * 0.78) - 0.035 * H, dx * ppm, 0.07 * H, 6); x.fill(); }
    }
    x.font = `800 ${0.95 * ppm}px Manrope, Arial, sans-serif`;
    x.fillStyle = '#14204a'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('MIRAVA', U(13), V(1.05));
    x.save(); x.translate(U(13), V(TAU - 1.05)); x.rotate(Math.PI); x.fillText('MIRAVA', 0, 0); x.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
  return t;
}
function windowMask() {
  const W = 2048, H = 576, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d'), ppm = W / (X_NOSE - X_TAIL);
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.fillStyle = '#fff';
  for (const a of [AWIN, TAU - AWIN]) for (const wx of windowXs) {
    x.beginPath(); x.roundRect((wx - X_TAIL) * ppm - 0.12 * ppm, a / TAU * H - 0.22 / R / TAU * H, 0.24 * ppm, 0.44 / R / TAU * H, 5); x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.flipY = false; t.wrapT = THREE.RepeatWrapping;
  return t;
}
function finTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#14204a'; x.fillRect(0, 0, 512, 512);
  x.strokeStyle = '#d9a845'; x.lineWidth = 16; x.beginPath(); x.arc(256, 250, 100, 0, TAU); x.stroke();
  x.fillStyle = '#d9a845'; x.font = '800 120px Manrope, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('M', 256, 256);
  x.fillRect(0, 470, 512, 14);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ------------------------------------------------------------------ */
/* The plane                                                           */
/* ------------------------------------------------------------------ */
const plane = new THREE.Group();
scene.add(plane);
const roofGroup = new THREE.Group();
plane.add(roofGroup);
const skinTex = shellTexture(false), innerTex = shellTexture(true), maskTex = windowMask();
const M = {
  skin: new THREE.MeshStandardMaterial({ map: skinTex, roughness: 0.3, metalness: 0.15 }),
  skinRoof: new THREE.MeshStandardMaterial({ map: skinTex, roughness: 0.3, metalness: 0.15, transparent: true }),
  inner: new THREE.MeshStandardMaterial({ map: innerTex, emissiveMap: maskTex, emissive: new THREE.Color('#8fb6ff'), emissiveIntensity: 0.75, roughness: 0.85, envMapIntensity: 0.5, side: THREE.BackSide }),
  innerRoof: new THREE.MeshStandardMaterial({ map: innerTex, roughness: 0.85, side: THREE.BackSide, transparent: true }),
  cream: new THREE.MeshStandardMaterial({ color: '#e4dbcc', roughness: 0.7, envMapIntensity: 0.6, side: THREE.DoubleSide }),
  creamRoof: new THREE.MeshStandardMaterial({ color: '#e6ddcf', roughness: 0.7, side: THREE.DoubleSide, transparent: true }),
  light: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.45, 1.15), transparent: true }),
  carpet: new THREE.MeshStandardMaterial({ color: '#2b3150', roughness: 1 }),
  wing: new THREE.MeshStandardMaterial({ color: '#dfe3ea', roughness: 0.38, metalness: 0.25 }),
  engine: new THREE.MeshStandardMaterial({ color: '#eef0f4', roughness: 0.28, metalness: 0.2 }),
  metal: new THREE.MeshStandardMaterial({ color: '#b9bfcb', roughness: 0.25, metalness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: '#1a1e28', roughness: 0.5, metalness: 0.4 }),
  fin: new THREE.MeshStandardMaterial({ map: finTexture(), roughness: 0.35, metalness: 0.1 }),
};
const roofMats = [M.skinRoof, M.innerRoof, M.creamRoof, M.light];
const add = (geo, mat, parent = plane) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };

const cabinXs = steps(X_AFT, X_FWD, 2);
const hull = [
  add(tube(steps(X_FWD, X_NOSE, 26, 0.7), Math.PI, 3 * Math.PI, 64), M.skin),
  add(tube(steps(X_TAIL, X_AFT, 24), Math.PI, 3 * Math.PI, 64), M.skin),
  add(tube(cabinXs, A0, TAU - A0, 64), M.skin),
  add(tube(cabinXs, -A0, A0, 24), M.skinRoof, roofGroup),
];
add(tube(cabinXs, AI, TAU - AI, 64, -0.1), M.inner);
add(tube(cabinXs, -AI, AI, 24, -0.1), M.innerRoof, roofGroup);
{
  const tailCap = add(new THREE.SphereGeometry(radiusAt(X_TAIL), 24, 12), M.skin);
  tailCap.scale.set(1.8, 1, 1); tailCap.position.set(X_TAIL, centreAt(X_TAIL), 0);
  for (const sg of [1, -1]) {
    const rim = add(new THREE.BoxGeometry(X_FWD - X_AFT, 0.04, 0.11), M.cream);
    rim.position.set((X_FWD + X_AFT) / 2, CUT - 0.02, sg * (R * Math.sin(A0) + RI * Math.sin(AI)) / 2);
  }
  const floor = add(new THREE.BoxGeometry(X_FWD - X_AFT - 0.3, 0.1, 2 * Math.sqrt(RI * RI - FLOOR * FLOOR) - 0.04), M.carpet);
  floor.position.set((X_FWD + X_AFT) / 2, FLOOR - 0.05, 0);
}
/* Bulkheads: lower part stays, upper part lifts with the roof. */
function bulkhead(x, openings) {
  const r = RI - 0.02, zf = Math.sqrt(r * r - FLOOR * FLOOR), zc = Math.sqrt(r * r - CUT * CUT);
  const tf = Math.asin(FLOOR / r), tc = Math.asin(CUT / r);
  const arc = (t0, t1, n = 10) => Array.from({ length: n + 1 }, (_, i) => { const t = t0 + (t1 - t0) * i / n; return [r * Math.cos(t), r * Math.sin(t)]; });
  const lower = [];
  const cuts = [-Infinity, ...openings.flat(), Infinity];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    let pts;
    if (a === -Infinity && b === Infinity) pts = [[-zf, FLOOR], [zf, FLOOR], ...arc(tf, tc), [-zc, CUT], ...arc(Math.PI - tc, Math.PI - tf)];
    else if (a === -Infinity) pts = [[b, FLOOR], [b, CUT], [-zc, CUT], ...arc(Math.PI - tc, Math.PI - tf)];
    else if (b === Infinity) pts = [[a, FLOOR], [zf, FLOOR], ...arc(tf, tc), [a, CUT]];
    else pts = [[a, FLOOR], [b, FLOOR], [b, CUT], [a, CUT]];
    lower.push(new THREE.ShapeGeometry(new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v)))));
  }
  const up = [...arc(tc, Math.PI - tc, 30)];
  for (const [a, b] of openings) up.push([a, CUT], [a, DOOR_TOP], [b, DOOR_TOP], [b, CUT]);
  const place = (g) => { g.rotateY(-Math.PI / 2); g.translate(x, 0, 0); return g; };
  add(place(mergeGeometries(lower)), M.cream);
  add(place(new THREE.ShapeGeometry(new THREE.Shape(up.map(([u, v]) => new THREE.Vector2(u, v))))), M.creamRoof, roofGroup);
}
const AISLES = [[-1.45, -0.72], [0.72, 1.45]];
bulkhead(X_FWD - 0.1, [[-0.45, 0.45]]);
bulkhead(18.4, AISLES);
bulkhead(8.3, AISLES);
bulkhead(0.62, AISLES);
bulkhead(X_AFT + 0.25, []);
/* Overhead bins and ceiling light strips (part of the roof). */
for (const sg of [1, -1]) {
  const bin = add(new THREE.BoxGeometry(41, 0.55, 0.7), M.creamRoof, roofGroup);
  bin.position.set(-22.4 + 20.5, 1.55, sg * 2.0);
  const strip = add(new THREE.BoxGeometry(X_FWD - X_AFT - 1, 0.03, 0.12), M.light, roofGroup);
  strip.position.set((X_FWD + X_AFT) / 2, 2.62, sg * 0.55);
}
{
  const mid = add(new THREE.BoxGeometry(28.6, 0.5, 1.3), M.creamRoof, roofGroup);
  mid.position.set(-22.4 + 14.3, 1.75, 0);
}

/* Wings, winglets, tailplane, fin and engines. */
const WING = { root: { x: 6.2, y: -1.75, z: 2.2 }, span: 30, chordRoot: 10, chordTip: 2.3, sweep: THREE.MathUtils.degToRad(31), dihedral: THREE.MathUtils.degToRad(6), thickRoot: 0.9, thickTip: 0.22 };
const tipX = WING.root.x - WING.span * Math.tan(WING.sweep), tipY = WING.root.y + WING.span * Math.tan(WING.dihedral);
const HSTAB = { root: { x: -27.2, y: 0.65, z: 1.4 }, span: 9.5, chordRoot: 5.5, chordTip: 2, sweep: THREE.MathUtils.degToRad(34), dihedral: THREE.MathUtils.degToRad(7), thickRoot: 0.45, thickTip: 0.12 };
for (const sg of [1, -1]) {
  const side = new THREE.Group();
  side.scale.z = sg;
  plane.add(side);
  add(slab(WING), M.wing, side);
  add(slab({ root: { x: tipX + 0.1, y: tipY, z: WING.root.z + WING.span - 0.05 }, span: 3.2, chordRoot: 2.2, chordTip: 0.9, sweep: THREE.MathUtils.degToRad(40), thickRoot: 0.16, thickTip: 0.08, up: true }), M.fin, side);
  add(slab(HSTAB), M.wing, side);
  const eng = new THREE.Group();
  const ez = 10.5, wingY = WING.root.y + (ez - WING.root.z) * Math.tan(WING.dihedral);
  eng.position.set(-1.4, wingY - 1.75, ez);
  side.add(eng);
  const nacelle = new THREE.LatheGeometry([[0.5, 0], [0.92, 0.6], [1.3, 2.4], [1.45, 4.2], [1.42, 5.0], [1.3, 5.45], [1.16, 5.38]].map(([r, y]) => new THREE.Vector2(r, y)), 40);
  nacelle.rotateZ(-Math.PI / 2);
  add(nacelle, M.engine, eng);
  const lip = add(new THREE.TorusGeometry(1.24, 0.08, 10, 40), M.metal, eng);
  lip.rotation.y = Math.PI / 2; lip.position.x = 5.42;
  const fan = add(new THREE.CircleGeometry(1.2, 40), M.dark, eng);
  fan.rotation.y = Math.PI / 2; fan.position.x = 5.0;
  const spinner = add(new THREE.ConeGeometry(0.34, 0.8, 24), M.metal, eng);
  spinner.rotation.z = -Math.PI / 2; spinner.position.x = 5.35;
  const cone = add(new THREE.ConeGeometry(0.42, 1.4, 24), M.metal, eng);
  cone.rotation.z = Math.PI / 2; cone.position.x = -0.6;
  const pylon = add(new THREE.BoxGeometry(4.6, 1.2, 0.34), M.wing, eng);
  pylon.position.set(2.4, 1.2, 0);
}
add(slab({ root: { x: -26.4, y: 2.2, z: 0 }, span: 9.2, chordRoot: 8.5, chordTip: 3, sweep: THREE.MathUtils.degToRad(38), thickRoot: 0.55, thickTip: 0.18, up: true }), M.fin);

/* ------------------------------------------------------------------ */
/* Cabins and seats                                                    */
/* ------------------------------------------------------------------ */
function part(dx, dy, dz, px, py, pz, shade = 1, rz = 0) {
  const g = new THREE.BoxGeometry(dx, dy, dz);
  if (rz) g.rotateZ(rz);
  g.translate(px, py, pz);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(shade), 3));
  return g;
}
const GEO = {
  eco: mergeGeometries([part(0.36, 0.36, 0.36, 0, 0.18, 0, 0.35), part(0.46, 0.11, 0.44, 0.03, 0.42, 0), part(0.09, 0.72, 0.44, -0.21, 0.82, 0, 0.9, 0.16), part(0.1, 0.18, 0.32, -0.29, 1.16, 0, 1.15), part(0.4, 0.05, 0.05, 0, 0.62, -0.245, 0.4), part(0.4, 0.05, 0.05, 0, 0.62, 0.245, 0.4)]),
  prem: mergeGeometries([part(0.4, 0.36, 0.42, 0, 0.18, 0, 0.35), part(0.5, 0.13, 0.5, 0.03, 0.44, 0), part(0.06, 0.3, 0.44, 0.31, 0.3, 0, 0.85, -0.5), part(0.1, 0.8, 0.5, -0.24, 0.88, 0, 0.9, 0.22), part(0.12, 0.2, 0.4, -0.34, 1.28, 0, 1.12), part(0.44, 0.07, 0.09, 0, 0.66, -0.29, 0.4), part(0.44, 0.07, 0.09, 0, 0.66, 0.29, 0.4)]),
  biz: mergeGeometries([part(0.7, 0.3, 0.56, -0.12, 0.15, 0, 0.35), part(0.78, 0.14, 0.56, -0.1, 0.42, 0), part(0.12, 0.85, 0.56, -0.5, 0.88, 0, 0.9, 0.28), part(0.12, 0.2, 0.44, -0.64, 1.3, 0, 1.12), part(0.36, 0.38, 0.46, 0.5, 0.19, 0, 0.75)]),
  first: mergeGeometries([part(0.8, 0.3, 0.7, -0.3, 0.15, 0, 0.35), part(0.86, 0.16, 0.72, -0.3, 0.46, 0), part(0.15, 0.95, 0.72, -0.8, 0.95, 0, 0.9, 0.25), part(0.14, 0.22, 0.56, -0.95, 1.45, 0, 1.12), part(0.5, 0.42, 0.62, 0.62, 0.21, 0, 0.75)]),
};
const SHELL = {
  biz: mergeGeometries([part(1.5, 1.05, 0.06, 0, 0.525, -0.45, 1), part(1.5, 1.05, 0.06, 0, 0.525, 0.45, 1), part(0.06, 1.12, 0.96, -0.75, 0.56, 0, 0.95), part(0.05, 0.95, 0.9, 0.74, 0.475, 0, 0.92), part(0.02, 0.3, 0.5, 0.71, 0.74, 0, 0.08), part(0.42, 0.62, 0.26, 0.5, 0.31, 0.3, 0.7)]),
  first: mergeGeometries([part(2.3, 1.4, 0.06, 0, 0.7, -0.6, 1), part(2.3, 1.4, 0.06, 0, 0.7, 0.6, 1), part(0.06, 1.4, 1.26, -1.15, 0.7, 0, 0.95), part(0.06, 1.4, 1.26, 1.15, 0.7, 0, 0.95), part(0.02, 0.48, 0.82, 1.11, 0.98, 0, 0.08), part(0.5, 0.62, 0.3, 0.1, 0.31, -0.42, 0.7), part(2.3, 0.04, 0.09, 0, 1.42, -0.6, 1.25), part(2.3, 0.04, 0.09, 0, 1.42, 0.6, 1.25)]),
};
const rowsAt = (nums, x0, pitch, extra = []) => nums.map((n, i) => ({ n, x: x0 - i * pitch, extra: extra.includes(n) }));
const ecoRows = [...rowsAt(Array.from({ length: 14 }, (_, i) => 20 + i), 0.0, 0.81), ...rowsAt(Array.from({ length: 13 }, (_, i) => 34 + i), -12.3, 0.81)];
ecoRows.forEach((r) => { r.extra = r.n === 20 || r.n === 34; });
const CABINS = [
  { key: 'eco', no: 1, name: 'Économie', color: '#3d7bd9', base: 420, layout: '3-3-3', desc: 'Sièges 3-3-3 avec 79 cm entre les rangs, repas chaud et écran personnel.', rows: ecoRows, busy: 0.56, prefs: ['window', 'aisle', 'middle', 'extra'],
    cols: [['A', -2.4, 'window', 0], ['B', -1.92, 'middle', 0], ['C', -1.44, 'aisle', 0], ['D', -0.48, 'aisle', 1], ['E', 0, 'middle', 1], ['F', 0.48, 'aisle', 1], ['H', 1.44, 'aisle', 2], ['J', 1.92, 'middle', 2], ['K', 2.4, 'window', 2]] },
  { key: 'prem', no: 2, name: 'Premium Économie', color: '#1fb3a2', base: 890, layout: '2-3-2', desc: 'Sièges 2-3-2 plus larges, 97 cm entre les rangs, repose-jambes et menu dédié.', rows: rowsAt([14, 15, 16, 17], 6.0, 0.97), busy: 0.45, prefs: ['window', 'aisle', 'middle'],
    cols: [['A', -2.3, 'window', 0], ['C', -1.76, 'aisle', 0], ['D', -0.54, 'aisle', 1], ['E', 0, 'middle', 1], ['F', 0.54, 'aisle', 1], ['H', 1.76, 'aisle', 2], ['K', 2.3, 'window', 2]] },
  { key: 'biz', no: 3, name: 'Affaires', color: '#8b6be0', base: 2650, layout: '1-2-1', desc: 'Lit entièrement plat de 2 m, accès direct au couloir et salon à l’arrivée.', rows: rowsAt([5, 6, 7, 8, 9, 10], 17.3, 1.6), busy: 0.36, prefs: ['window', 'centre'],
    cols: [['A', -2.05, 'window', 0], ['E', -0.5, 'centre', 1], ['F', 0.5, 'centre', 1], ['K', 2.05, 'window', 2]] },
  { key: 'first', no: 4, name: 'Première', color: '#d9a845', base: 6900, layout: '1-1-1', desc: 'Six suites privées avec porte, grand lit et écran de 32 pouces.', rows: rowsAt([1, 2], 23.75, 2.5), busy: 0.2, prefs: ['window', 'centre'],
    cols: [['A', -1.9, 'window', 0], ['E', 0, 'centre', 1], ['K', 1.9, 'window', 2]] },
];
const byKey = new Map(CABINS.map((c) => [c.key, c]));
const COL = { taken: new THREE.Color('#3b3d46'), takenDim: new THREE.Color('#1f2027'), mine: new THREE.Color('#ff8a2a') };
let seed = 20261218;
const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
const seatMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, vertexColors: true });
const shellMat = new THREE.MeshStandardMaterial({ color: '#e7dccb', roughness: 0.55, envMapIntensity: 0.6, vertexColors: true });
const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.5, 0.1), vertexColors: true });
const hoverMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 1.9, 2.0), vertexColors: true, transparent: true, opacity: 0.85 });
const overlays = [];
const mtx = new THREE.Matrix4();
const seatMatrix = (s, scale = 1, out = mtx) => out.makeScale(scale, scale, scale).setPosition(s.x, FLOOR, s.z);

for (const cab of CABINS) {
  cab.col = new THREE.Color(cab.color);
  cab.dim = cab.col.clone().lerp(new THREE.Color('#14161f'), 0.75);
  cab.soft = cab.col.clone().lerp(COL.taken, 0.7);
  cab.seats = [];
  cab.rows.forEach((row) => {
    row.seats = cab.cols.map(([letter, z, type, block]) => {
      const s = { cab, row, letter, label: row.n + letter, type, block, x: row.x, z, extra: row.extra, status: rnd() < cab.busy + Math.sin(row.n * 1.7 + z * 2.3) * 0.15 ? 1 : 0 };
      cab.seats.push(s);
      return s;
    });
  });
  const geo = GEO[cab.key];
  cab.seatMesh = new THREE.InstancedMesh(geo, seatMat, cab.seats.length);
  cab.seats.forEach((s, i) => cab.seatMesh.setMatrixAt(i, seatMatrix(s)));
  cab.seatMesh.setColorAt(0, cab.col);
  cab.seatMesh.computeBoundingSphere();
  plane.add(cab.seatMesh);
  cab.pickMeshes = [cab.seatMesh];
  if (SHELL[cab.key]) {
    const sh = new THREE.InstancedMesh(SHELL[cab.key], shellMat, cab.seats.length);
    cab.seats.forEach((s, i) => sh.setMatrixAt(i, seatMatrix(s)));
    sh.computeBoundingSphere();
    plane.add(sh); cab.pickMeshes.push(sh);
  }
  cab.glow = new THREE.InstancedMesh(geo, glowMat, MAX_PAX);
  cab.glow.count = 0; cab.glow.frustumCulled = false; plane.add(cab.glow);
  cab.hover = new THREE.Mesh(geo, hoverMat);
  cab.hover.matrixAutoUpdate = false; cab.hover.visible = false; plane.add(cab.hover);
  const depth = { eco: 0.3, prem: 0.32, biz: 0.78, first: 1.17 }[cab.key];
  cab.front = cab.rows[0].x + depth + 0.15;
  cab.back = cab.rows[cab.rows.length - 1].x - depth - 0.15;
  cab.mid = (cab.front + cab.back) / 2;
  const ov = new THREE.Mesh(new THREE.PlaneGeometry(cab.front - cab.back, 5.4), new THREE.MeshBasicMaterial({ color: cab.color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  ov.rotation.x = -Math.PI / 2; ov.position.set(cab.mid, CUT + 0.14, 0); ov.userData.cab = cab; ov.visible = false;
  plane.add(ov); overlays.push(ov); cab.overlay = ov; cab.glowLevel = 0;
}

const seatPrice = (s) => s.cab.base + ({ eco: s.extra ? 65 : s.type === 'window' ? 25 : s.type === 'aisle' ? 20 : 0, prem: s.type === 'window' ? 30 : s.type === 'aisle' ? 20 : 0, biz: s.type === 'window' ? 120 : 0, first: 0 }[s.cab.key]);
const seatKind = (s) => (s.extra ? 'Espace+, ' : '') + TYPE_LABEL[s.type].toLowerCase();
const matches = (s, pref) => (pref === 'extra' ? s.extra : s.type === pref);
function boarding(s, cab) {
  if (cab.key === 'first') return { time: '09:50', group: 'Prioritaire' };
  if (cab.key === 'biz') return { time: '09:55', group: 'Prioritaire' };
  if (cab.key === 'prem') return { time: '10:00', group: 'Groupe 2' };
  return s && s.row.n >= 34 ? { time: '10:05', group: 'Groupe 3' } : { time: '10:15', group: 'Groupe 4' };
}

/* ------------------------------------------------------------------ */
/* State, painting, glow                                               */
/* ------------------------------------------------------------------ */
const state = { mode: 'overview', cab: null, pref: null, qty: 1, basket: [], preview: null, viewSeat: null, touch: false, hull: false };
function paint(cab) {
  const others = state.mode === 'cabin' && state.cab && state.cab !== cab;
  let free = 0;
  cab.seats.forEach((s, i) => {
    if (s.status === 0) free++;
    const c = s.status === 2 ? COL.mine : s.status === 1 ? (others ? COL.takenDim : COL.taken) : others ? cab.dim
      : state.mode === 'cabin' && state.cab === cab && state.pref && !matches(s, state.pref) ? cab.soft : cab.col;
    cab.seatMesh.setColorAt(i, c);
  });
  cab.free = free;
  cab.seatMesh.instanceColor.needsUpdate = true;
  const em = document.querySelector(`[data-left="${cab.key}"]`);
  if (em) em.textContent = `${free} libres`;
}
const paintAll = () => CABINS.forEach(paint);
function refreshGlow() {
  for (const cab of CABINS) {
    const mine = state.basket.filter((s) => s.cab === cab);
    mine.forEach((s, i) => cab.glow.setMatrixAt(i, seatMatrix(s, 1.04, new THREE.Matrix4())));
    cab.glow.count = mine.length;
    cab.glow.instanceMatrix.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* Camera moves and framing                                            */
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
  camera.position.y += Math.sin(Math.PI * e) * fly.p0.distanceTo(fly.p1) * 0.12;
  controls.target.lerpVectors(fly.t0, fly.t1, e);
  camera.fov = fly.f0 + (fly.f1 - fly.f0) * e;
  camera.lookAt(controls.target);
  if (fly.k >= 1) { const after = fly.after; fly = null; controls.enabled = true; controls.update(); if (after) after(); }
}
function limits(mode, far = 300) {
  Object.assign(controls, mode === 'overview'
    ? { minDistance: 25, maxDistance: Math.max(260, far * 1.4), minPolarAngle: 0.05, maxPolarAngle: 1.75, enableZoom: true, enablePan: false, rotateSpeed: 0.6 }
    : mode === 'cabin'
      ? { minDistance: 4, maxDistance: 140, minPolarAngle: 0.05, maxPolarAngle: 1.45, enableZoom: true, enablePan: true, rotateSpeed: 0.5 }
      : { minDistance: 0.6, maxDistance: 0.6, minPolarAngle: 0.4, maxPolarAngle: 2.6, enableZoom: false, enablePan: false, rotateSpeed: -0.32 });
}
const view = { ox: 0, oy: 0, tx: 0, ty: 0 };
function freeRect() {
  const W = innerWidth, H = innerHeight, desk = W >= 860;
  let l = 0, r = W, t = state.mode === 'seat' ? 0 : 64, b = H;
  for (const id of ['#intro', '#sheet', '#seatbar', '#pass']) {
    const el = $(id);
    if (el.hidden || !el.offsetWidth) continue;
    const Rc = el.getBoundingClientRect();
    if (id === '#seatbar') { if (!desk) b = Math.min(b, Rc.top); continue; }
    if (id === '#pass') { b = Math.min(b, Rc.top); continue; }
    if (desk) { if (Rc.left < W / 2) l = Math.max(l, Rc.right); else r = Math.min(r, Rc.left); } else b = Math.min(b, Rc.top);
  }
  const bk = $('#basket');
  if (!bk.hidden && !desk) b = Math.min(b, bk.getBoundingClientRect().top);
  return { l, r, t, b, W, H };
}
function aimView() { const f = freeRect(); view.tx = (f.l + f.r) / 2 - f.W / 2; view.ty = (f.t + f.b) / 2 - f.H / 2; }
function fit(halfW, halfH) {
  const f = freeRect(), tan = Math.tan(THREE.MathUtils.degToRad(20));
  return Math.max(halfW / (tan * (f.r - f.l) / f.H), halfH / (tan * Math.max(120, f.b - f.t) / f.H));
}
const portrait = () => { const f = freeRect(); return (f.r - f.l) / Math.max(1, f.b - f.t) < 0.95; };
function overviewPose() {
  const p = portrait(), dir = (p ? new V3(-0.4, 0.92, 0) : new V3(0, 0.93, 0.37)).normalize();
  const D = p ? fit(20, 33) : fit(35, 14), target = new V3(-2, -0.5, 0);
  return { pos: target.clone().addScaledVector(dir, D), target, D };
}
function cabinPose(cab) {
  const p = portrait(), half = (cab.front - cab.back) / 2;
  const dir = (p ? new V3(-0.5, 0.866, 0) : new V3(0, 0.87, 0.49)).normalize();
  const D = p ? fit(3.4, Math.min(half, 7) * 0.87 + 1) : fit(half + 1, 3.6), target = new V3(cab.mid, FLOOR + 0.6, 0);
  return { pos: target.clone().addScaledVector(dir, D), target };
}
function exteriorPose() {
  const target = new V3(1, -0.5, 0);
  return { pos: target.clone().add(new V3().setFromSphericalCoords(92, 1.36, 0.78)), target };
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */
const setHash = (h) => { try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch { /* sandboxed */ } };
let paintedMode = '';
function ui() {
  const m = state.mode;
  $('#intro').hidden = m !== 'overview';
  $('#sheet').hidden = m !== 'cabin';
  $('#seatbar').hidden = m !== 'seat';
  $('#pass').hidden = !(m === 'cabin' || m === 'seat');
  if (m !== paintedMode || m === 'cabin') { paintedMode = m; paintAll(); }
  renderBasket(); renderPass(); setHover(null);
}
function toOverview() {
  state.mode = 'overview'; state.cab = null; ui();
  const o = overviewPose(); limits('overview', o.D); aimView();
  flyTo(o.pos, o.target, { dur: 1.6, fov: 40 });
  setHash('');
}
function openCabin(cab) {
  if (state.cab !== cab) state.pref = null;
  state.mode = 'cabin'; state.cab = cab; ui(); renderSheet();
  document.documentElement.style.setProperty('--c', cab.color);
  const p = cabinPose(cab); limits('cabin'); aimView();
  flyTo(p.pos, p.target, { dur: 1.7, fov: 40 });
  setHash('cabine-' + cab.key);
}
function enterSeat(s) {
  state.mode = 'seat'; state.viewSeat = s; state.preview = null; ui(); renderSeatbar();
  const eye = new V3(s.x - 0.15, FLOOR + 1.18, s.z);
  const dir = new V3(1, -0.14, s.type === 'window' ? Math.sign(s.z) * 0.38 : 0).normalize();
  limits('seat'); aimView();
  flyTo(eye, eye.clone().addScaledVector(dir, 0.6), { dur: 1.9, fov: 68 });
}
function closeUp(seats) {
  const m = seats[Math.floor(seats.length / 2)];
  const pos = portrait() ? new V3(m.x - 6.5, FLOOR + 8, m.z) : new V3(m.x - 3, FLOOR + 8, m.z * 0.3 + 5);
  flyTo(pos, new V3(m.x + 0.3, FLOOR + 0.4, m.z), { dur: 1.3, fov: 40 });
}
function suggestedSeat(cab) {
  const free = cab.seats.filter((s) => s.status === 0);
  return free.find((s) => s.type === 'window' && s.row === cab.rows[Math.floor(cab.rows.length / 3)]) || free.find((s) => s.type === 'window') || free[0] || cab.seats[0];
}

/* ------------------------------------------------------------------ */
/* Basket                                                              */
/* ------------------------------------------------------------------ */
let toastTimer = 0;
function flash(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function toggleSeat(s) {
  if (s.status === 1) { flash(`Le siège ${s.label} est déjà occupé.`); return; }
  if (s.status === 2) {
    s.status = 0; state.basket = state.basket.filter((x) => x !== s);
    if (state.touch) flash(`Siège ${s.label} retiré.`);
  } else {
    if (state.basket.length >= MAX_PAX) { flash(`Jusqu'à ${MAX_PAX} voyageurs par réservation.`); return; }
    s.status = 2; state.basket.push(s);
    if (state.touch) flash(`Siège ${s.label} ajouté.`);
  }
  paint(s.cab); refreshGlow(); renderSheet(); renderBasket(); renderSeatbar(); renderPass();
}
function bestSeats(cab, n, pref) {
  let best = null;
  cab.rows.forEach((row, ri) => {
    const blocks = new Map();
    row.seats.forEach((s) => { if (!blocks.has(s.block)) blocks.set(s.block, []); blocks.get(s.block).push(s); });
    const consider = (g, penalty) => {
      if (g.length < n || g.some((s) => s.status !== 0)) return;
      const hit = !pref || g.some((s) => matches(s, pref));
      let score = ri + penalty + (hit ? 0 : 30);
      if (!pref) score += g.filter((s) => s.type === 'middle').length * 1.5 + (s0(g).extra ? 2 : 0);
      if (!best || score < best.score) best = { score, g };
    };
    for (const seats of blocks.values()) for (let i = 0; i + n <= seats.length; i++) consider(seats.slice(i, i + n), 0);
    const free = row.seats.filter((s) => s.status === 0);
    if (n > 1 && free.length >= n) consider(free.slice(0, n), 8);
  });
  return best && best.g;
}
const s0 = (g) => g[0];
function findBest() {
  const cab = state.cab;
  state.basket.filter((s) => s.cab === cab).forEach((s) => { s.status = 0; });
  state.basket = state.basket.filter((s) => s.cab !== cab);
  const n = Math.min(state.qty, MAX_PAX - state.basket.length);
  const g = n > 0 ? bestSeats(cab, n, state.pref) : null;
  if (!g) flash(n > 0 ? `Pas ${n} sièges libres ensemble ici. Essayez moins de voyageurs ou une autre classe.` : `Réservation pleine (${MAX_PAX} voyageurs).`);
  else {
    g.forEach((s) => { s.status = 2; state.basket.push(s); });
    if (state.pref && !g.some((s) => matches(s, state.pref))) flash(`Plus de place « ${TYPE_LABEL[state.pref]} » libre ensemble : voici les meilleurs sièges restants.`);
    closeUp(g);
  }
  paint(cab); refreshGlow(); renderSheet(); renderBasket(); renderPass();
}

/* ------------------------------------------------------------------ */
/* Panels and the boarding pass                                        */
/* ------------------------------------------------------------------ */
function bars(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let out = '';
  for (let i = 0; i < 34; i++) { h = Math.imul(h ^ (h >>> 13), 1274126177); const v = (h >>> 0) % 5; out += v === 0 ? '<i class="s"></i>' : v === 1 ? '<i class="w"></i>' : '<i></i>'; }
  return out;
}
function passHTML(cab, seat, { name = 'Vous', ref = '' } = {}) {
  const label = seat ? seat.label : '—';
  const st = ref ? `<span class="bp-state">Réf. ${ref}</span>`
    : !seat ? '<span class="bp-state off">Choisissez un siège</span>'
      : seat.status === 1 ? '<span class="bp-state no">Occupé</span>'
        : seat.status === 2 ? '<span class="bp-state">● Votre siège</span>' : '<span class="bp-state">● Disponible</span>';
  const b = boarding(seat, cab);
  return `<article class="bp${cab.key === 'first' ? ' dark' : ''}" style="--c:${cab.color}">
    <div class="bp-top"><span>${PLANE_SVG} Carte d'embarquement <span class="cls">${cab.name}</span></span><span class="fl"><span class="w">Vol </span>${FLIGHT.no}</span></div>
    <div class="bp-body"><div class="bp-main">
      <div class="bp-route"><div><b>${FLIGHT.from}</b><small>${FLIGHT.fromCity}</small><span>${FLIGHT.dep}</span></div><div class="bp-leg"><i></i><small>Sans escale, ${FLIGHT.dur}</small></div><div class="r"><b>${FLIGHT.to}</b><small>${FLIGHT.toCity}</small><span>${FLIGHT.arr}</span></div></div>
      <dl class="bp-meta"><div><dt>Passager</dt><dd>${name}</dd></div><div><dt>Siège</dt><dd class="hl">${label}</dd></div><div><dt>Porte</dt><dd>${FLIGHT.gate}</dd></div><div><dt>Embarquement</dt><dd>${b.time}</dd></div></dl>
    </div><div class="bp-stub"><small>Siège</small><b class="bp-seat">${label}</b>${st}<div class="bars">${bars(label + cab.key)}</div><span class="bp-price">EUR ${nf.format(seat ? seatPrice(seat) : cab.base)}</span></div></div>
  </article>`;
}
function renderPass() {
  const el = $('#pass');
  if (el.hidden) return;
  const cab = state.mode === 'seat' ? state.viewSeat.cab : state.cab;
  if (!cab) return;
  const seat = state.mode === 'seat' ? state.viewSeat : state.preview || [...state.basket].reverse().find((s) => s.cab === cab) || null;
  el.innerHTML = passHTML(cab, seat);
}
function renderSheet() {
  const cab = state.cab;
  if (!cab) return;
  const mine = state.basket.filter((s) => s.cab === cab);
  $('#sh-no').textContent = `Classe 0${cab.no} / 04, ${cab.layout}`;
  $('#sh-name').textContent = cab.name;
  $('#sh-desc').textContent = cab.desc;
  $('#sh-price').textContent = money(cab.base);
  $('#sh-left').textContent = cab.free;
  $('#sh-rows').textContent = `${cab.rows[0].n}–${cab.rows[cab.rows.length - 1].n}`;
  $('#prefs').innerHTML = cab.prefs.map((p) => `<button type="button" data-pref="${p}" aria-pressed="${state.pref === p}">${TYPE_LABEL[p]}</button>`).join('');
  $('#qty').textContent = state.qty;
  $('#best').textContent = state.qty === 1 ? 'Trouver le meilleur siège' : `Trouver les ${state.qty} meilleurs sièges`;
  $('#view').textContent = mine.length ? `Voir depuis le siège ${mine[0].label}` : `Voir depuis le siège ${suggestedSeat(cab).label}`;
  $('#mine').innerHTML = mine.length
    ? mine.map((s) => `<li><span>Siège ${s.label}, ${seatKind(s)}</span><b>${money(seatPrice(s))}</b><button type="button" data-rm="${state.basket.indexOf(s)}" aria-label="Retirer le siège ${s.label}">✕</button></li>`).join('')
    : '<li class="empty">Touchez un siège en couleur, ou laissez-nous trouver le meilleur.</li>';
}
function renderSeatbar() {
  const s = state.viewSeat;
  if (state.mode !== 'seat' || !s) return;
  $('#sb-label').textContent = `${s.label}, ${s.cab.name}, ${seatKind(s)}`;
  const addBtn = $('#sb-add');
  addBtn.hidden = s.status === 1;
  addBtn.textContent = s.status === 2 ? 'Retirer ce siège' : `Ajouter ce siège, ${money(seatPrice(s))}`;
}
function renderBasket() {
  const n = state.basket.length;
  $('#basket').hidden = n === 0 || !$('#checkout').hidden;
  document.body.classList.toggle('has-basket', n > 0);
  $('#bk-count').textContent = `${n} siège${n > 1 ? 's' : ''}`;
  $('#bk-total').textContent = `${money(state.basket.reduce((a, s) => a + seatPrice(s), 0))}, taxes incluses`;
}
function openCheckout() {
  const list = state.basket;
  $('#co-lines').innerHTML = list.map((s, i) => { const b = boarding(s, s.cab); return `<li><span>Siège ${s.label}, ${s.cab.name}<small>${i === 0 ? 'Vous' : 'Voyageur ' + (i + 1)}, ${seatKind(s)}, embarquement ${b.time} (${b.group.toLowerCase()})</small></span><b>${money(seatPrice(s))}</b></li>`; }).join('');
  $('#co-total').textContent = money(list.reduce((a, s) => a + seatPrice(s), 0));
  $('#co-step1').hidden = false; $('#co-step2').hidden = true;
  $('#checkout').hidden = false; renderBasket();
  $('#co-reserve').focus();
}
function closeCheckout() { $('#checkout').hidden = true; renderBasket(); }
function reserve() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ref = Array.from({ length: 6 }, () => abc[Math.floor(rnd() * abc.length)]).join('');
  const list = [...state.basket];
  $('#co-passes').innerHTML = list.map((s, i) => passHTML(s.cab, s, { name: i === 0 ? 'Vous' : 'Voyageur ' + (i + 1), ref })).join('');
  $('#co-ref').textContent = ref;
  list.forEach((s) => { s.status = 1; });
  state.basket = []; state.preview = null;
  paintAll(); refreshGlow(); renderSheet(); renderSeatbar(); renderPass();
  $('#co-step1').hidden = true; $('#co-step2').hidden = false;
}

/* ------------------------------------------------------------------ */
/* Class labels floating over the cabins                               */
/* ------------------------------------------------------------------ */
const labels = CABINS.map((cab) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cab-label'; b.style.setProperty('--c', cab.color);
  b.textContent = cab.key === 'prem' ? 'Premium' : cab.name;
  b.addEventListener('click', () => openCabin(cab));
  document.body.appendChild(b);
  return { cab, el: b, p: new V3() };
});
function placeLabels(show) {
  for (const l of labels) {
    l.p.set(l.cab.mid, 1.6, 0).project(camera);
    const on = show && l.p.z < 1;
    l.el.hidden = !on;
    if (on) l.el.style.transform = `translate(${(l.p.x + 1) / 2 * innerWidth}px, ${(1 - l.p.y) / 2 * innerHeight}px) translate(-50%, -50%)`;
  }
}

/* ------------------------------------------------------------------ */
/* Pointer                                                             */
/* ------------------------------------------------------------------ */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let roofLevel = 1;
function pick(x, y) {
  ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (state.mode === 'seat') return null;
  if (state.mode === 'cabin' && state.cab) {
    const hit = ray.intersectObjects(state.cab.pickMeshes, false)[0];
    if (hit) return { cab: state.cab, seat: state.cab.seats[hit.instanceId] };
  }
  if (roofLevel > 0.5) { if (ray.intersectObjects(hull, false)[0]) return { hull: true }; }
  for (const h of ray.intersectObjects(overlays, false)) { const cab = h.object.userData.cab; if (cab !== state.cab) return { cab }; }
  return null;
}
const tip = $('#tip');
function setHover(h, e) {
  for (const cab of CABINS) cab.hover.visible = false;
  state.hover = h && !h.seat && !h.hull ? h.cab : null;
  const prev = state.preview;
  state.preview = h && h.seat ? h.seat : null;
  if (h && h.seat && h.seat.status !== 1) { seatMatrix(h.seat, 1.06, h.cab.hover.matrix); h.cab.hover.visible = true; }
  if (prev !== state.preview) renderPass();
  canvas.style.cursor = h ? 'pointer' : '';
  if (!h || !e || state.touch) { tip.hidden = true; return; }
  if (h.hull) tip.innerHTML = '<b>Ouvrir l’avion</b><span>Voir les cabines et les sièges</span>';
  else if (h.seat) { const s = h.seat; tip.innerHTML = `<b>Siège ${s.label}</b><span>${seatKind(s)}</span><span>${s.status === 1 ? 'Occupé' : s.status === 2 ? 'Le vôtre, touchez pour retirer' : money(seatPrice(s)) + ', touchez pour choisir'}</span>`; }
  else tip.innerHTML = `<b>${h.cab.name}</b><span>${h.cab.layout}, ${h.cab.seats.length} sièges</span><span>${h.cab.free} libres, dès ${money(h.cab.base)}</span>`;
  tip.hidden = false;
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  tip.style.transform = `translate(${Math.max(12, Math.min(e.clientX + 18, innerWidth - w - 12))}px, ${Math.max(12, Math.min(e.clientY + 18, innerHeight - ht - 12))}px)`;
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
    if (fly || down) { setHover(null); return; }
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
  if (!h) return;
  if (h.hull) { if (state.mode === 'cabin') openCabin(state.cab); else { const o = overviewPose(); limits('overview', o.D); flyTo(o.pos, o.target, { dur: 1.6 }); } return; }
  if (h.seat) { toggleSeat(h.seat); if (state.touch) { state.preview = h.seat; renderPass(); } return; }
  openCabin(h.cab);
});

/* ------------------------------------------------------------------ */
/* Controls wiring                                                     */
/* ------------------------------------------------------------------ */
document.querySelectorAll('[data-cabin]').forEach((b) => {
  const cab = byKey.get(b.dataset.cabin);
  b.addEventListener('click', () => openCabin(cab));
  b.addEventListener('pointerenter', () => { state.listHover = cab; });
  b.addEventListener('pointerleave', () => { state.listHover = null; });
});
$('#sh-close').addEventListener('click', toOverview);
$('#prefs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pref]');
  if (!b) return;
  state.pref = state.pref === b.dataset.pref ? null : b.dataset.pref;
  paint(state.cab); renderSheet();
});
$('#q-minus').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); renderSheet(); });
$('#q-plus').addEventListener('click', () => { state.qty = Math.min(MAX_PAX, state.qty + 1); renderSheet(); });
$('#best').addEventListener('click', findBest);
$('#view').addEventListener('click', () => enterSeat(state.basket.find((s) => s.cab === state.cab) || suggestedSeat(state.cab)));
$('#mine').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) toggleSeat(state.basket[+b.dataset.rm]); });
$('#sb-add').addEventListener('click', () => toggleSeat(state.viewSeat));
$('#sb-back').addEventListener('click', () => openCabin(state.viewSeat.cab));
$('#bk-go').addEventListener('click', openCheckout);
$('#co-reserve').addEventListener('click', reserve);
$('#checkout').addEventListener('click', (e) => { if (e.target.id === 'checkout' || e.target.closest('[data-close]')) closeCheckout(); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#checkout').hidden) closeCheckout();
  else if (state.mode === 'seat') openCabin(state.viewSeat.cab);
  else if (state.mode === 'cabin') toOverview();
});
const panelsRO = new ResizeObserver(() => aimView());
['#intro', '#sheet', '#seatbar', '#basket', '#pass'].forEach((s) => panelsRO.observe($(s)));
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  aimView();
}
addEventListener('resize', resize);

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */
const clock = new THREE.Clock();
const tmp = new V3();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  stepFly(dt);
  if (!fly) controls.update();
  sky.position.copy(camera.position);

  const elev = tmp.subVectors(camera.position, controls.target).normalize().y;
  const want = state.mode === 'seat' ? 1 : 1 - THREE.MathUtils.smoothstep(elev, 0.3, 0.5);
  roofLevel += (want - roofLevel) * Math.min(1, dt * 10);
  for (const m of roofMats) { m.opacity = roofLevel; m.depthWrite = roofLevel > 0.98; }
  roofGroup.visible = roofLevel > 0.01;

  for (const cab of CABINS) {
    const hot = cab === state.hover || cab === state.listHover;
    const w = cab === state.cab ? 0 : hot ? 0.34 : 0;
    cab.glowLevel += (w - cab.glowLevel) * Math.min(1, dt * 12);
    cab.overlay.material.opacity = cab.glowLevel;
    cab.overlay.visible = cab.glowLevel > 0.004;
  }
  document.querySelectorAll('[data-cabin]').forEach((b) => b.classList.toggle('hot', b.dataset.cabin === (state.hover && state.hover.key)));
  placeLabels(state.mode === 'overview' && !fly && roofLevel < 0.4);

  if (!reduceMotion) {
    for (const l of cloudLayers) l.map.offset.x += l.speed * dt;
    for (const p of puffs) { p.position.x -= 9 * dt; if (p.position.x < -600) p.position.x += 1200; }
  }

  camera.near = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.003, 0.03, 1);
  view.ox += (view.tx - view.ox) * Math.min(1, dt * 8);
  view.oy += (view.ty - view.oy) * Math.min(1, dt * 8);
  camera.setViewOffset(innerWidth, innerHeight, -view.ox, -view.oy, innerWidth, innerHeight);
  camera.updateProjectionMatrix();

  composer.render();
  window.__planeBusy = !!fly;
  if (!window.__planeReady) { window.__planeReady = true; $('#loader').classList.add('gone'); }
}

paintAll();
resize();
ui();
{
  const ext = exteriorPose();
  camera.position.copy(ext.pos); controls.target.copy(ext.target); camera.lookAt(ext.target);
  aimView(); view.ox = view.tx; view.oy = view.ty;
  limits('overview', 120);
  const wanted = byKey.get((location.hash.match(/^#cabine-(\w+)$/) || [])[1]);
  setTimeout(() => {
    const o = overviewPose(); limits('overview', o.D);
    flyTo(o.pos, o.target, { dur: 3.2, fov: 40, after: () => { if (wanted) openCabin(wanted); } });
  }, reduceMotion ? 0 : 1400);
}
renderer.setAnimationLoop(frame);
