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
  // The vertical FOV is fixed, so a portrait-ish viewport (md tablets) would render the plane
  // much larger relative to its width. Pull the camera back until the view is at least this
  // wide relative to its height (1.15 => no change on 16:10 / 16:9 desktops; an 834x1194 md
  // tablet is pulled back ~1.6x instead of ~2.1x so the plane reads at ~130px, not a speck).
  CAMERA_MIN_ASPECT: 1.15,
  // World y the framed camera looks at. The camera itself stays slightly above the plane, so
  // pitching it down (negative) lifts the whole scene in the frame without changing the angle
  // the plane is seen from: -0.92 puts the plane in the upper-right quadrant beside the headline.
  CAMERA_LOOK_Y: -0.92,
  // Used to shift the framed camera left/right after model load.
  // 0 = centered.
  RIGHT_OFFSET_MULT: 0.0,

  // Plane pose + placement
  // x is only a fallback: the runtime derives it from PLANE_VIEW_X_FRAC so the plane sits at
  // the same horizontal fraction of the viewport at every width.
  PLANE_BASE_POS: { x: 1.65, y: -0.096, z: 0 },
  // Horizontal placement as a fraction of the visible width, measured from the viewport centre
  // (0.22 => plane centre at ~72% of the viewport width, so the nose stays within ~300px of
  // the headline's right edge even on a 1920-wide frame).
  PLANE_VIEW_X_FRAC: 0.2,
  // Vertical placement in CSS pixels from the top of the viewport to the plane's centre. The
  // headline is pixel-fixed, so anchoring the plane in pixels (not a fraction of the height) keeps
  // it at the same line of copy on 800-, 900- and 1080-tall frames alike. 430 puts it beside the
  // paragraph under the headline, over black, with the globe's rim well below it — where the
  // wind streaks read as airflow. The launch redesign had it at 700, sitting on the rim: half
  // clipped on a laptop, and the streaks vanished against the arcs.
  PLANE_VIEW_Y_PX: 430,
  // ...but never lower than this fraction of the frame, so a short laptop frame lifts it further.
  PLANE_VIEW_Y_MAX_FRAC: 0.55,
  // ...and never *higher* than this fraction. The globe's horizon is placed as a fraction of the
  // frame, so a pixel-fixed plane drifted away from it as frames got taller: 430px is 52% down an
  // 819-tall laptop frame (plane ~110px above the rim, banked) but only 43% down a 1009-tall
  // one (~240px above, and seen from above the camera's axis, so it read as flat). 0.525 is the
  // laptop framing, kept at every height above it.
  PLANE_VIEW_Y_MIN_FRAC: 0.525,
  // Fraction of the frame height the tuned PLANE_BASE_POS.y lands at on a desktop (16:10 / 16:9)
  // frame; the runtime offsets from this reference to reach PLANE_VIEW_Y_PX.
  PLANE_BASE_VIEW_Y_FRAC: 0.334,
  // Small global nudge down for nicer framing on the home page.
  PLANE_HEIGHT_OFFSET: -0.035,
  LOCKED_YAW: 1.183009,
  BASE_PITCH: 0.310812,
  BASE_ROLL: -0.25,
  // Plane-only orientation offsets (radians) on top of BASE_PITCH / LOCKED_YAW / BASE_ROLL.
  // The globe follows the BASE_* angles but NOT these, so you can tilt the plane without moving
  // the horizon. pitch > 0 lowers the nose; roll toward 0 (from -0.25) leans the plane left.
  // Tune live at /paperplane/index.html?debug=1 (arrow keys / [ ] then press C to copy).
  PLANE_ROT_OFFSET: { pitch: -0.33, yaw: -0.18, roll: 0.18 },
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
  // y follows CAMERA_LOOK_Y (the -7.5 the scene was tuned at, shifted by the camera pitch) so
  // the rim reads as a lower-right horizon inside the first viewport.
  // x: the text column's right edge is at viewport centre + ~32px at every desktop width, so the
  // rim needs a fixed world offset large enough that it crosses that edge only inside the horizon
  // fade. The offset scales with viewport *height* in px, so an 800-tall fold is the tightest:
  // 5.6 keeps the rim (including its faded tail) >= 100px right of the install panel's corner
  // there (versus the 4.0 the scene was tuned at).
  GLOBE_POS: { x: 5.6, y: -8.4, z: 0 },
  // On narrow (portrait-ish) frames the camera is pulled back; drop the globe faster than that
  // pull-back (exponent on the pull-back factor) so its rim stays in the bottom-right corner
  // instead of rising behind the text column. 1 = same fraction of the frame as on desktop (the
  // rim then enters ~70% down an 834x1194 md frame, beside the install panel, rather than leaving
  // the right half of the fold empty).
  GLOBE_NARROW_DROP: 1.0,
  // ...and push it right on those frames (world units per unit of camera pull-back) so the rim
  // that the smaller drop keeps above the horizon fade stays clear of the column.
  GLOBE_NARROW_PUSH: 0.4,
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

  // Link arcs: "share links" travelling between cities as thin great-circle flight paths.
  // Deliberately faint: the borders sit at 0.28 opacity, the arcs peak well below that, and a
  // slightly brighter head runs along each one so the eye catches motion rather than lines.
  ARCS_ENABLED: true,
  ARCS_COUNT: 6, // slots (max flights in the air at once)
  // Cadence: one new flight every ARCS_LAUNCH_EVERY seconds, like a metronome, instead of
  // per-slot random gaps. With 6 slots and ~8 s flights that keeps 4-5 in the air, evenly spaced.
  ARCS_LAUNCH_EVERY: 1.8,
  // Fraction of flights whose origin (and usually destination) is on the hemisphere facing the
  // camera and inside the viewport, so most traffic is where the reader can see it.
  ARCS_VISIBLE_BIAS: 0.85,
  ARCS_COLOR: 0xe5e7eb, // same family as the borders so they read as part of the map
  ARCS_OPACITY: 0.16, // trail (peak; the envelope fades in/out around it)
  ARCS_HEAD_OPACITY: 0.42, // the short leading segment
  ARCS_HEAD_FRAC: 0.09, // head length as a fraction of the whole arc
  ARCS_POINTS: 48, // samples per arc (1px lines need no more)
  // Apex height as a fraction of the globe radius. Each flight draws its own value from this
  // range (then scales by distance), so short hops skim the surface and long hauls vary from
  // low sweeps to high loops.
  ARCS_LIFT_MIN: 0.08,
  ARCS_LIFT_MAX: 0.24,
  ARCS_DURATION_MIN: 7.5, // seconds for one flight (draw + fade); narrow range = steady feel
  ARCS_DURATION_MAX: 9,

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
  // Same family as the borders and the arcs. It was 0x374151 (dark grey): at 12-24% opacity on
  // #050506 that is about ten brightness units above the background — present in the frame
  // buffer, invisible on a screen — and once the brighter arcs arrived beside it the wind read as
  // gone. Light grey at the same opacity lands where the arc trails do.
  WIND_COLOR: 0xd1d5db,
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
const PLANE_ROT = { ...CONFIG.PLANE_ROT_OFFSET };

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

