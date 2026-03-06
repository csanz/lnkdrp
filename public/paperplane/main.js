// Use an ESM CDN that rewrites bare imports (e.g. "three") so we don't need an importmap.
import * as THREE from "https://esm.sh/three@0.160.0";
import { GLTFLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { feature as topoFeature } from "https://esm.sh/topojson-client@3.1.0";

// -----------------------------------------------------------------------------
// Global configuration (tunable knobs)
// -----------------------------------------------------------------------------
const CONFIG = {
  // Assets
  GLB_URL: "https://svmsosyeuyawzaqr.public.blob.vercel-storage.com/graphics/paper_plane_asset.glb",

  // Debug / tuning
  // When enabled: allow pointer interaction + unlock plane drag/rotate; release prints params.
  DEBUG_CONTROLS: false,

  // Scene / camera
  // Black background (matches the landing page).
  SCENE_BG: "#050506",
  CAMERA_FOV: 45,
  CAMERA_NEAR: 0.1,
  CAMERA_FAR: 1000,
  CAMERA_INITIAL_POS: { x: 0, y: 1.2, z: 4.2 },
  CAMERA_DISTANCE_MULT: 2.15, // bigger => smaller on screen
  // Used to shift the framed camera left/right after model load.
  // 0 = centered.
  RIGHT_OFFSET_MULT: 0.0,

  // Plane pose + placement
  PLANE_BASE_POS: { x: 0.876, y: -0.096, z: 0 },
  // Small global nudge down for nicer framing on the home page.
  PLANE_HEIGHT_OFFSET: -0.035,
  LOCKED_YAW: 1.183009,
  BASE_PITCH: 0.310812,
  BASE_ROLL: -0.25,
  // Lock the airplane in place (disable user move/rotate). Globe drag (alt/option) still works.
  PLANE_LOCKED: true,

  // Plane material (configurable)
  PLANE_COLOR: "#ffffff",
  // Brighter emissive so the plane reads "whiter" under lighting.
  PLANE_EMISSIVE: "#ffffff",
  PLANE_EMISSIVE_INTENSITY: 0.6,
  // Plane outline (helps it read on a dark background)
  PLANE_OUTLINE_ENABLED: true,
  PLANE_OUTLINE_COLOR: 0x6b7280, // gray-500 (brighter)
  PLANE_OUTLINE_OPACITY: 0.88,
  // Lower = more edges included (more pronounced outline)
  PLANE_OUTLINE_THRESHOLD_ANGLE: 18,

  // Plane speed tuning (single knob)
  // 0 = slower, 10 = much faster
  SPEED_MODE: 10, // 0..10
  SPEED_MULT_MIN: 0.7,
  SPEED_MULT_MAX: 8.0,
  PLANE_WOBBLE_SPEED_MULT_BASE: 1.15,

  // Make the plane feel like it "glides" more than it "wobbles".
  PLANE_WOBBLE_PHASE: 0.6, // lower = slower wobble cadence
  PLANE_WOBBLE_INTENSITY: 0.32, // lower = less motion

  // Globe
  GLOBE_POS: { x: 4, y: -7.5, z: 0 },
  GLOBE_SCALE: 6,
  // Higher segments => smoother horizon/rim line (less "uneven" faceting).
  GLOBE_WIDTH_SEGMENTS: 160,
  GLOBE_HEIGHT_SEGMENTS: 120,
  GLOBE_OFFSET_BELOW: 1.25,
  GLOBE_SPIN_SPEED: 0.00005,
  // Globe spin is independent of SPEED_MODE.
  GLOBE_SPIN_MULT: 5.0,
  // Rotate the map on startup so outlines are visible sooner (doesn't change spin direction).
  // Bias toward the Americas (US + South America) being in view.
  // "Higher to the right" = a bit more upward tilt (x) and a bit more yaw (y).
  // Move Americas a bit more toward the middle.
  GLOBE_INITIAL_ROT: { x: 0.24, y: 4.05, z: 0 },

  // Globe material (configurable)
  GLOBE_COLOR: "#050506",
  GLOBE_EMISSIVE: "#000000",
  // Boosted so the globe reads white even under the spotlight shadow.
  GLOBE_EMISSIVE_INTENSITY: 0.0,
  GLOBE_RIM_COLOR: 0x3a3a3a,
  // Rim/edge band "thinness" controls.
  // Lower opacities + smaller scale multipliers = thinner/less prominent edge.
  GLOBE_RIM_OPACITY: 0.04,
  // Soft rim = a subtle "blur/feather" around the edge.
  GLOBE_RIM_SOFT_COLOR: 0x6b7280, // gray-500
  GLOBE_RIM_SOFT_OPACITY: 0.035,
  GLOBE_RIM_SCALE: 1.004,
  GLOBE_RIM_SOFT_SCALE: 1.012,
  // Light borders so they read on the black globe.
  GLOBE_BORDERS_COLOR: 0xe5e7eb,
  // "Thinner" looking borders (WebGL line width is effectively fixed ~1px in most browsers).
  GLOBE_BORDERS_OPACITY: 0.28,
  // How far above the globe surface the borders are drawn (to avoid z-fighting).
  // Lower values reduce "edge bumps" where borders peek over the horizon.
  GLOBE_BORDERS_LIFT: 1.0006,

  // Wind streaks
  WIND_ENABLED: true,
  WIND_AXIS_Z: -1,
  WIND_STREAK_COUNT: 10,
  // Wind motion speed only (keeps color/style unchanged)
  WIND_SPEED_MULT: 0.55, // lower = slower wind drift
  // Separate speed knob for the wind streaks (independent of plane speed).
  // 0 = slower, 10 = much faster
  WIND_SPEED_MODE: 6, // 0..10
  WIND_SPEED_MULT_MIN: 0.5,
  WIND_SPEED_MULT_MAX: 3.5,
  // WebGL lines are effectively 1px in most browsers; fake "thickness" by drawing
  // a few parallel offset lines (flat spaghetti feel).
  WIND_THICKNESS: 0.024, // world units
  WIND_LAYERS: 3, // 1=thin, 3=thicker
  WIND_POINTS: 28,
  // Dark gray wind for black background.
  WIND_COLOR: 0x374151,
  // Flow tuning (lower freq => smoother flow).
  WIND_WIGGLE_AMP: 0.028,
  WIND_WIGGLE_TIME_X: 0.95,
  WIND_WIGGLE_TIME_Y: 1.05,
  WIND_WIGGLE_U_X: 2.6,
  WIND_WIGGLE_U_Y: 2.2,

  // Trails (subtle contrails)
   TRAIL_ENABLED: false,
  TRAIL_POINTS: 34, // higher = longer trail
  TRAIL_OPACITY: 0.12,
  TRAIL_HEAD_LERP: 0.55, // 0..1, higher = smoother
  TRAIL_COLOR: 0xe5e7eb,
  TRAIL_TAIL_Z_SIGN: 1,

  // Borders data resolution
  BORDERS_RES: "110m",

  // Lighting
  AMBIENT_INTENSITY: 0.75,
  DIR_INTENSITY: 1.0,

  // Shadow (focused spotlight for smaller/more controllable plane shadow on globe)
  SHADOW_SPOT_INTENSITY: 0.9,
  SHADOW_SPOT_ANGLE: 0.42,
  SHADOW_SPOT_PENUMBRA: 0.55,
  SHADOW_SPOT_DECAY: 2,
  SHADOW_SPOT_DISTANCE: 40,
  SHADOW_MAP_SIZE: 2048,
  SHADOW_BIAS: -0.00025,
  SHADOW_NORMAL_BIAS: 0.03,
  SHADOW_NEAR: 0.5,
  SHADOW_FAR: 45,

  // Light positioning relative to the globe each frame
  DIR_LIGHT_OFFSET: { x: 0.6, y: 6.0, z: 3.5 },
  SHADOW_LIGHT_OFFSET: { x: 0.15, y: 10.0, z: 2.2 },
};

// -----------------------------------------------------------------------------
// Derived values + mutable state (initialized from CONFIG)
// -----------------------------------------------------------------------------
const GLB_URL = CONFIG.GLB_URL;

const CAMERA_DISTANCE_MULT = CONFIG.CAMERA_DISTANCE_MULT;
const RIGHT_OFFSET_MULT = CONFIG.RIGHT_OFFSET_MULT;

const PLANE_BASE_POS = CONFIG.PLANE_BASE_POS;
const GLOBE_POS = CONFIG.GLOBE_POS;
const PLANE_HEIGHT_OFFSET = CONFIG.PLANE_HEIGHT_OFFSET;

let LOCKED_YAW = CONFIG.LOCKED_YAW;
let BASE_PITCH = CONFIG.BASE_PITCH;
let BASE_ROLL = CONFIG.BASE_ROLL;

const SPEED_MODE = CONFIG.SPEED_MODE;
function speedMultFromMode(mode) {
  const m = THREE.MathUtils.clamp(mode, 0, 10) / 10;
  // Exponential mapping so the knob has noticeable impact across the range.
  return CONFIG.SPEED_MULT_MIN * Math.pow(CONFIG.SPEED_MULT_MAX / CONFIG.SPEED_MULT_MIN, m);
}
const SPEED_MULT = speedMultFromMode(SPEED_MODE);
const PLANE_WOBBLE_SPEED_MULT = CONFIG.PLANE_WOBBLE_SPEED_MULT_BASE * SPEED_MULT;

function windMultFromMode(mode) {
  const m = THREE.MathUtils.clamp(mode, 0, 10) / 10;
  return CONFIG.WIND_SPEED_MULT_MIN * Math.pow(CONFIG.WIND_SPEED_MULT_MAX / CONFIG.WIND_SPEED_MULT_MIN, m);
}
const WIND_SPEED_MODE = CONFIG.WIND_SPEED_MODE;
const WIND_SPEED_EFFECTIVE = windMultFromMode(WIND_SPEED_MODE);

const WIND_ENABLED = CONFIG.WIND_ENABLED;
const WIND_SPEED_MULT = CONFIG.WIND_SPEED_MULT;
const WIND_AXIS_Z = CONFIG.WIND_AXIS_Z;
const WIND_THICKNESS = CONFIG.WIND_THICKNESS;
const WIND_LAYERS = CONFIG.WIND_LAYERS;

const TRAIL_ENABLED = CONFIG.TRAIL_ENABLED;
const TRAIL_POINTS = CONFIG.TRAIL_POINTS;
const TRAIL_OPACITY = CONFIG.TRAIL_OPACITY;
const TRAIL_HEAD_LERP = CONFIG.TRAIL_HEAD_LERP;
const TRAIL_COLOR = CONFIG.TRAIL_COLOR;
const TRAIL_TAIL_Z_SIGN = CONFIG.TRAIL_TAIL_Z_SIGN;

const GLOBE_SCALE = CONFIG.GLOBE_SCALE;
const GLOBE_OFFSET_BELOW = CONFIG.GLOBE_OFFSET_BELOW;
const GLOBE_SPIN_SPEED = CONFIG.GLOBE_SPIN_SPEED;
const GLOBE_SPIN_MULT = CONFIG.GLOBE_SPIN_MULT;
const GLOBE_SPIN_SPEED_EFFECTIVE = GLOBE_SPIN_SPEED * GLOBE_SPIN_MULT;
const DEBUG_CONTROLS =
  CONFIG.DEBUG_CONTROLS ||
  (() => {
    try {
      const q = new URL(window.location.href).searchParams;
      return q.has("debug") || q.get("debug") === "1";
    } catch {
      return false;
    }
  })();
// Keep plane locked on the home page, but allow interactive tuning in debug mode.
const PLANE_LOCKED = DEBUG_CONTROLS ? false : CONFIG.PLANE_LOCKED;

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const setStatus = (msg) => {
  if (statusTextEl) statusTextEl.textContent = msg;
  // Fallback (older markup): statusEl was just a text node.
  else if (statusEl) statusEl.textContent = msg;
};

// Land/continents loading state (helps avoid "silent blank globe").
let landLoaded = false;
let landLoadError = null;

// Make failures obvious even if module imports succeed but runtime fails.
window.addEventListener("error", (e) => {
  console.error(e?.error || e);
  setStatus(`Error: ${e?.message || "see console"}`);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(e?.reason || e);
  setStatus("Unhandled promise rejection (see console).");
});

console.log("[paperplane] main.js loaded");
setStatus(
  DEBUG_CONTROLS
    ? "Debug controls on: drag=move plane, alt/option+drag=move globe, shift+drag=rotate. Release to print params."
    : "Initializing renderer…"
);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x050506, 1);
// Default: make canvas visual-only (overlay/click-through).
// Debug: allow pointer interaction for tuning (drag to move/rotate + print params).
renderer.domElement.style.position = "fixed";
renderer.domElement.style.inset = "0";
renderer.domElement.style.pointerEvents = DEBUG_CONTROLS ? "auto" : "none";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.SCENE_BG);

