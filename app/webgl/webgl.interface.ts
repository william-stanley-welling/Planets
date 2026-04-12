// ─── webgl.interface.ts ───────────────────────────────────────────────────────

/**
 * @fileoverview Public contract for the WebGL rendering engine.
 *
 * Decouples the dashboard component and other consumers from the concrete
 * `WebGl` service implementation, enabling substitution (e.g. for testing).
 *
 * @module webgl.interface
 */

import * as THREE from 'three';
import { Star } from '../galaxy/star.model';

// ---------------------------------------------------------------------------
// Navigation modes
// ---------------------------------------------------------------------------

/**
 * Camera navigation modes.  Each mode changes how the camera frames bodies
 * when selected and how it travels between them.  The active mode is persisted
 * to `localStorage` and restored on page load.
 *
 * @enum {string}
 */
export enum NavigationMode {
  /**
   * Top-down discovery view looking down the ecliptic normal (+Z).
   *
   * - Camera sits high above the solar disc, revealing all concentric orbits.
   * - Navigating to a body moves directly above it at a wide overview altitude.
   * - No geostationary locking — the camera is free to fly between observations.
   */
  DISCOVERY = 'discovery',

  /**
   * Cinematic observation mode — orbital follow cam.
   *
   * - On single-body selection the camera moves to an oblique vantage and
   *   then locks geostationary: it maintains a fixed world-space offset from
   *   the body's `orbitalGroup` so it naturally travels with the body's orbit.
   * - The camera continuously `lookAt`s the locked body each frame.
   * - Clicking a visible moon transfers the lock to that moon.
   * - Multi-select deactivates the lock; the camera frames all selected bodies.
   */
  CINEMATIC = 'cinematic',

  /**
   * Fastest-travel propulsion mode — experimental stub.
   *
   * - Camera represents a vessel with finite fuel and thrust.
   * - Navigation queues Hohmann-transfer waypoints rather than instantly
   *   repositioning the camera.
   * - The full physics simulation is not yet implemented; this mode exposes
   *   the UI / interface surface so the feature can be built incrementally.
   * - Switching to this mode displays a fuel/route HUD overlay.
   */
  FASTEST_TRAVEL = 'fastest_travel',

  PLANNING = 'planning',
  TRAVEL = 'travel',
}

/**
 * Stubbed vessel state for the Fastest-Travel propulsion mode.
 * All values are game-design placeholders subject to revision.
 *
 * @interface TravelVesselState
 */
export interface TravelVesselState {
  /** Remaining fuel units (0–`fuelCapacity`). */
  fuel: number;
  /** Maximum fuel capacity. */
  fuelCapacity: number;
  /** Ordered list of body-name waypoints queued for autonomous traversal. */
  waypoints: string[];
  /** `true` while the vessel is autonomously following a route. */
  enRoute: boolean;
  /** Estimated Δv budget remaining for current route (scene units/s equivalent). */
  deltaVBudget: number;
}

export type Waypoint = {
  type: 'body' | 'coordinate';
  bodyName?: string;
  position?: THREE.Vector3;
  orbitDuration?: number; // seconds to stay and orbit
};

export interface Trip {
  name: string;
  waypoints: Waypoint[];
  createdAt: number;
}

export interface Transport {
  currentTrip: Trip | null;
  active: boolean;
  currentWaypointIndex: number;
  vesselPosition: THREE.Vector3;
  vesselVelocity: THREE.Vector3;
  cameraMode: 'firstPerson' | 'thirdPerson';
  loadTrips(): Trip[];
  saveTrip(trip: Trip): void;
  deleteTrip(name: string): void;
  startTrip(trip: Trip): void;
  stopTrip(): void;
  update(deltaSec: number): void;
  toggleCameraMode(): void;
}

// ---------------------------------------------------------------------------
// Ring render mode
// ---------------------------------------------------------------------------

/**
 * Phase selector for ring rendering.
 *
 * - `'washer'`    — Phase 1: flat `THREE.RingGeometry` disc with optional texture.
 *                   Always rendered; solid and performant.
 * - `'particles'` — Phase 2: `THREE.Points` sinusoidal wobble-washer.
 *                   Enabled automatically when `RingConfig.particleCount > 0`.
 *                   Layered on top of the solid washer for planet rings, or used
 *                   exclusively for the asteroid belt (which has no solid disc).
 */
export type RingRenderMode = 'washer' | 'particles';

// ---------------------------------------------------------------------------
// Core renderer contract
// ---------------------------------------------------------------------------

/**
 * Core rendering engine contract for the heliocentric simulation.
 *
 * @interface ICelestialRenderer
 */
export interface ICelestialRenderer {
  /** Active Three.js scene. */
  readonly scene: THREE.Scene;
  /** Perspective camera driven by flight controls. */
  readonly camera: THREE.PerspectiveCamera;
  /** WebGL renderer instance. */
  readonly renderer: THREE.WebGLRenderer;
  /** Root star; `null` until the SSE hierarchy is loaded. */
  readonly star: Star | null;
  /** All raycasting-selectable highlight meshes. */
  readonly selectable: THREE.Object3D[];
  /** Whether the engine has been started. */
  readonly active: boolean;
  /** Current simulation timestamp (milliseconds). */
  simulationTime: number;

  /** Active camera navigation mode. Persisted to `localStorage`. */
  navMode: NavigationMode;

  /**
   * When `true`, selecting a planet also illuminates all of its moon highlight
   * meshes. Toggled via {@link toggleShowMoonsOfSelected}; persisted to `localStorage`.
   */
  showMoonsOfSelected: boolean;