// ---------------------------------------------------------------------------------------------
// Debug gizmo (only active with ?debug=1 on /paperplane/index.html; inert on the home page).
// - Query overrides for quick trials: ?debug=1&yaw=1.18&pitch=0.31&roll=-0.25&y=560&xfrac=0.22
// - Keys: ←/→ yaw · ↑/↓ pitch · [ / ] roll · W/S plane height (px) · A/D plane x (fraction)
//         Shift = 5× step · R = reset to CONFIG · C = copy the CONFIG lines to the clipboard
// - A readout in the bottom-left corner mirrors the values; paste them into CONFIG above.
// ---------------------------------------------------------------------------------------------
const DEBUG_QUERY = (() => {
  try {
    return new URL(window.location.href).searchParams;
  } catch {
    return null;
  }
})();
function debugNum(name) {
  const v = DEBUG_QUERY ? DEBUG_QUERY.get(name) : null;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const GIZMO_DEFAULTS = {
  yaw: CONFIG.LOCKED_YAW,
  pitch: CONFIG.BASE_PITCH,
  roll: CONFIG.BASE_ROLL,
  y: CONFIG.PLANE_VIEW_Y_PX,
  xfrac: CONFIG.PLANE_VIEW_X_FRAC,
  rot: { ...CONFIG.PLANE_ROT_OFFSET },
};
if (DEBUG_CONTROLS) {
  const yaw = debugNum("yaw");
  const pitch = debugNum("pitch");
  const roll = debugNum("roll");
  const y = debugNum("y");
  const xfrac = debugNum("xfrac");
  const dpitch = debugNum("dpitch");
  const dyaw = debugNum("dyaw");
  const droll = debugNum("droll");
  if (dpitch != null) PLANE_ROT.pitch = dpitch;
  if (dyaw != null) PLANE_ROT.yaw = dyaw;
  if (droll != null) PLANE_ROT.roll = droll;
  if (yaw != null) LOCKED_YAW = yaw;
  if (pitch != null) BASE_PITCH = pitch;
  if (roll != null) BASE_ROLL = roll;
  if (y != null) CONFIG.PLANE_VIEW_Y_PX = y;
  if (xfrac != null) CONFIG.PLANE_VIEW_X_FRAC = xfrac;
}
// Placement overrides that work WITHOUT debug mode, so an embedding page can pick a frame-
// relative position: /paperplane/index.html?yfrac=0.45&xfrac=0.02 (fractions of the frame).
// The mobile home page uses this to put the plane in a short frame at the bottom of the page.
const PLACE = { yfrac: debugNum("yfrac"), xfrac: debugNum("xfrac"), minaspect: debugNum("minaspect") };
let gizmoEl = null;
function gizmoConfigLines() {
  return (
    `  LOCKED_YAW: ${+LOCKED_YAW.toFixed(6)},\n` +
    `  BASE_PITCH: ${+BASE_PITCH.toFixed(6)},\n` +
    `  BASE_ROLL: ${+BASE_ROLL.toFixed(6)},\n` +
    `  PLANE_VIEW_Y_PX: ${Math.round(CONFIG.PLANE_VIEW_Y_PX)},\n` +
    `  PLANE_VIEW_X_FRAC: ${+CONFIG.PLANE_VIEW_X_FRAC.toFixed(3)},\n` +
    `  PLANE_ROT_OFFSET: { pitch: ${+PLANE_ROT.pitch.toFixed(3)}, yaw: ${+PLANE_ROT.yaw.toFixed(3)}, roll: ${+PLANE_ROT.roll.toFixed(3)} },`
  );
}
function updateGizmo(note) {
  if (!gizmoEl) return;
  gizmoEl.textContent =
    `gizmo  plane offsets: pitch ${PLANE_ROT.pitch.toFixed(3)}  yaw ${PLANE_ROT.yaw.toFixed(3)}  roll ${PLANE_ROT.roll.toFixed(3)}   (base ${BASE_PITCH.toFixed(2)}/${LOCKED_YAW.toFixed(2)}/${BASE_ROLL.toFixed(2)})  ` +
    `y ${Math.round(CONFIG.PLANE_VIEW_Y_PX)}px  x ${CONFIG.PLANE_VIEW_X_FRAC.toFixed(3)}` +
    (note ? `   · ${note}` : "") +
    `\n←→ yaw   ↑↓ pitch   [ ] roll   W/S height   A/D x   shift ×5   R reset   C copy CONFIG lines`;
}
if (DEBUG_CONTROLS) {
  gizmoEl = document.createElement("pre");
  gizmoEl.id = "gizmo";
  gizmoEl.style.cssText =
    "position:fixed;left:12px;bottom:12px;margin:0;padding:8px 10px;font:12px/1.5 ui-monospace,Menlo,monospace;" +
    "color:rgba(255,255,255,.85);background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);" +
    "border-radius:6px;pointer-events:none;white-space:pre;z-index:10";
  document.body.appendChild(gizmoEl);
  setTimeout(() => updateGizmo(), 300);
  window.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let handled = true;
    let note = "";
    switch (e.key) {
      case "ArrowLeft":
        PLANE_ROT.yaw -= step;
        break;
      case "ArrowRight":
        PLANE_ROT.yaw += step;
        break;
      case "ArrowUp":
        PLANE_ROT.pitch -= step;
        break;
      case "ArrowDown":
        PLANE_ROT.pitch += step;
        break;
      case "[":
        PLANE_ROT.roll -= step;
        break;
      case "]":
        PLANE_ROT.roll += step;
        break;
      case "w":
      case "W":
        CONFIG.PLANE_VIEW_Y_PX -= e.shiftKey ? 50 : 10;
        placePlane();
        break;
      case "s":
      case "S":
        CONFIG.PLANE_VIEW_Y_PX += e.shiftKey ? 50 : 10;
        placePlane();
        break;
      case "a":
      case "A":
        CONFIG.PLANE_VIEW_X_FRAC -= e.shiftKey ? 0.05 : 0.01;
        placePlane();
        break;
      case "d":
      case "D":
        CONFIG.PLANE_VIEW_X_FRAC += e.shiftKey ? 0.05 : 0.01;
        placePlane();
        break;
      case "r":
      case "R":
        LOCKED_YAW = GIZMO_DEFAULTS.yaw;
        BASE_PITCH = GIZMO_DEFAULTS.pitch;
        BASE_ROLL = GIZMO_DEFAULTS.roll;
        CONFIG.PLANE_VIEW_Y_PX = GIZMO_DEFAULTS.y;
        CONFIG.PLANE_VIEW_X_FRAC = GIZMO_DEFAULTS.xfrac;
        Object.assign(PLANE_ROT, GIZMO_DEFAULTS.rot);
        placePlane();
        note = "reset";
        break;
      case "c":
      case "C": {
        const lines = gizmoConfigLines();
        try {
          navigator.clipboard.writeText(lines);
          note = "copied";
        } catch {
          note = "copy failed (see console)";
        }
        console.log("[paperplane] CONFIG lines:\n" + lines);
        break;
      }
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    BASE_PITCH = THREE.MathUtils.clamp(BASE_PITCH, -1.25, 1.25);
    updateGizmo(note);
    printParams();
  });
}

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
planePivot.rotation.set(BASE_PITCH + PLANE_ROT.pitch, LOCKED_YAW + PLANE_ROT.yaw, BASE_ROLL + PLANE_ROT.roll);
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