const camera = new THREE.PerspectiveCamera(
  CONFIG.CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  CONFIG.CAMERA_NEAR,
  CONFIG.CAMERA_FAR
);
camera.position.set(CONFIG.CAMERA_INITIAL_POS.x, CONFIG.CAMERA_INITIAL_POS.y, CONFIG.CAMERA_INITIAL_POS.z);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, CONFIG.AMBIENT_INTENSITY));
const dir = new THREE.DirectionalLight(0xffffff, CONFIG.DIR_INTENSITY);
dir.position.set(3, 7, 4);
// Use the directional light for overall illumination (no shadow)…
dir.castShadow = false;
scene.add(dir);
scene.add(dir.target);

// …and a focused spotlight for a smaller/more controllable plane shadow on the globe.
const shadowLight = new THREE.SpotLight(0xffffff, CONFIG.SHADOW_SPOT_INTENSITY);
shadowLight.castShadow = true;
shadowLight.angle = CONFIG.SHADOW_SPOT_ANGLE; // narrower cone => smaller shadow footprint
shadowLight.penumbra = CONFIG.SHADOW_SPOT_PENUMBRA;
shadowLight.decay = CONFIG.SHADOW_SPOT_DECAY;
shadowLight.distance = CONFIG.SHADOW_SPOT_DISTANCE;
shadowLight.shadow.mapSize.set(CONFIG.SHADOW_MAP_SIZE, CONFIG.SHADOW_MAP_SIZE);
shadowLight.shadow.bias = CONFIG.SHADOW_BIAS;
shadowLight.shadow.normalBias = CONFIG.SHADOW_NORMAL_BIAS;
shadowLight.shadow.camera.near = CONFIG.SHADOW_NEAR;
shadowLight.shadow.camera.far = CONFIG.SHADOW_FAR;
scene.add(shadowLight);
scene.add(shadowLight.target);