  /** Whether planet orbit ellipses are currently visible. */
  showPlanetOrbits: boolean;

  /** Whether moon orbit ellipses are currently visible. */
  showMoonOrbits: boolean;

  /** Experimental fastest-travel vessel state (read-only reference). */
  readonly vesselState: TravelVesselState;

  /**
   * Initialises the renderer, camera, and scene.
   * @param {number} height - Viewport height in CSS pixels.
   * @param {number} width  - Viewport width in CSS pixels.
   */
  init(height: number, width: number): void;

  /** Starts the animation loop and WebSocket subscription. */
  start(): void;

  getCameraAzimuth(): number;

  selectInRect(start: { x: number; y: number }, end: { x: number; y: number }, additive: boolean): void;

  resetSimulation(): void;

  simulationDate: Date;   // getter

  /**
   * Updates renderer and camera for a new viewport size.
   * @param {number} height - New height in CSS pixels.
   * @param {number} width  - New width in CSS pixels.
   */
  resize(height: number, width: number): void;

  /** @returns {CameraInfo} Current camera diagnostics. */
  getCameraInfo(): CameraInfo;

  /** @returns {SystemSnapshot} Lightweight body positions for the minimap. */
  getSystemSnapshot(): SystemSnapshot;

  /**
   * Switches the camera navigation mode and repositions the camera to a
   * contextually appropriate starting position for that mode.
   * Persists the new mode to `localStorage`.
   *
   * @param {NavigationMode} mode - Target mode.
   */
  setNavigationMode(mode: NavigationMode): void;

  /**
   * Transitions the camera to a named preset.
   * @param {CameraView} view        - Preset identifier.
   * @param {number}     [durationMs] - Transition duration in ms.
   */
  setCameraView(view: CameraView, durationMs?: number): void;

  /**
   * Flies the camera to a named body.
   *
   * Behaviour is governed by the active {@link navMode}:
   *  - `DISCOVERY`      — moves directly above the body at high altitude for a
   *                       top-down view.  Includes the body's moon satellites in
   *                       the bounding frame so they are all visible.
   *  - `CINEMATIC`      — moves to an oblique offset and activates geostationary
   *                       orbital follow, locking the camera to the body's orbit.
   *                       Moon satellites are included in the initial frame.
   *  - `FASTEST_TRAVEL` — queues the body as the next waypoint and begins
   *                       autonomous route traversal if fuel permits.
   *
   * @param {string} bodyName    - Case-insensitive body name.
   * @param {number} [durationMs] - Transition duration in ms.
   */
  navigateToPlanet(bodyName: string, durationMs?: number): void;

  /**
   * Repositions the camera so that all currently selected bodies fit within the
   * field of view simultaneously.  Delegates to {@link navigateToPlanet} when
   * only one body is selected.
   *
   * @param {number} [durationMs] - Transition duration in ms.
   */
  navigateToSelection(durationMs?: number): void;

  /**
   * Smoothly moves the camera to an arbitrary position.
   * @param {THREE.Vector3} toPos    - Target position.
   * @param {THREE.Vector3} [lookAt] - Point to face at end of transition.
   * @param {THREE.Vector3} [toUp]   - Up vector at end of transition.
   * @param {number} [durationMs]    - Transition duration in ms.
   */
  moveCameraTo(
    toPos: THREE.Vector3,
    lookAt?: THREE.Vector3,
    toUp?: THREE.Vector3,
    durationMs?: number,
  ): void;

  /**
   * Shows or hides all planet orbit ellipses only.
   * Moon orbit lines are never affected.
   * @param {boolean} visible - Target state.
   */
  togglePlanetOrbits(visible: boolean): void;

  /**
   * Shows or hides all moon orbit ellipses only.
   * Planet orbit lines are never affected.
   * @param {boolean} visible - Target state.
   */
  toggleMoonOrbits(visible: boolean): void;

  /**
   * Toggles moon orbit ellipses for one specific parent planet.
   * Does not mutate the global `showMoonOrbits` flag.
   *
   * @param {string}  planetName - Parent planet name.
   * @param {boolean} visible    - Target state.
   */
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void;

  /**
   * Flips the "moons of selected" persistent flag.
   * @returns {boolean} The new active state.
   */
  toggleShowMoonsOfSelected(): boolean;

  /**
   * Directly sets the highlight halo visibility of a named body.
   * @param {string}  name    - Body name.
   * @param {boolean} visible - Target visibility.
   */
  setHighlight(name: string, visible: boolean): void;

  /**
   * Routes a keyboard event to the engine's input handler.
   * @param {KeyboardEvent} event - The originating keyboard event.
   */
  keyDown(event: KeyboardEvent): void;
}

// ---------------------------------------------------------------------------
// Supplementary types
// ---------------------------------------------------------------------------

/**
 * Diagnostic snapshot of the camera's current state.
 * @interface CameraInfo
 */
export interface CameraInfo {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  velocity: number;
}

/**
 * Lightweight positional snapshot for the minimap renderer.
 * @interface SystemSnapshot
 */
export interface SystemSnapshot {
  bodies: BodySnapshot[];
  camera: { x: number; y: number; z: number };
}

/**
 * Minimal body descriptor for minimap rendering.
 * @interface BodySnapshot
 */
export interface BodySnapshot {
  name: string;
  x: number;
  y: number;
  color: string;
  au: number;
  isStar: boolean;
}

/**
 * Named camera preset views — mode-independent quick-jump targets.
 * @enum {string}
 */
export enum CameraView {
  OVERVIEW = 'overview',
  ECLIPTIC = 'ecliptic',
  CINEMATIC = 'cinematic',
}