// -----------------------------------------------------------------------------
// Link arcs (thin animated great-circle paths between cities)
// -----------------------------------------------------------------------------
// [lon, lat]. A spread of hubs across every continent so flights cross the visible hemisphere
// from many angles; the exact list is decorative and safe to edit.
const ARC_CITIES = [
  [-122.42, 37.77], // San Francisco
  [-73.98, 40.75], // New York
  [-79.38, 43.65], // Toronto
  [-99.13, 19.43], // Mexico City
  [-46.63, -23.55], // São Paulo
  [-58.38, -34.6], // Buenos Aires
  [-0.13, 51.51], // London
  [2.35, 48.86], // Paris
  [13.4, 52.52], // Berlin
  [-3.7, 40.42], // Madrid
  [18.07, 59.33], // Stockholm
  [34.78, 32.08], // Tel Aviv
  [55.27, 25.2], // Dubai
  [3.38, 6.52], // Lagos
  [36.82, -1.29], // Nairobi
  [18.42, -33.93], // Cape Town
  [72.88, 19.08], // Mumbai
  [77.59, 12.97], // Bangalore
  [103.82, 1.35], // Singapore
  [106.85, -6.21], // Jakarta
  [114.17, 22.32], // Hong Kong
  [126.98, 37.57], // Seoul
  [139.69, 35.69], // Tokyo
  [151.21, -33.87], // Sydney
  [-118.24, 34.05], // Los Angeles
  [-122.33, 47.61], // Seattle
  [-87.63, 41.88], // Chicago
  [-97.74, 30.27], // Austin
  [-80.19, 25.76], // Miami
  [-123.12, 49.28], // Vancouver
  [-74.07, 4.71], // Bogotá
  [-70.67, -33.45], // Santiago
  [-9.14, 38.72], // Lisbon
  [4.9, 52.37], // Amsterdam
  [8.54, 47.38], // Zurich
  [12.5, 41.9], // Rome
  [16.37, 48.21], // Vienna
  [21.01, 52.23], // Warsaw
  [28.98, 41.01], // Istanbul
  [31.24, 30.04], // Cairo
  [46.68, 24.71], // Riyadh
  [77.21, 28.61], // Delhi
  [100.5, 13.76], // Bangkok
  [121.47, 31.23], // Shanghai
  [116.4, 39.9], // Beijing
  [174.76, -36.85], // Auckland
];