// Pivot group: lock yaw so it always faces "backwards", while animating roll/pitch + drift.
const planePivot = new THREE.Group();
// Orientation tuning (these set the *base* direction; animation adds subtle motion on top).
// Yaw: left/right, Pitch: up/down, Roll: bank.
// Defaults captured from your preferred pose.
planePivot.rotation.set(BASE_PITCH, LOCKED_YAW, BASE_ROLL);
scene.add(planePivot);

// Wind streaks around the plane (tiny "strings" that drift past it).
const windGroup = new THREE.Group();
planePivot.add(windGroup);

// Wind axis in plane-local space. Flip this between 1 and -1 if you want the opposite direction.
const windStreaks = [];

function makeWindStreak() {
  // Slightly stronger by default on dark backgrounds.
  const baseOpacity = 0.12 + Math.random() * 0.12;
  const points = CONFIG.WIND_POINTS;

  const lines = [];
  const positionsList = [];
  for (let i = 0; i < WIND_LAYERS; i++) {
  const positions = new Float32Array(points * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    // Keep wind lines gray (not white)
      color: CONFIG.WIND_COLOR,
    transparent: true,
    opacity: baseOpacity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  line.renderOrder = 10;
    windGroup.add(line);
    lines.push(line);
    positionsList.push(positions);
  }

  const streak = {
    lines,
    positionsList,
    points,
    // randomized params
    speed: 0.25 + Math.random() * 0.55,
    length: 1.05 + Math.random() * 1.0,
    // Spread farther around the plane (so it feels like surrounding airflow, not a tight cluster).
    baseX: (Math.random() - 0.5) * 1.2,
    baseY: (Math.random() - 0.5) * 0.85,
    radiusX: 0.55 + Math.random() * 0.95,
    radiusY: 0.22 + Math.random() * 0.55,
    zSpan: 1.25 + Math.random() * 0.9,
    phase: Math.random() * 10,
    // bias to sit behind the plane (more negative => further behind when WIND_AXIS_Z = -1)
    offsetZ: -0.25 - Math.random() * 1.25,
    curve: 0.18 + Math.random() * 0.44,
    tilt: (Math.random() - 0.5) * 0.22,
    baseOpacity,
    prevProg: 0,
  };

  return streak;
}

for (let i = 0; i < CONFIG.WIND_STREAK_COUNT; i++) windStreaks.push(makeWindStreak());

// Light contrails from the back "tips" of the plane (very subtle).
let trailEmittersLocal = null; // [Vector3, Vector3] in modelGroup local space

const trailGroup = new THREE.Group();
scene.add(trailGroup);

function makeTrailLine() {
  // Use segments (with gaps) so the trail never reads as two long straight lines.
  const segments = Math.max(10, Math.floor(TRAIL_POINTS / 2));
  const positions = new Float32Array(segments * 2 * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: TRAIL_COLOR,
    transparent: true,
    opacity: TRAIL_OPACITY,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.LineSegments(geom, mat);
  line.frustumCulled = false;
  line.renderOrder = 9;
  trailGroup.add(line);
  return { line, positions, segments };
}

const trailA = makeTrailLine();
const trailB = makeTrailLine();

// Low-poly "globe" below the plane, rotating along the plane's pointing direction.
const globePivot = new THREE.Group();
globePivot.visible = false; // show after model loads
scene.add(globePivot);

// Earth-like globe: white sphere + country border outlines (black).
const globeSpin = new THREE.Group();
globePivot.add(globeSpin);
// Keep globeSpin unrotated so its spin direction stays consistent.
// Apply map-facing bias to a child group instead.
const globeMap = new THREE.Group();
globeMap.rotation.set(CONFIG.GLOBE_INITIAL_ROT.x, CONFIG.GLOBE_INITIAL_ROT.y, CONFIG.GLOBE_INITIAL_ROT.z);
globeSpin.add(globeMap);

const globeSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, CONFIG.GLOBE_WIDTH_SEGMENTS, CONFIG.GLOBE_HEIGHT_SEGMENTS),
  // Unlit so the globe color stays true on a black background.
  new THREE.MeshBasicMaterial({
    color: new THREE.Color(CONFIG.GLOBE_COLOR),
  })
);
globeSphere.scale.setScalar(GLOBE_SCALE);
globeSphere.receiveShadow = false;
globeMap.add(globeSphere);

