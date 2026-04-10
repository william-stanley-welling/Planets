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
import { CelestialBody } from '../galaxy/celestial.model';

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

  /**
   * Initialises the renderer, camera, and scene.
   * @param {number} height - Viewport height in CSS pixels.
   * @param {number} width  - Viewport width in CSS pixels.
   */
  init(height: number, width: number): void;

  /** Starts the animation loop and WebSocket subscription. */
  start(): void;

  /**
   * Updates renderer and camera for a new viewport size.
   * @param {number} height - New height in CSS pixels.
   * @param {number} width  - New width in CSS pixels.
   */
  resize(height: number, width: number): void;

  /** @returns {CameraInfo} Current camera position, direction, and speed. */
  getCameraInfo(): CameraInfo;

  /** @returns {SystemSnapshot} Lightweight body positions for the minimap. */
  getSystemSnapshot(): SystemSnapshot;

  /**
   * Transitions the camera to a named preset.
   * @param {CameraView} view       - Preset identifier.
   * @param {number}     [durationMs] - Transition duration in ms.
   */
  setCameraView(view: CameraView, durationMs?: number): void;

  /**
   * Flies the camera to a named body.
   * @param {string} bodyName   - Case-insensitive body name.
   * @param {number} [durationMs] - Transition duration in ms.
   */
  navigateToPlanet(bodyName: string, durationMs?: number): void;

  /**
   * Smoothly moves the camera to an arbitrary position.
   * @param {THREE.Vector3} toPos    - Target position.
   * @param {THREE.Vector3} [lookAt] - Point to face at end of transition.
   * @param {THREE.Vector3} [toUp]   - Up vector at end of transition.
   * @param {number} [durationMs]    - Transition duration in ms.
   */
  moveCameraTo(toPos: THREE.Vector3, lookAt?: THREE.Vector3, toUp?: THREE.Vector3, durationMs?: number): void;

  /**
   * Shows or hides all planet orbit ellipses.
   * @param {boolean} visible - Target state.
   */
  togglePlanetOrbits(visible: boolean): void;

  /**
   * Shows or hides all moon orbit ellipses.
   * @param {boolean} visible - Target state.
   */
  toggleMoonOrbits(visible: boolean): void;

  /**
   * Toggles moon orbit ellipses for a specific parent planet.
   * @param {string}  planetName - Parent planet name.
   * @param {boolean} visible    - Target state.
   */
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void;

  /**
   * Routes a keyboard event to the engine's input handler.
   * @param {KeyboardEvent} event - The keyboard event.
   */
  keyDown(event: KeyboardEvent): void;
}

/**
 * Diagnostic snapshot of the camera's current state.
 *
 * @interface CameraInfo
 */
export interface CameraInfo {
  /** World-space camera position. */
  position: THREE.Vector3;
  /** Normalised look direction vector. */
  direction: THREE.Vector3;
  /** Instantaneous speed in scene units per second. */
  velocity: number;
}

/**
 * Lightweight positional snapshot used to render the minimap.
 *
 * @interface SystemSnapshot
 */
export interface SystemSnapshot {
  /** All tracked bodies with position and colour. */
  bodies: BodySnapshot[];
  /** Camera position in scene space. */
  camera: { x: number; y: number; z: number };
}

/**
 * Minimal body descriptor for minimap rendering.
 *
 * @interface BodySnapshot
 */
export interface BodySnapshot {
  /** Body display name. */
  name: string;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** CSS hex colour string for the minimap dot. */
  color: string;
  /** Heliocentric distance in AU (0 for the star). */
  au: number;
  /** `true` if this entry represents the central star. */
  isStar: boolean;
}

/**
 * Named camera preset views.
 *
 * @enum {string}
 */
export enum CameraView {
  /** Top-down overview of the full solar system. */
  OVERVIEW = 'overview',
  /** Side-on ecliptic plane view. */
  ECLIPTIC = 'ecliptic',
  /** Angled cinematic view. */
  CINEMATIC = 'cinematic',
}