const arcsGroup = new THREE.Group();
arcsGroup.renderOrder = 2;
globeMap.add(arcsGroup);
const ARC_RADIUS = GLOBE_SCALE * CONFIG.GLOBE_BORDERS_LIFT * 1.0015;

// One merged LineSegments for every flight: a single draw call, positions uploaded only when a
// flight launches, and a per-vertex alpha (updated per frame, ~12 KB) that does the grow, the
// brighter head and the fade. No per-arc objects, no drawRange juggling, no per-frame copies.
const ARC_N = CONFIG.ARCS_POINTS; // samples per arc
const ARC_SEGS = ARC_N - 1; // segments per arc
const ARC_VERTS = ARC_SEGS * 2; // vertices per arc in the segments buffer
const arcCount = CONFIG.ARCS_ENABLED ? CONFIG.ARCS_COUNT : 0;
const arcPositions = new Float32Array(arcCount * ARC_VERTS * 3);
const arcAlphas = new Float32Array(arcCount * ARC_VERTS);
const arcPosAttr = new THREE.BufferAttribute(arcPositions, 3);
const arcAlphaAttr = new THREE.BufferAttribute(arcAlphas, 1);
arcPosAttr.setUsage(THREE.DynamicDrawUsage);
arcAlphaAttr.setUsage(THREE.DynamicDrawUsage);
const arcGeom = new THREE.BufferGeometry();
arcGeom.setAttribute("position", arcPosAttr);
arcGeom.setAttribute("aAlpha", arcAlphaAttr);
const arcMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(CONFIG.ARCS_COLOR) } },
  vertexShader: `
    attribute float aAlpha;
    varying float vAlpha;
    void main() {
      vAlpha = aAlpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      if (vAlpha <= 0.001) discard;
      gl_FragColor = vec4(uColor, vAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  depthWrite: false,
});
const arcLines = new THREE.LineSegments(arcGeom, arcMat);
arcLines.frustumCulled = false;
if (arcCount > 0) arcsGroup.add(arcLines);

const arcs = [];
const tmpArcA = new THREE.Vector3();
const tmpArcB = new THREE.Vector3();
const tmpArcUa = new THREE.Vector3();
const tmpArcUb = new THREE.Vector3();

/** Write a lifted great-circle path between two surface points into arc slot `slot` (no allocation). */
function fillArcPositions(slot, a, b, lift) {
  tmpArcUa.copy(a).normalize();
  tmpArcUb.copy(b).normalize();
  const omega = Math.acos(THREE.MathUtils.clamp(tmpArcUa.dot(tmpArcUb), -1, 1));
  const sinO = Math.sin(omega) || 1e-6;
  // Short hops stay low, long hauls climb higher, like real flight paths on a map.
  const apex = ARC_RADIUS * lift * THREE.MathUtils.clamp(omega / Math.PI, 0.25, 1);
  const base = slot * ARC_VERTS * 3;
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < ARC_N; i++) {
    const t = i / (ARC_N - 1);
    const w1 = Math.sin((1 - t) * omega) / sinO;
    const w2 = Math.sin(t * omega) / sinO;
    const r = ARC_RADIUS + apex * Math.sin(Math.PI * t);
    const x = (tmpArcUa.x * w1 + tmpArcUb.x * w2) * r;
    const y = (tmpArcUa.y * w1 + tmpArcUb.y * w2) * r;
    const z = (tmpArcUa.z * w1 + tmpArcUb.z * w2) * r;
    if (i > 0) {
      const o = base + (i - 1) * 6;
      arcPositions[o] = px; arcPositions[o + 1] = py; arcPositions[o + 2] = pz;
      arcPositions[o + 3] = x; arcPositions[o + 4] = y; arcPositions[o + 5] = z;
    }
    px = x; py = y; pz = z;
  }
}

function makeArc(slot) {
  return { slot, startAt: 0, duration: 1, active: false };
}

/** Park an arc: all its vertices transparent until the scheduler reuses the slot. */
function parkArc(arc) {
  arc.active = false;
  arcAlphas.fill(0, arc.slot * ARC_VERTS, (arc.slot + 1) * ARC_VERTS);
  arcAlphaAttr.needsUpdate = true;
}

const tmpArcWorld = new THREE.Vector3();
const tmpArcNdc = new THREE.Vector3();
const tmpArcToCam = new THREE.Vector3();
const tmpArcNormal = new THREE.Vector3();
/** True when a city (globe-local position) faces the camera and projects inside the viewport. */
function cityInView(local) {
  tmpArcWorld.copy(local).applyMatrix4(arcsGroup.matrixWorld);
  tmpArcToCam.copy(camera.position).sub(globePivot.position).normalize();
  const facing = tmpArcNormal.copy(tmpArcWorld).sub(globePivot.position).normalize().dot(tmpArcToCam);
  if (facing < 0.08) return false;
  tmpArcNdc.copy(tmpArcWorld).project(camera);
  return tmpArcNdc.x > -1.05 && tmpArcNdc.x < 1.05 && tmpArcNdc.y > -1.05 && tmpArcNdc.y < 1.05 && tmpArcNdc.z < 1;
}

// City positions on the globe, computed once (globe-local space never changes).
const ARC_CITY_POS = ARC_CITIES.map(([lon, lat]) => lonLatToVec3(lon, lat, ARC_RADIUS));

/** Random city index, preferring one currently in view when `preferVisible` (falls back to any). */
function pickCity(preferVisible, exclude) {
  const tries = preferVisible ? 14 : 1;
  let last = 0;
  for (let k = 0; k < tries; k++) {
    let idx = Math.floor(Math.random() * ARC_CITY_POS.length);
    if (idx === exclude) idx = (idx + 1) % ARC_CITY_POS.length;
    last = idx;
    if (!preferVisible) return idx;
    if (cityInView(ARC_CITY_POS[idx])) return idx;
  }
  return last;
}

/** Indices of the `k` cities nearest to city `i` (small fixed scan; runs only at launch). */
function nearestCities(i, k) {
  const a = ARC_CITY_POS[i];
  const best = []; // [{idx, d}] kept sorted ascending, length <= k
  for (let idx = 0; idx < ARC_CITY_POS.length; idx++) {
    if (idx === i) continue;
    const d = ARC_CITY_POS[idx].distanceToSquared(a);
    if (best.length < k || d < best[best.length - 1].d) {
      best.push({ idx, d });
      best.sort((p, q) => p.d - q.d);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

function launchArc(arc, now) {
  arcsGroup.updateWorldMatrix(true, false);
  const wantVisible = Math.random() < CONFIG.ARCS_VISIBLE_BIAS;
  const i = pickCity(wantVisible, -1);
  // Half the flights are short hops (nearest few cities, so they stay near the visible origin);
  // the rest go anywhere, mostly to another visible city so the whole path is on screen.
  let j;
  if (Math.random() < 0.5) {
    const near = nearestCities(i, 5);
    j = near[Math.floor(Math.random() * near.length)].idx;
  } else {
    j = pickCity(wantVisible && Math.random() < 0.7, i);
  }
  tmpArcA.copy(ARC_CITY_POS[i]);
  tmpArcB.copy(ARC_CITY_POS[j]);
  const lift = CONFIG.ARCS_LIFT_MIN + Math.random() * (CONFIG.ARCS_LIFT_MAX - CONFIG.ARCS_LIFT_MIN);
  fillArcPositions(arc.slot, tmpArcA, tmpArcB, lift);
  arcPosAttr.needsUpdate = true;
  arc.startAt = now;
  arc.duration = CONFIG.ARCS_DURATION_MIN + Math.random() * (CONFIG.ARCS_DURATION_MAX - CONFIG.ARCS_DURATION_MIN);
  arc.active = true;
}

const ARC_HEAD_SEGS = Math.max(1, Math.round(ARC_SEGS * CONFIG.ARCS_HEAD_FRAC));
let arcNextLaunchAt = 1.0; // first flight shortly after the scene appears

function updateArcs(now) {
  // Metronome: launch at most one flight per tick, into the first idle slot. If every slot is
  // busy the tick is skipped, which keeps the spacing regular rather than bunching launches.
  if (now >= arcNextLaunchAt) {
    arcNextLaunchAt = now + CONFIG.ARCS_LAUNCH_EVERY;
    const idle = arcs.find((a) => !a.active);
    if (idle) launchArc(idle, now);
  }
  let anyAlpha = false;
  for (const arc of arcs) {
    if (!arc.active) continue;
    const p = (now - arc.startAt) / arc.duration; // 0..1 over the flight
    if (p >= 1) {
      parkArc(arc);
      continue;
    }
    // The line grows from origin to destination over the first 70%, then the whole thing fades.
    const grow = THREE.MathUtils.clamp(p / 0.7, 0, 1);
    const eased = grow < 0.5 ? 2 * grow * grow : 1 - Math.pow(-2 * grow + 2, 2) / 2;
    const drawnSegs = Math.max(1, Math.round(eased * ARC_SEGS));
    const fadeIn = THREE.MathUtils.clamp(p / 0.12, 0, 1);
    const fadeOut = THREE.MathUtils.clamp((1 - p) / 0.3, 0, 1);
    const env = Math.min(fadeIn, fadeOut);
    const trailA = CONFIG.ARCS_OPACITY * env;
    const landed = grow >= 1 ? THREE.MathUtils.clamp(1 - (p - 0.7) / 0.1, 0, 1) : 1;
    const headA = Math.max(trailA, CONFIG.ARCS_HEAD_OPACITY * env * landed);
    const headStart = Math.max(0, drawnSegs - ARC_HEAD_SEGS);
    const base = arc.slot * ARC_VERTS;
    for (let k = 0; k < ARC_SEGS; k++) {
      const a = k >= drawnSegs ? 0 : k >= headStart ? headA : trailA;
      arcAlphas[base + k * 2] = a;
      arcAlphas[base + k * 2 + 1] = a;
    }
    anyAlpha = true;
  }
  if (anyAlpha) arcAlphaAttr.needsUpdate = true;
}

for (let i = 0; i < arcCount; i++) arcs.push(makeArc(i));

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

// Bounding-sphere radius of the (normalized) plane; set once the GLB loads.
let planeFrameRadius = 0;

// How much the camera is pulled back on narrow viewports (1 on desktop; see CAMERA_MIN_ASPECT).
function aspectComp() {
  const minAspect = PLACE.minaspect != null ? PLACE.minaspect : CONFIG.CAMERA_MIN_ASPECT;
  return Math.max(1, minAspect / camera.aspect);
}

// Frame the camera around the plane's bounding sphere so it is always visible.
// Narrow viewports pull the camera back (see CAMERA_MIN_ASPECT).
function frameCamera() {
  if (!planeFrameRadius) return;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (planeFrameRadius / Math.sin(fov / 2)) * CAMERA_DISTANCE_MULT * aspectComp();
  // Use RIGHT_OFFSET_MULT to shift the framed camera horizontally.
  camera.position.set(planeFrameRadius * RIGHT_OFFSET_MULT, planeFrameRadius * 0.55, dist);
  camera.near = Math.max(0.01, dist / 100);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(0, CONFIG.CAMERA_LOOK_Y, 0);
}

// Keep the globe's horizon (its top edge) low in the frame when the camera is pulled back on
// narrow viewports, so it never rides up behind the text column (see GLOBE_NARROW_DROP), and
// nudge it right on those frames so the rim stays clear of the column (see GLOBE_NARROW_PUSH).
function placeGlobe() {
  const comp = aspectComp();
  const horizon = GLOBE_POS.y + GLOBE_SCALE - CONFIG.CAMERA_LOOK_Y;
  const drop = Math.pow(comp, CONFIG.GLOBE_NARROW_DROP);
  globeBasePos.x = GLOBE_POS.x + (comp - 1) * CONFIG.GLOBE_NARROW_PUSH;
  globeBasePos.y = CONFIG.CAMERA_LOOK_Y + horizon * drop - GLOBE_SCALE;
}

// Visible world-space height / width at the plane's depth (z = 0).
function viewHeightAtPlane() {
  const fov = THREE.MathUtils.degToRad(camera.fov);
  return 2 * camera.position.z * Math.tan(fov / 2);
}
function viewWidthAtPlane() {
  return viewHeightAtPlane() * camera.aspect;
}

// Keep the plane at the same horizontal fraction of the viewport regardless of aspect ratio, and
// at the same pixel distance from the top regardless of viewport height.
function placePlane() {
  if (!planeFrameRadius) return;
  const viewH = viewHeightAtPlane();
  // Narrow md frames (tablets) render the plane small, so nudge it a little further right there
  // to keep clearance from the headline's ragged edge; lg+ desktops are unchanged.
  const xFrac =
    PLACE.xfrac != null
      ? PLACE.xfrac
      : window.innerWidth < 1024
        ? CONFIG.PLANE_VIEW_X_FRAC + 0.05
        : CONFIG.PLANE_VIEW_X_FRAC;
  const yPx =
    PLACE.yfrac != null
      ? PLACE.yfrac * window.innerHeight
      : Math.max(
          Math.min(CONFIG.PLANE_VIEW_Y_PX, window.innerHeight * CONFIG.PLANE_VIEW_Y_MAX_FRAC),
          window.innerHeight * CONFIG.PLANE_VIEW_Y_MIN_FRAC,
        );
  basePos.x = viewWidthAtPlane() * xFrac;
  // PLANE_BASE_POS.y was tuned to land PLANE_BASE_VIEW_Y_FRAC down a desktop frame, whose view
  // height is viewH / aspectComp() (narrow frames pull the camera back, which would otherwise
  // drag the plane toward the frame centre). Re-derive the offset so the centre lands at
  // PLANE_VIEW_Y_PX at any height or aspect.
  const desktopViewH = viewH / aspectComp();
  basePos.y =
    PLANE_BASE_POS.y +
    (0.5 - yPx / window.innerHeight) * viewH -
    (0.5 - CONFIG.PLANE_BASE_VIEW_Y_FRAC) * desktopViewH;
}

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
    // Fraction of the visible width the current plane x corresponds to (paste into PLANE_VIEW_X_FRAC).
    PLANE_VIEW_X_FRAC: +(basePos.x / viewWidthAtPlane()).toFixed(3),
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
  updateGizmo();
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
    planeFrameRadius = sphere.radius;
    frameCamera();

    // Apply default placement captured from drag; plane x/y and globe x/y are viewport-derived.
    basePos.set(PLANE_BASE_POS.x, PLANE_BASE_POS.y, PLANE_BASE_POS.z);
    globeBasePos.set(GLOBE_POS.x, GLOBE_POS.y, GLOBE_POS.z);
    placePlane();
    placeGlobe();

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
    planePivot.rotation.x = BASE_PITCH + PLANE_ROT.pitch;
    // Bank into the side-to-side sway (paper-plane feel).
    const bankFromSway = swaySide * 0.18; // swaySide is in world units; keep this subtle
    planePivot.rotation.z =
      BASE_ROLL + PLANE_ROT.roll + Math.sin(tw * 0.75 + 0.2) * 0.07 * CONFIG.PLANE_WOBBLE_INTENSITY + bankFromSway;
    // Tiny yaw wiggle + a touch of "follow through" from sway.
    planePivot.rotation.y =
      LOCKED_YAW + PLANE_ROT.yaw + Math.sin(tw * 0.6 + 0.4) * 0.020 * CONFIG.PLANE_WOBBLE_INTENSITY + bankFromSway * 0.22;

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

  if (CONFIG.ARCS_ENABLED && globePivot.visible) updateArcs(t);
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  // Re-frame + re-place so the plane keeps its viewport-relative position after a resize.
  frameCamera();
  placePlane();
  placeGlobe();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