// Subtle rim/outline so the globe circumference reads as "connected".
const globeRim = new THREE.Mesh(
  new THREE.SphereGeometry(1, CONFIG.GLOBE_WIDTH_SEGMENTS, CONFIG.GLOBE_HEIGHT_SEGMENTS),
  new THREE.MeshBasicMaterial({
    color: CONFIG.GLOBE_RIM_COLOR,
    transparent: true,
    opacity: CONFIG.GLOBE_RIM_OPACITY,
    side: THREE.BackSide,
    depthWrite: false,
  })
);
globeRim.scale.setScalar(GLOBE_SCALE * CONFIG.GLOBE_RIM_SCALE);
globeRim.renderOrder = 0;
globeSphere.renderOrder = 1;
globeMap.add(globeRim);

// Extra soft rim layer to make the edge feel blurrier/feathered (still thin).
const globeRimSoft = new THREE.Mesh(
  new THREE.SphereGeometry(1, CONFIG.GLOBE_WIDTH_SEGMENTS, CONFIG.GLOBE_HEIGHT_SEGMENTS),
  new THREE.MeshBasicMaterial({
    color: CONFIG.GLOBE_RIM_SOFT_COLOR,
    transparent: true,
    opacity: CONFIG.GLOBE_RIM_SOFT_OPACITY,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
);
globeRimSoft.scale.setScalar(GLOBE_SCALE * CONFIG.GLOBE_RIM_SOFT_SCALE);
globeRimSoft.renderOrder = -1;
globeMap.add(globeRimSoft);

// Add a faint additive "halo" outside the silhouette to make the rim read as glowing.
// Keep depthTest enabled so the glow doesn't wash over the globe face.
const globeRimGlow = new THREE.Mesh(
  new THREE.SphereGeometry(1, CONFIG.GLOBE_WIDTH_SEGMENTS, CONFIG.GLOBE_HEIGHT_SEGMENTS),
  new THREE.MeshBasicMaterial({
    color: 0xe5e7eb, // gray-200 (slightly cooler/brighter than the soft rim)
    transparent: true,
    opacity: 0.018,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
);
globeRimGlow.scale.setScalar(GLOBE_SCALE * 1.032);
globeRimGlow.renderOrder = -2;
globeMap.add(globeRimGlow);

// Softer/lighter outlines so the globe doesn't dominate the scene.
const bordersMat = new THREE.LineBasicMaterial({
  color: CONFIG.GLOBE_BORDERS_COLOR,
  transparent: true,
  opacity: CONFIG.GLOBE_BORDERS_OPACITY,
});
let bordersLines = null;
let landFillMesh = null;

function lonLatToVec3(lon, lat, r) {
  // Standard equirectangular lon/lat to sphere surface conversion.
  const lonRad = THREE.MathUtils.degToRad(lon);
  const latRad = THREE.MathUtils.degToRad(lat);
  const x = -r * Math.cos(latRad) * Math.cos(lonRad);
  const z = r * Math.cos(latRad) * Math.sin(lonRad);
  const y = r * Math.sin(latRad);
  return new THREE.Vector3(x, y, z);
}

async function loadCountryBorders() {
  // Continents/coastlines only (no country borders): use world-atlas "land".
  // Options: "110m" (smallest), "50m" (recommended), "10m" (largest).
  //
  // Important: some deployments enforce CSP rules that block a specific CDN.
  // Try a couple of common CDNs to avoid the globe appearing "blank".
  const topoUrls = [
    // Prefer local copy (avoids CSP/CDN issues entirely).
    new URL(`./land-${CONFIG.BORDERS_RES}.json`, window.location.href).toString(),
    `https://cdn.jsdelivr.net/npm/world-atlas@2/land-${CONFIG.BORDERS_RES}.json`,
    `https://unpkg.com/world-atlas@2/land-${CONFIG.BORDERS_RES}.json`,
  ];

  async function fetchJsonWithFallback(urls) {
    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Failed to fetch land topojson from all CDNs: ${lastErr?.message || lastErr}`);
  }

  function lonLatToXY(lon, lat, w, h) {
    // Equirectangular mapping:
    // lon: -180..180 => x: 0..w
    // lat:  90..-90 => y: 0..h
    const x = ((lon + 180) / 360) * w;
    const y = ((90 - lat) / 180) * h;
    return { x, y };
  }

  function ringToPath(ctx, ring, w, h) {
    if (!Array.isArray(ring) || ring.length < 2) return;
    let prevLon = null;
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (!pt || pt.length < 2) continue;
      const lon = pt[0];
      const lat = pt[1];

      // Simple dateline wrap handling: break the subpath when we jump across the map.
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
        // Start a new subpath to avoid drawing a long line across the entire map.
        prevLon = lon;
        const p = lonLatToXY(lon, lat, w, h);
        ctx.moveTo(p.x, p.y);
        continue;
      }
      prevLon = lon;

      const p = lonLatToXY(lon, lat, w, h);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
  }

  function makeLandAlphaTexture(landGeoms) {
    const canvas = document.createElement("canvas");
    // Higher = crisper coastline edges.
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create 2D canvas context for land mask");

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";

    // Draw all polygons into the alpha mask. Holes are handled via even-odd fill.
    const drawPolygon = (poly) => {
      if (!Array.isArray(poly) || poly.length === 0) return;
      ctx.beginPath();
      for (const ring of poly) {
        ringToPath(ctx, ring, canvas.width, canvas.height);
      }
      ctx.closePath();
      ctx.fill("evenodd");
    };

    for (const landGeom of landGeoms) {
      if (!landGeom) continue;
      if (landGeom.type === "Polygon") {
        drawPolygon(landGeom.coordinates);
      } else if (landGeom.type === "MultiPolygon") {
        for (const poly of landGeom.coordinates) drawPolygon(poly);
      } else {
        // Don't fail the whole globe for an unsupported geometry; just skip it.
        console.warn("[paperplane] skipping unsupported land geometry type:", landGeom.type);
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    // This is non-color data (used as alpha), so keep it in "no colorspace".
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  const topo = await fetchJsonWithFallback(topoUrls);

  const obj = topo.objects?.land;
  if (!obj) throw new Error("Unexpected topojson format: missing objects.land");

  const land = topoFeature(topo, obj);
  // topojson-client returns FeatureCollection for GeometryCollection.
  // Normalize into an array of GeoJSON geometries.
  let landGeoms = [];
  if (land?.type === "FeatureCollection") {
    landGeoms = (land.features || []).map((f) => f?.geometry).filter(Boolean);
  } else if (land?.type === "Feature") {
    if (land.geometry) landGeoms = [land.geometry];
  } else if (land?.type && land?.coordinates) {
    // In case a raw geometry slips through.
    landGeoms = [land];
  }
  if (!landGeoms.length) throw new Error("Unexpected land format");

  // Outlines only: we intentionally do NOT add a filled land layer.
  // (The globe is a dark sphere + thin land outlines.)

  landLoaded = true;
  landLoadError = null;
  console.log("[paperplane] land loaded");

  const positions = [];
  const r = 1.0 * GLOBE_SCALE * CONFIG.GLOBE_BORDERS_LIFT; // slightly above sphere to avoid z-fighting

  const addRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const a = lonLatToVec3(lon1, lat1, r);
      const b = lonLatToVec3(lon2, lat2, r);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    // Close ring if not already closed.
    const [lonA, latA] = ring[0];
    const [lonB, latB] = ring[ring.length - 1];
    if (lonA !== lonB || latA !== latB) {
      const a = lonLatToVec3(lonB, latB, r);
      const b = lonLatToVec3(lonA, latA, r);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };

  for (const landGeom of landGeoms) {
    if (!landGeom) continue;
    if (landGeom.type === "Polygon") {
      for (const ring of landGeom.coordinates) addRing(ring);
    } else if (landGeom.type === "MultiPolygon") {
      for (const poly of landGeom.coordinates) for (const ring of poly) addRing(ring);
    } else {
      // skip unsupported types
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (bordersLines) {
    bordersLines.geometry.dispose?.();
    globeMap.remove(bordersLines);
  }
  bordersLines = new THREE.LineSegments(geom, bordersMat);
  globeMap.add(bordersLines);
}

// Start loading borders ASAP so the globe is less likely to appear "blank" while waiting.
let countryBordersLoadStarted = false;
function ensureCountryBordersLoading() {
  if (countryBordersLoadStarted) return;
  countryBordersLoadStarted = true;
  loadCountryBorders().catch((e) => {
    landLoaded = false;
    landLoadError = e;
    console.error("[paperplane] failed to load borders:", e);
    setStatus(`Land load failed: ${e?.message || "see console"}`);
    if (statusEl) statusEl.style.display = "";
  });
}
ensureCountryBordersLoading();

// Spin around the plane's forward axis (in globePivot local space).
const FORWARD_AXIS = new THREE.Vector3(0, 0, -1);

const loader = new GLTFLoader();
let plane = null;
// Positioning (edit these to move things around)
// Tip: to move the globe "below the page", decrease GLOBE_POS.y (more negative).
const basePos = new THREE.Vector3(PLANE_BASE_POS.x, PLANE_BASE_POS.y, PLANE_BASE_POS.z);
const globeBasePos = new THREE.Vector3(GLOBE_POS.x, GLOBE_POS.y, GLOBE_POS.z);

// Drag tool:
// - drag = move plane
// - alt/option + drag = move globe
// - shift + drag (or right-click drag) = rotate plane direction (yaw/pitch)
let isDragging = false;
let lastClientX = 0;
let lastClientY = 0;
let dragMode = "move_plane"; // "move_plane" | "move_globe" | "rotate"
const tmpTarget = new THREE.Vector3();
function worldPerPixelAt(targetWorldPos) {
  const dist = camera.position.distanceTo(targetWorldPos);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const viewHeight = 2 * dist * Math.tan(fov / 2);
  const viewWidth = viewHeight * camera.aspect;
  return {
    x: viewWidth / window.innerWidth,
    y: viewHeight / window.innerHeight,
  };
}
function printParams() {
  const params = {
    PLANE_BASE_POS: { x: +basePos.x.toFixed(3), y: +basePos.y.toFixed(3), z: +basePos.z.toFixed(3) },
    GLOBE_POS: { x: +globeBasePos.x.toFixed(3), y: +globeBasePos.y.toFixed(3), z: +globeBasePos.z.toFixed(3) },
    LOCKED_YAW: +LOCKED_YAW.toFixed(6),
    BASE_PITCH: +BASE_PITCH.toFixed(6),
    BASE_ROLL: +BASE_ROLL.toFixed(6),
    CAMERA_DISTANCE_MULT,
    GLOBE_SCALE,
    GLOBE_SPIN_SPEED,
    GLOBE_OFFSET_BELOW,
    PLANE_HEIGHT_OFFSET: +PLANE_HEIGHT_OFFSET.toFixed(3),
    SPEED_MODE,
    SPEED_MULT: +SPEED_MULT.toFixed(3),
    PLANE_WOBBLE_SPEED_MULT: +PLANE_WOBBLE_SPEED_MULT.toFixed(3),
    GLOBE_SPIN_MULT: +GLOBE_SPIN_MULT.toFixed(3),
    GLOBE_SPIN_SPEED_EFFECTIVE: +GLOBE_SPIN_SPEED_EFFECTIVE.toFixed(7),
    WIND_SPEED_MODE,
    WIND_SPEED_EFFECTIVE: +WIND_SPEED_EFFECTIVE.toFixed(3),
  };
  console.log("[paperplane] params:", params);
  console.log(
    `[paperplane] paste:\\n` +
      `const PLANE_BASE_POS = { x: ${params.PLANE_BASE_POS.x}, y: ${params.PLANE_BASE_POS.y}, z: ${params.PLANE_BASE_POS.z} };\\n` +
      `const GLOBE_POS = { x: ${params.GLOBE_POS.x}, y: ${params.GLOBE_POS.y}, z: ${params.GLOBE_POS.z} };\\n` +
      `const LOCKED_YAW = ${params.LOCKED_YAW};\\n` +
      `const BASE_PITCH = ${params.BASE_PITCH};\\n` +
      `const BASE_ROLL = ${params.BASE_ROLL};\\n` +
      `const CAMERA_DISTANCE_MULT = ${params.CAMERA_DISTANCE_MULT};\\n` +
      `const GLOBE_SCALE = ${params.GLOBE_SCALE};\\n` +
      `const GLOBE_SPIN_SPEED = ${params.GLOBE_SPIN_SPEED};\\n` +
      `const GLOBE_OFFSET_BELOW = ${params.GLOBE_OFFSET_BELOW};\\n` +
      `const PLANE_HEIGHT_OFFSET = ${params.PLANE_HEIGHT_OFFSET};\\n` +
      `const SPEED_MODE = ${params.SPEED_MODE}; // 0..10\\n` +
      `// derived: const SPEED_MULT = ${params.SPEED_MULT};\\n` +
      `// derived: const PLANE_WOBBLE_SPEED_MULT = ${params.PLANE_WOBBLE_SPEED_MULT};\\n` +
      `// derived: const GLOBE_SPIN_SPEED_EFFECTIVE = ${params.GLOBE_SPIN_SPEED_EFFECTIVE};\\n` +
      `const WIND_SPEED_MODE = ${params.WIND_SPEED_MODE}; // 0..10\\n` +
      `// derived: const WIND_SPEED_EFFECTIVE = ${params.WIND_SPEED_EFFECTIVE};`
  );
}
renderer.domElement.style.touchAction = "none";
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!plane) return;
  // Lock airplane: allow only globe dragging (alt/option), disable plane move/rotate.
  if (PLANE_LOCKED && !e.altKey) return;
  isDragging = true;
  if (PLANE_LOCKED) {
    dragMode = "move_globe";
  } else {
  dragMode = e.shiftKey || e.button === 2 ? "rotate" : e.altKey ? "move_globe" : "move_plane";
  }
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!isDragging || !plane) return;
  if (PLANE_LOCKED && dragMode !== "move_globe") return;
  const dx = e.clientX - lastClientX;
  const dy = e.clientY - lastClientY;
  lastClientX = e.clientX;
  lastClientY = e.clientY;

  if (dragMode === "rotate") {
    const yawSpeed = 0.006;
    const pitchSpeed = 0.006;
    LOCKED_YAW += dx * yawSpeed;
    BASE_PITCH += dy * pitchSpeed;
    BASE_PITCH = THREE.MathUtils.clamp(BASE_PITCH, -1.25, 1.25);
    return;
  }

  tmpTarget.copy(dragMode === "move_globe" ? globePivot.position : planePivot.position);
  const wpp = worldPerPixelAt(tmpTarget);
  const target = dragMode === "move_globe" ? globeBasePos : basePos;
  target.x += dx * wpp.x;
  target.y += -dy * wpp.y;
});
function endDrag(e) {
  if (!isDragging) return;
  isDragging = false;
  try {
    renderer.domElement.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
  printParams();
}
renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);

setStatus("Loading model…");
loader.load(
  GLB_URL,
  (gltf) => {
    // Use a parent group for normalization so scaling affects centering offset too.
    const model = gltf.scene;

    // Plane material is configurable via CONFIG.
    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = false;
      const color = new THREE.Color(CONFIG.PLANE_COLOR);
      const prev = obj.material;
      // If it's an array material, replace with a single simple one.
      if (Array.isArray(prev)) {
        obj.material = new THREE.MeshStandardMaterial({
          color,
          emissive: new THREE.Color(CONFIG.PLANE_EMISSIVE),
          emissiveIntensity: CONFIG.PLANE_EMISSIVE_INTENSITY,
          metalness: 0.0,
          roughness: 0.85,
        });
      } else if (prev && prev.isMaterial) {
        // Mutate in place to preserve any texture maps.
        if (prev.color) prev.color.copy(color);
        if (prev.emissive) prev.emissive.set(CONFIG.PLANE_EMISSIVE);
        if (typeof prev.emissiveIntensity === "number")
          prev.emissiveIntensity = CONFIG.PLANE_EMISSIVE_INTENSITY;
        prev.metalness = 0.0;
        prev.roughness = 0.85;
        prev.needsUpdate = true;
      } else {
        obj.material = new THREE.MeshStandardMaterial({
          color,
          emissive: new THREE.Color(CONFIG.PLANE_EMISSIVE),
          emissiveIntensity: CONFIG.PLANE_EMISSIVE_INTENSITY,
          metalness: 0.0,
          roughness: 0.85,
        });
      }

      // Add a subtle outline so the plane reads on dark backgrounds.
      if (CONFIG.PLANE_OUTLINE_ENABLED && obj.geometry) {
        const edges = new THREE.EdgesGeometry(obj.geometry, CONFIG.PLANE_OUTLINE_THRESHOLD_ANGLE);
        const line = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: CONFIG.PLANE_OUTLINE_COLOR,
            transparent: true,
            opacity: CONFIG.PLANE_OUTLINE_OPACITY,
            depthTest: false,
            depthWrite: false,
          })
        );
        line.frustumCulled = false;
        line.renderOrder = 30;
        obj.add(line);
      }
    });

    // Center + scale to a predictable size.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const modelGroup = new THREE.Group();
    modelGroup.add(model);
    model.position.sub(center);

    // Approximate two rear "tip" emitters for light trails, based on the model bounds.
    // This is intentionally simple; if you want to tweak, search for TRAIL_* constants.
    const localBox = new THREE.Box3().setFromObject(model);
    const localSize = new THREE.Vector3();
    localBox.getSize(localSize);
    const tailZ = (TRAIL_TAIL_Z_SIGN >= 0 ? localBox.max.z : localBox.min.z);
    const tipY = localBox.min.y + localSize.y * 0.22;
    trailEmittersLocal = [
      new THREE.Vector3(localBox.min.x * 0.85, tipY, tailZ),
      new THREE.Vector3(localBox.max.x * 0.85, tipY, tailZ),
    ];

    const maxDim = Math.max(size.x, size.y, size.z);
    // Slightly smaller plane on screen.
    const target = 1.42;
    const s = maxDim > 0 ? target / maxDim : 1;
    // Important: scale the parent group so the model's centering offset is scaled too.
    modelGroup.scale.setScalar(s);

    // Tiny lift for nicer framing.
    modelGroup.position.y += 0.05;

    planePivot.add(modelGroup);
    basePos.copy(planePivot.position);

    // Frame camera based on the (normalized) model bounds to ensure it's visible.
    const framedBox = new THREE.Box3().setFromObject(planePivot);
    const sphere = new THREE.Sphere();
    framedBox.getBoundingSphere(sphere);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * CAMERA_DISTANCE_MULT;
    // Use RIGHT_OFFSET_MULT to shift the framed camera horizontally.
    camera.position.set(sphere.radius * RIGHT_OFFSET_MULT, sphere.radius * 0.55, dist);
    camera.near = Math.max(0.01, dist / 100);
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    // Apply default placement captured from drag.
    basePos.set(PLANE_BASE_POS.x, PLANE_BASE_POS.y, PLANE_BASE_POS.z);
    globeBasePos.set(GLOBE_POS.x, GLOBE_POS.y, GLOBE_POS.z);

    // Only hide the status banner if the land layer successfully loaded.
    // If land load failed, keep it visible so the issue is obvious.
    if (statusEl && !landLoadError && landLoaded) statusEl.style.display = "none";
    console.log("[paperplane] model loaded");
    // Keep a reference so animation waits for load.
    plane = modelGroup;
    globePivot.visible = true;

    // Globe stays fixed (anchored) under the plane's default position.
    globePivot.position.copy(globeBasePos);

    // Load border outlines once the scene is up (usually already started above).
    ensureCountryBordersLoading();
  },
  undefined,
  (err) => {
    console.error("[paperplane] failed to load GLB:", err);
    setStatus("Failed to load model (see console).");
  }
);

const clock = new THREE.Clock();
const tmpCamForward = new THREE.Vector3();
const tmpCamRight = new THREE.Vector3();
const tmpSideOffset = new THREE.Vector3();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const tw = t * PLANE_WOBBLE_SPEED_MULT * CONFIG.PLANE_WOBBLE_PHASE;

  if (plane) {
    if (WIND_ENABLED) {
      // Update wind streaks in plane-local space so they naturally follow the plane.
      const tWind = t * WIND_SPEED_MULT * WIND_SPEED_EFFECTIVE;
      for (const s of windStreaks) {
        const prog = ((tWind * s.speed + s.phase) % 1 + 1) % 1; // 0..1 loop
        const zHead = (prog - 0.5) * s.zSpan + s.offsetZ;

        // On loop, slightly re-randomize so streaks "spawn/despawn" naturally.
        if (prog < s.prevProg) {
          s.phase = Math.random() * 10;
          s.speed = 0.25 + Math.random() * 0.55;
          s.length = 1.05 + Math.random() * 1.0;
          s.radiusX = 0.32 + Math.random() * 0.55;
          s.radiusY = 0.14 + Math.random() * 0.32;
          s.zSpan = 1.25 + Math.random() * 0.9;
          s.offsetZ = -0.25 - Math.random() * 1.25;
          s.curve = 0.22 + Math.random() * 0.40;
          s.tilt = (Math.random() - 0.5) * 0.22;
        }
        s.prevProg = prog;

        // Fade in/out envelope so streaks appear/disappear.
        const fadeIn = THREE.MathUtils.smoothstep(prog, 0.0, 0.28);
        const fadeOut = 1.0 - THREE.MathUtils.smoothstep(prog, 0.58, 1.0);
        const alpha = Math.pow(fadeIn * fadeOut, 1.35); // softer falloff
        for (const ln of s.lines) {
          ln.material.opacity = s.baseOpacity * alpha;
          ln.visible = alpha > 0.02;
        }

        // Base center around the plane, with a bit of noise.
        const cx = s.baseX + Math.sin(tWind * 0.55 + s.phase) * s.radiusX;
        const cy = s.baseY + Math.cos(tWind * 0.5 + s.phase * 1.3) * s.radiusY;

        for (let i = 0; i < s.points; i++) {
          const u = i / (s.points - 1); // 0..1 tail->head

          // Make the streaks run along the plane's pointing direction (local -Z by default).
          const z = WIND_AXIS_Z * (zHead - (1 - u) * s.length);

          // Curved + tapered shape reads more like airflow.
          const taper = Math.sin(u * Math.PI); // 0 at ends, 1 at middle
          const wig = taper * CONFIG.WIND_WIGGLE_AMP;
          const x =
            cx +
            (u - 0.5) * s.tilt +
            Math.sin(tWind * CONFIG.WIND_WIGGLE_TIME_X + s.phase + u * CONFIG.WIND_WIGGLE_U_X) * wig +
            Math.sin(u * Math.PI) * s.curve;
          const y =
            cy +
            Math.cos(tWind * CONFIG.WIND_WIGGLE_TIME_Y + s.phase + u * CONFIG.WIND_WIGGLE_U_Y) * wig +
            Math.cos(u * Math.PI) * (s.curve * 0.35);

          // Offset a few parallel strokes to fake thickness.
          // Use a stable-ish 2D "normal" around the streak's center.
          let nx = -(y - cy);
          let ny = x - cx;
          const nl = Math.hypot(nx, ny) || 1;
          nx /= nl;
          ny /= nl;

          for (let li = 0; li < s.positionsList.length; li++) {
            const layerT = s.positionsList.length <= 1 ? 0 : li / (s.positionsList.length - 1);
            const layerCentered = layerT - 0.5; // -0.5..+0.5
            const off = layerCentered * WIND_THICKNESS * taper;
          const p = i * 3;
            s.positionsList[li][p + 0] = x + nx * off;
            s.positionsList[li][p + 1] = y + ny * off;
            s.positionsList[li][p + 2] = z;
          }
        }

        for (let li = 0; li < s.lines.length; li++) {
          s.lines[li].geometry.attributes.position.needsUpdate = true;
        }
      }
    }

    if (TRAIL_ENABLED && trailEmittersLocal && plane) {
      // Directional streak behind the plane tips (not a "history scribble"),
      // so it won't form tiny circles when the plane is mostly stationary.
      plane.updateWorldMatrix(true, false);

      const tmpQ = new THREE.Quaternion();
      const tmpHead = new THREE.Vector3();
      const tmpDir = new THREE.Vector3();
      const tmpSide = new THREE.Vector3();
      const tmpUp = new THREE.Vector3();

      // Length in world units (kept subtle).
      const TRAIL_LENGTH = 2.0;

      const updateStreak = (trail, emitterLocal, seed) => {
        plane.getWorldQuaternion(tmpQ);
        tmpDir.set(0, 0, TRAIL_TAIL_Z_SIGN).applyQuaternion(tmpQ).normalize(); // behind the plane
        tmpUp.set(0, 1, 0);
        tmpSide.crossVectors(tmpUp, tmpDir).normalize();
        tmpUp.crossVectors(tmpDir, tmpSide).normalize();

        tmpHead.copy(emitterLocal).applyMatrix4(plane.matrixWorld);

        // Head smoothing for softness.
        const hx = THREE.MathUtils.lerp(trail.positions[0] || tmpHead.x, tmpHead.x, 1 - TRAIL_HEAD_LERP);
        const hy = THREE.MathUtils.lerp(trail.positions[1] || tmpHead.y, tmpHead.y, 1 - TRAIL_HEAD_LERP);
        const hz = THREE.MathUtils.lerp(trail.positions[2] || tmpHead.z, tmpHead.z, 1 - TRAIL_HEAD_LERP);
        trail.positions[0] = hx;
        trail.positions[1] = hy;
        trail.positions[2] = hz;

        const posAt = (u, out) => {
          const falloff = 1 - u;
          const along = u * TRAIL_LENGTH;
          const taper = Math.sin(u * Math.PI); // 0 at ends, 1 at middle

          const wob = falloff * 0.03;
          const sx = Math.sin(t * 1.05 + seed + u * 6.0) * wob;
          const sy = Math.cos(t * 0.95 + seed + u * 5.0) * wob;

          const tipSign = Math.sign(emitterLocal.x || 1); // left/right wing tip
          const outward = tipSign * taper * falloff * 0.25;
          const arc = taper * falloff * (0.18 + 0.06 * Math.sin(t * 0.6 + seed));
          const lift = Math.cos(u * Math.PI) * falloff * 0.03;

          out.set(
            hx + tmpDir.x * along + tmpSide.x * (sx + arc + outward) + tmpUp.x * (sy + lift),
            hy + tmpDir.y * along + tmpSide.y * (sx + arc + outward) + tmpUp.y * (sy + lift),
            hz + tmpDir.z * along + tmpSide.z * (sx + arc + outward) + tmpUp.z * (sy + lift)
          );
          return out;
        };

        // Fill as short segments with gaps.
        const tmp0 = new THREE.Vector3();
        const tmp1 = new THREE.Vector3();
        for (let si = 0; si < trail.segments; si++) {
          const u0 = si / trail.segments;
          const u1 = Math.min(1, (si + 0.65) / trail.segments); // gap after each segment
          posAt(u0, tmp0);
          posAt(u1, tmp1);
          const p = si * 2 * 3;
          trail.positions[p + 0] = tmp0.x;
          trail.positions[p + 1] = tmp0.y;
          trail.positions[p + 2] = tmp0.z;
          trail.positions[p + 3] = tmp1.x;
          trail.positions[p + 4] = tmp1.y;
          trail.positions[p + 5] = tmp1.z;
        }

        trail.line.geometry.attributes.position.needsUpdate = true;
      };

      updateStreak(trailA, trailEmittersLocal[0], 0.0);
      updateStreak(trailB, trailEmittersLocal[1], 3.7);
    }

    // Subtle "flying" idle motion.
    // Prefer side-to-side glide over vertical bob/pitch (paper-plane feel).
    // Important: sway in *screen space* (camera-right), not world-X.
    // World-X can read as "up/down" because the camera is pitched.
    const swaySide = Math.sin(tw * 0.75 + 0.8) * 0.090 * CONFIG.PLANE_WOBBLE_INTENSITY;
    camera.getWorldDirection(tmpCamForward);
    tmpCamRight.crossVectors(tmpCamForward, camera.up).normalize();
    tmpSideOffset.copy(tmpCamRight).multiplyScalar(swaySide);

    planePivot.position.set(
      basePos.x + tmpSideOffset.x,
      basePos.y + PLANE_HEIGHT_OFFSET,
      basePos.z + tmpSideOffset.z
    );

    // Keep yaw fixed (backwards), only add roll/pitch.
    // Lock pitch so it doesn't "nod" up/down (paper planes glide more than they bob).
    planePivot.rotation.x = BASE_PITCH;
    // Bank into the side-to-side sway (paper-plane feel).
    const bankFromSway = swaySide * 0.18; // swaySide is in world units; keep this subtle
    planePivot.rotation.z =
      BASE_ROLL + Math.sin(tw * 0.75 + 0.2) * 0.07 * CONFIG.PLANE_WOBBLE_INTENSITY + bankFromSway;
    // Tiny yaw wiggle + a touch of "follow through" from sway.
    planePivot.rotation.y =
      LOCKED_YAW + Math.sin(tw * 0.6 + 0.4) * 0.020 * CONFIG.PLANE_WOBBLE_INTENSITY + bankFromSway * 0.22;

    // Globe stays fixed in position; align it to the plane's *base* direction (no wobble).
    globePivot.position.copy(globeBasePos);
    globePivot.rotation.set(BASE_PITCH, LOCKED_YAW, BASE_ROLL);
    dir.target.position.copy(globePivot.position);
    // Keep the directional light for general shading.
    dir.position.set(
      globePivot.position.x + CONFIG.DIR_LIGHT_OFFSET.x,
      globePivot.position.y + CONFIG.DIR_LIGHT_OFFSET.y,
      globePivot.position.z + CONFIG.DIR_LIGHT_OFFSET.z
    );
    dir.target.updateMatrixWorld();

    // Aim a narrow spotlight at the globe so the plane casts a smaller, centered shadow.
    shadowLight.target.position.copy(globePivot.position);
    shadowLight.position.set(
      globePivot.position.x + CONFIG.SHADOW_LIGHT_OFFSET.x,
      globePivot.position.y + CONFIG.SHADOW_LIGHT_OFFSET.y,
      globePivot.position.z + CONFIG.SHADOW_LIGHT_OFFSET.z
    );
    shadowLight.target.updateMatrixWorld();
    // Spin in the opposite direction.
    globeSpin.rotateOnAxis(FORWARD_AXIS, -GLOBE_SPIN_SPEED_EFFECTIVE);
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


