/**
 * @fileoverview Core Three.js rendering service for the heliocentric simulation.
 *
 * Provides:
 *  - `HeliocentricControls` — pointer-lock first-person camera with mass-adaptive speed.
 *  - `WebGl` — Angular service that owns the Three.js scene, animation loop,
 *    WebSocket orbit integration, raycasting selection, and camera navigation.
 *
 * @module webgl.service
 */

import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { OrbitingBody, SIMULATION_CONSTANTS } from '../galaxy/celestial.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';
import {
  ICelestialRenderer,
  CameraInfo,
  SystemSnapshot,
  CameraView,
  BodySnapshot,
} from './webgl.interface';
import { Observable, Subject } from 'rxjs';
import { Planet } from 'app/galaxy/planet.model';
import { RingConfig } from '../galaxy/celestial.model';
import { AssetTextureService } from './asset-texture.service';

export { CameraView, SystemSnapshot, BodySnapshot, CameraInfo } from './webgl.interface';

// ---------------------------------------------------------------------------
// HeliocentricControls
// ---------------------------------------------------------------------------

/**
 * First-person pointer-lock camera controller for navigating the solar system.
 *
 * Features:
 *  - WASD / Arrow keys for translational movement.
 *  - R / F for vertical movement.
 *  - Mouse move for look (while pointer is locked).
 *  - Mouse wheel to adjust movement speed.
 *  - Shift for a 10× boost.
 *  - Mass-adaptive speed scaling: slows near massive/nearby bodies.
 */
class HeliocentricControls {
  /** Base movement speed in scene units per second, before mass scaling. */
  baseMovementSpeed = 3000.0;

  /** Effective movement speed after mass scaling is applied each frame. */
  movementSpeed = 3000.0;

  /** Mouse sensitivity (radians per pixel of cursor movement). */
  lookSpeed = 0.002;

  /** Instantaneous camera velocity in scene units per second. */
  velocity = 0;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private keys: Record<string, boolean> = {};
  private isLocked = false;
  private lastPos = new THREE.Vector3();
  private lastTime = 0;
  private starRef: Star | null = null;

  private readonly boundMouseMove = this.onMouseMove.bind(this);
  private readonly boundLockChange = this.onLockChange.bind(this);
  private readonly boundKeyDown = (e: KeyboardEvent) => { this.keys[e.code] = true; };
  private readonly boundKeyUp = (e: KeyboardEvent) => { this.keys[e.code] = false; };
  private readonly boundWheel = this.onWheel.bind(this);

  /**
   * @param {THREE.Camera}  camera     - The perspective camera to control.
   * @param {HTMLElement}   domElement - Canvas element used for pointer-lock requests.
   */
  constructor(private camera: THREE.Camera, private domElement: HTMLElement) {
    this.euler.setFromQuaternion(camera.quaternion);
    document.addEventListener('pointerlockchange', this.boundLockChange);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('wheel', this.boundWheel, { passive: true });
    this.domElement.tabIndex = 0;
    this.domElement.style.outline = 'none';
    this.lastPos.copy(camera.position);
    this.lastTime = performance.now();
  }

  /**
   * Provides a reference to the star so that mass-adaptive speed scaling
   * can inspect nearby satellite bodies.
   *
   * @param {Star} star - The root star in the current solar system.
   */
  setStar(star: Star): void { this.starRef = star; }

  /** `true` when the pointer is locked and flight mode is active. */
  get locked(): boolean { return this.isLocked; }

  /** Requests pointer lock, entering flight mode. */
  enterFlight(): void {
    if (!this.isLocked) {
      this.domElement.focus();
      this.domElement.requestPointerLock();
    }
  }

  /** Releases the pointer lock, exiting flight mode. */
  exitFlight(): void { document.exitPointerLock(); }

  /** Toggles pointer lock state. */
  toggle(): void { this.isLocked ? this.exitFlight() : this.enterFlight(); }

  /**
   * Scales the base movement speed by a multiplicative delta.
   * Clamped to [100, 50 000] scene units per second.
   *
   * @param {number} delta - Fractional change, e.g. `0.1` for +10 %, `-0.1` for −10 %.
   */
  adjustMovementSpeed(delta: number): void {
    this.baseMovementSpeed = Math.max(100, Math.min(50_000, this.baseMovementSpeed * (1 + delta)));
    this.updateSpeedScale();
  }

  /**
   * Computes and applies mass-adaptive speed scaling based on the nearest
   * satellite body.  Bodies with greater mass reduce the effective speed so
   * that the camera decelerates naturally near planets.
   */
  private updateSpeedScale(): void {
    if (!this.starRef) return;
    const camPos = this.camera.position;
    let nearestMass = 0;
    let nearestDistSq = Infinity;

    const check = (body: any) => {
      if (body === this.starRef) return;
      const pos = new THREE.Vector3();
      if (body.orbitalGroup) body.orbitalGroup.getWorldPosition(pos);
      else if (body.group) body.group.getWorldPosition(pos);
      else return;
      const d2 = camPos.distanceToSquared(pos);
      if (d2 < nearestDistSq) { nearestDistSq = d2; nearestMass = body.mass || 0; }
      if (body.satellites) body.satellites.forEach(check);
    };
    check(this.starRef);

    const massScale = Math.max(0.2, Math.min(1, 1 / (1 + nearestMass / 1e24)));
    this.movementSpeed = this.baseMovementSpeed * massScale;
  }

  /**
   * Advances the camera position by one frame according to held keys.
   * Must be called every animation frame.
   *
   * @param {number} delta - Frame time in seconds (from `THREE.Clock.getDelta`).
   */
  update(delta: number): void {
    if (!this.isLocked) return;
    this.updateSpeedScale();

    const boost = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) ? 10 : 1;
    const speed = this.movementSpeed * boost * delta;
    const dir = new THREE.Vector3();

    if (this.keys['KeyW'] || this.keys['ArrowUp']) dir.z -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) dir.z += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) dir.x -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) dir.x += 1;
    if (this.keys['KeyR']) dir.y += 1;
    if (this.keys['KeyF']) dir.y -= 1;

    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(speed);
      this.camera.translateX(dir.x);
      this.camera.translateY(dir.y);
      this.camera.translateZ(dir.z);
    }

    const now = performance.now();
    const dt = Math.max(0.001, (now - this.lastTime) / 1000);
    this.velocity = this.camera.position.distanceTo(this.lastPos) / dt;
    this.lastPos.copy(this.camera.position);
    this.lastTime = now;
  }

  /**
   * Re-synchronises the internal Euler angles from the camera quaternion.
   * Call after any external camera rotation (e.g. `lookAt`) to prevent
   * snap-back on the next mouse-move event.
   */
  syncEuler(): void { this.euler.setFromQuaternion(this.camera.quaternion); }

  /** Removes all event listeners and releases DOM references. */
  dispose(): void {
    document.removeEventListener('pointerlockchange', this.boundLockChange);
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('keydown', this.boundKeyDown);
    document.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('wheel', this.boundWheel);
  }

  private onLockChange(): void {
    this.isLocked = document.pointerLockElement === this.domElement;
    if (this.isLocked) document.addEventListener('mousemove', this.boundMouseMove);
    else document.removeEventListener('mousemove', this.boundMouseMove);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isLocked) return;
    this.euler.y -= e.movementX * this.lookSpeed;
    this.euler.x -= e.movementY * this.lookSpeed;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    this.camera.quaternion.setFromEuler(this.euler);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.isLocked) return;
    this.adjustMovementSpeed(e.deltaY > 0 ? -0.1 : 0.1);
  }

  /** No-op — pointer lock requires no special resize handling. */
  handleResize(): void { }
}

// ---------------------------------------------------------------------------
// WebGl service
// ---------------------------------------------------------------------------

/**
 * Angular service that owns the complete Three.js scene for the solar system.
 *
 * Responsibilities:
 *  - Initialising the renderer, camera, and lighting.
 *  - Building the scene hierarchy from SSE data via `StarFactory`.
 *  - Integrating server-pushed true-anomaly updates from the WebSocket.
 *  - Raycasting for 3-D body selection on canvas click.
 *  - Managing orbit-line visibility with proper planet/moon discrimination.
 *  - Animated camera transitions and preset views.
 *  - Session-storage camera persistence across page reloads.
 *
 * @implements {ICelestialRenderer}
 */
@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {
  /** Active Three.js scene. */
  readonly scene: THREE.Scene;

  /** Perspective camera controlled by `HeliocentricControls`. */
  camera!: THREE.PerspectiveCamera;

  /** WebGL renderer attached to the host canvas element. */
  readonly renderer: THREE.WebGLRenderer;

  /** Root star in the loaded solar system; `null` until the SSE `planets` event fires. */
  star!: Star;

  /**
   * All highlight meshes that participate in raycasting selection.
   * Populated by {@link collectSelectable} after the hierarchy is built.
   */
  selectable: THREE.Object3D[] = [];

  /** `true` after {@link start} has been called. */
  active = false;

  /** Current simulation timestamp in milliseconds, mirrored from server. */
  // simulationTime = Date.now();

  /** Currently selected body names (supports multiselect). */
  selectedNames = new Set<string>();

  /** Name of the single most-recently-selected body, or `null`. */
  get selectedPlanetName(): string | null {
    return this.selectedNames.size > 0
      ? [...this.selectedNames][this.selectedNames.size - 1]
      : null;
  }

  /** Whether planet orbit ellipses are currently visible. */
  showPlanetOrbits = true;

  /** Whether moon orbit ellipses are currently visible. */
  showMoonOrbits = false;

  private readonly clock: THREE.Clock;
  private _controls!: HeliocentricControls;

  /** FIX: Two separate sets to track which orbit lines belong to planets vs moons. */
  private planetOrbitLines = new Map<string, THREE.LineLoop>();
  private moonOrbitLines = new Map<string, THREE.LineLoop>();

  private simulationTimeSubject = new Subject<number>();

  /** Observable that emits the current simulation timestamp on every WebSocket orbit update. */
  get simulationTime$(): Observable<number> {
    return this.simulationTimeSubject.asObservable();
  }

  private set simulationTime(value: number) {
    this._simulationTime = value;
    this.simulationTimeSubject.next(value);
  }

  private _simulationTime = Date.now();
  get simulationTime(): number {
    return this._simulationTime;
  }

  private cameraAnim: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    lookAt: THREE.Vector3;
    fromUp: THREE.Vector3; toUp: THREE.Vector3;
    startMs: number; durationMs: number;
  } | null = null;

  private readonly SESSION_KEY = 'helio_cam';
  private lastSaveMs = 0;
  private cameraRestored = false;

  /** Raycaster used for 3-D body selection on canvas click. */
  private readonly raycaster = new THREE.Raycaster();

  /** Callback set by the dashboard component to be notified of selection changes. */
  onSelectionChanged?: (names: Set<string>) => void;

  private static readonly OUTER_AU = 30.07;
  private static readonly OUTER_SCENE = WebGl.OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

  private static readonly CAMERA_PRESETS: Record<CameraView, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
    [CameraView.OVERVIEW]: { pos: new THREE.Vector3(0, 0, WebGl.OUTER_SCENE * 3.2), up: new THREE.Vector3(0, 1, 0) },
    [CameraView.ECLIPTIC]: { pos: new THREE.Vector3(WebGl.OUTER_SCENE * 2.4, WebGl.OUTER_SCENE * 0.15, 0), up: new THREE.Vector3(0, 0, 1) },
    [CameraView.CINEMATIC]: { pos: new THREE.Vector3(WebGl.OUTER_SCENE * 0.8, WebGl.OUTER_SCENE * 0.6, WebGl.OUTER_SCENE * 2.0), up: new THREE.Vector3(0, 1, 0) },
  };

  /**
   * @param {StarFactory}      starFactory - Factory that asynchronously builds the star+planet+moon hierarchy.
   * @param {SseService}       sseService  - SSE client that delivers the initial solar-system payload.
   * @param {WebSocketService} wsService   - WebSocket client that delivers orbit updates and sends speed changes.
   */
  constructor(
    private starFactory: StarFactory,
    private sseService: SseService,
    private wsService: WebSocketService,
    private textureService: AssetTextureService
  ) {
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the camera, controls, renderer, lights, and skybox.
   * Must be called once after the host canvas has been appended to the DOM.
   *
   * @param {number} height - Viewport height in CSS pixels.
   * @param {number} width  - Viewport width in CSS pixels.
   */
  init(height: number, width: number): void {
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2_000_000);
    const overview = WebGl.CAMERA_PRESETS[CameraView.OVERVIEW];
    this.camera.position.copy(overview.pos);
    this.camera.up.copy(overview.up);
    this.camera.lookAt(0, 0, 0);
    this.restoreCameraState();
    this.scene.add(this.camera);

    this._controls = new HeliocentricControls(this.camera, this.renderer.domElement);
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000011, 1);
    this.renderer.shadowMap.enabled = true;
    this.scene.add(new THREE.AmbientLight(0xaaaaaa, 0.6));

    const skyUrls = ['galaxy_rit.png', 'galaxy_lft.png', 'galaxy_top.png',
      'galaxy_btm.png', 'galaxy_frn.png', 'galaxy_bak.png']
      .map(f => `/images/skybox/${f}`);
    new THREE.CubeTextureLoader().load(skyUrls, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    });
  }

  /**
   * Begins the SSE planet-load subscription, WebSocket orbit listener, and animation loop.
   * Idempotent — subsequent calls are no-ops once `active` is `true`.
   */
  start(): void {
    this.loadPlanets();
    // this.loadUniverse();
    this.observePlanets();
    this.animate();
    this.active = true;
  }

  /**
   * Resizes the renderer and updates the camera aspect ratio.
   *
   * @param {number} height - New viewport height in pixels.
   * @param {number} width  - New viewport width in pixels.
   */
  resize(height: number, width: number): void {
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ─── Public accessors (legacy shims) ───────────────────────────────────────

  /** @returns {boolean} Whether the service is active. */
  isActive(): boolean { return this.active; }

  /** @returns {THREE.WebGLRenderer} The underlying renderer. */
  getRenderer(): THREE.WebGLRenderer { return this.renderer; }

  /** @returns {THREE.Scene} The active scene. */
  getScene(): THREE.Scene { return this.scene; }

  /** @returns {THREE.PerspectiveCamera} The active camera. */
  getCamera(): THREE.PerspectiveCamera { return this.camera; }

  /** @returns {HeliocentricControls} The camera flight controller. */
  get controls(): HeliocentricControls { return this._controls; }

  // ─── Camera state ──────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of the current camera position, look direction,
   * and instantaneous velocity.
   *
   * @returns {CameraInfo} Current camera diagnostic data.
   */
  getCameraInfo(): CameraInfo {
    return {
      position: this.camera.position.clone(),
      direction: this.camera.getWorldDirection(new THREE.Vector3()),
      velocity: this._controls.velocity,
    };
  }

  /**
   * Returns a lightweight snapshot of all body positions and the camera
   * position, used by the minimap renderer.
   *
   * @returns {SystemSnapshot} Current body-position and camera-position snapshot.
   */
  getSystemSnapshot(): SystemSnapshot {
    const bodies: BodySnapshot[] = [
      { name: 'Sun', x: 0, y: 0, color: '#ffcc44', au: 0, isStar: true },
    ];
    if (this.star) {
      for (const planet of this.star.satellites) {
        const pos = new THREE.Vector3();
        (planet as any).orbitalGroup?.getWorldPosition(pos);
        bodies.push({
          name: planet.name,
          x: pos.x,
          y: pos.y,
          color: (planet.config as any).color || '#aaaaff',
          au: (planet.config as any).au ?? 0,
          isStar: false,
        });
      }
    }
    const cam = this.camera?.position ?? new THREE.Vector3();
    return { bodies, camera: { x: cam.x, y: cam.y, z: cam.z } };
  }

  /**
   * Computes the azimuthal angle offset between the camera and a named body,
   * used to drive the compass-needle indicator in the planet panel.
   *
   * @param {string} bodyName - Name of the planet to compute phase angle for.
   * @returns {number} Signed angle in radians (−π to π) from body to camera.
   */
  getBodyPhaseAngle(bodyName: string): number {
    if (!this.star) return 0;
    const body = this.star.satellites.find(p => p.name === bodyName) as any;
    if (!body?.orbitalGroup) return 0;
    const bodyPos = body.orbitalGroup.position;
    const camPos = this.camera.position;
    const bodyAngle = Math.atan2(bodyPos.y, bodyPos.x);
    const camAngle = Math.atan2(camPos.y, camPos.x);
    let diff = camAngle - bodyAngle;
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    return diff;
  }

  // ─── Camera navigation ─────────────────────────────────────────────────────

  /**
   * Smoothly animates the camera to a target position and orientation.
   *
   * @param {THREE.Vector3} toPos      - Target camera position in scene space.
   * @param {THREE.Vector3} [lookAt]   - Point the camera will face at the end of the transition.
   * @param {THREE.Vector3} [toUp]     - Camera up vector at the end of the transition.
   * @param {number}        [durationMs=1800] - Transition duration in milliseconds.
   */
  moveCameraTo(
    toPos: THREE.Vector3,
    lookAt: THREE.Vector3 = new THREE.Vector3(),
    toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
    durationMs = 1800,
  ): void {
    this.cameraAnim = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      lookAt: lookAt.clone(),
      fromUp: this.camera.up.clone(),
      toUp: toUp.clone(),
      startMs: Date.now(),
      durationMs,
    };
  }

  /**
   * Moves the camera to a named preset view with a smooth transition.
   *
   * @param {CameraView} view        - Preset identifier.
   * @param {number}     [durationMs=2000] - Transition duration in milliseconds.
   */
  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = WebGl.CAMERA_PRESETS[view];
    this.moveCameraTo(preset.pos, new THREE.Vector3(), preset.up, durationMs);
  }

  /**
   * Flies the camera to a comfortable viewing distance from a named planet.
   * Searches planets first; if not found, searches all moon satellites.
   *
   * @param {string} planetName  - Case-insensitive body name.
   * @param {number} [durationMs=2000] - Transition duration in milliseconds.
   */
  navigateToPlanet(planetName: string, durationMs = 2000): void {
    const target = this.findBodyByName(planetName);
    if (!target) return;
    const pos = new THREE.Vector3();
    (target as any).orbitalGroup?.getWorldPosition(pos) ?? pos.set(0, 0, 0);
    const diameter = (target.config as any).diameter ?? 2;
    const viewDist = Math.max(diameter * 25, 500);
    const radial = pos.clone().normalize();
    if (radial.lengthSq() < 0.001) radial.set(0, 1, 0);
    const camPos = pos.clone()
      .addScaledVector(radial, viewDist * 0.5)
      .add(new THREE.Vector3(0, 0, viewDist));
    this.moveCameraTo(camPos, pos, new THREE.Vector3(0, 1, 0), durationMs);
  }

  /**
   * Sets the simulation speed multiplier on the server via WebSocket.
   *
   * @param {number} speed - Time acceleration factor (e.g. `100` = 100× real-time).
   */
  setSimulationSpeed(speed: number): void {
    this.wsService.sendSpeed(speed);
  }

  /**
   * Directly sets the camera controller's base movement speed.
   *
   * @param {number} speed - Target base speed in scene units per second.
   */
  setCameraBaseSpeed(speed: number): void {
    if (this._controls) this._controls.baseMovementSpeed = speed;
  }

  // ─── Selection ─────────────────────────────────────────────────────────────

  /**
   * Performs a raycaster hit-test against all selectable body highlights.
   * Toggles the hit body in the selection set.
   *
   * @param {MouseEvent} event      - The originating mouse click event.
   * @param {boolean}    multiselect - When `true`, clicked bodies are toggled into the set;
   *                                  when `false`, the set is replaced with the single hit.
   */
  handleCanvasClick(event: MouseEvent, multiselect = false): void {
    if (!this.camera || this.selectable.length === 0) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ((event.clientY - rect.top) / rect.height) * -2 + 1,
    );

    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.selectable, false);

    if (hits.length === 0) {
      if (!multiselect) this.clearSelection();
      return;
    }

    // Walk up to find the parent body via its group name convention.
    const hitMesh = hits[0].object;
    const bodyName = this.resolveBodyName(hitMesh);
    if (!bodyName) return;

    if (multiselect) {
      if (this.selectedNames.has(bodyName)) {
        this.selectedNames.delete(bodyName);
        this.setHighlight(bodyName, false);
      } else {
        this.selectedNames.add(bodyName);
        this.setHighlight(bodyName, true);
      }
    } else {
      // Single select — deselect previous, select new.
      for (const prev of this.selectedNames) {
        this.setHighlight(prev, false);
      }
      this.selectedNames.clear();
      this.selectedNames.add(bodyName);
      this.setHighlight(bodyName, true);
    }

    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  /**
   * Programmatically selects one or more body names, replacing any current selection.
   * Also triggers a camera navigation to the first body in the set.
   *
   * @param {string[]} names      - Body names to select.
   * @param {boolean}  [navigate=true] - Whether to animate the camera to the first body.
   */
  selectBodies(names: string[], navigate = true): void {
    for (const prev of this.selectedNames) this.setHighlight(prev, false);
    this.selectedNames.clear();

    for (const name of names) {
      this.selectedNames.add(name);
      this.setHighlight(name, true);
    }

    if (navigate && names.length > 0) this.navigateToPlanet(names[0]);
    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  /**
   * Clears the entire selection set and removes all highlight meshes.
   */
  clearSelection(): void {
    for (const name of this.selectedNames) this.setHighlight(name, false);
    this.selectedNames.clear();
    this.onSelectionChanged?.(new Set());
  }

  // ─── Orbit-line visibility ─────────────────────────────────────────────────

  /**
   * Shows or hides all planet orbit ellipses.
   *
   * @param {boolean} visible - Target visibility state.
   */
  togglePlanetOrbits(visible: boolean): void {
    this.showPlanetOrbits = visible;
    for (const line of this.planetOrbitLines.values()) line.visible = visible;
  }

  /**
   * Shows or hides all moon orbit ellipses.
   *
   * @param {boolean} visible - Target visibility state.
   */
  toggleMoonOrbits(visible: boolean): void {
    this.showMoonOrbits = visible;
    for (const line of this.moonOrbitLines.values()) line.visible = visible;
  }

  /**
   * Toggles the visibility of orbit ellipses for the moons of a specific planet.
   *
   * @param {string}  planetName - Name of the parent planet.
   * @param {boolean} visible    - Target visibility state.
   */
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void {
    const planet = this.star?.satellites.find(p => p.name === planetName);
    if (!planet) return;
    for (const moon of planet.satellites) {
      const line = this.moonOrbitLines.get(moon.name);
      if (line) line.visible = visible;
    }
  }

  // ─── Keyboard input ────────────────────────────────────────────────────────

  /**
   * Handles global keyboard events delegated from the dashboard host listener.
   *
   * - `Space` — toggle flight mode.
   * - `+` / `=` / `NumpadAdd` — increase simulation speed.
   * - `-` / `NumpadSubtract` — decrease simulation speed.
   * - `[` — slower camera movement.
   * - `]` — faster camera movement.
   *
   * @param {KeyboardEvent} event - The originating keyboard event.
   */
  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') {
      event.preventDefault();
      this._controls.toggle();
      return;
    }
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      event.preventDefault();
      this.wsService.sendSpeed(Math.min(10_000, ((this as any)._lastSpeed ?? 1) * 2));
    } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      this.wsService.sendSpeed(Math.max(0.25, ((this as any)._lastSpeed ?? 1) / 2));
    }
    if (event.code === 'BracketLeft') {
      event.preventDefault();
      this._controls.adjustMovementSpeed(-0.1);
    } else if (event.code === 'BracketRight') {
      event.preventDefault();
      this._controls.adjustMovementSpeed(0.1);
    }
  }

  // ─── Internal: scene loading ───────────────────────────────────────────────

  /**
   * Subscribes to the SSE `planets` event and triggers solar-system construction.
   * Idempotent — the `ReplaySubject` in `SseService` replays the last value on subscribe.
   */
  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [] }) => {
      await this.createSolarSystem(planets);
    });
  }

  /**
   * Subscribes to the SSE 'universe' event and triggers solar-system construction.
   * Expect payload: { universe: { stars: [...] }, simulationTime: number }
   */
  loadUniverse(): void {
    this.sseService.on('universe').subscribe(async (payload: any) => {
      try {
        const universe = payload?.universe;
        if (!universe || !Array.isArray(universe.stars) || universe.stars.length === 0) {
          console.warn('[WebGl] SSE universe payload missing star data.');
          return;
        }

        const starObj = universe.stars[0];
        const planetsArray = Array.isArray(starObj.planets) ? [...starObj.planets] : [];
        const planetsPayload = [starObj, ...planetsArray];

        if (typeof payload.simulationTime === 'number') {
          this.simulationTime = payload.simulationTime;
        }

        await this.createSolarSystem(planetsPayload);
      } catch (err) {
        console.error('[WebGl] Failed to process universe SSE payload:', err);
      }
    });
  }

  /**
  * Create a ring mesh from a RingConfig.
  * - inner/outer are expected in scene units (same scale as planet x).
  * - thickness is a visual factor; we use it to set a small extrusion via a second mesh for depth.
  */
  private async createRingMesh(ring: RingConfig, colorFallback = '#ddd'): Promise<THREE.Mesh> {
    const inner = Math.max(0.1, ring.inner ?? 0);
    const outer = Math.max(inner + 0.1, ring.outer ?? (inner + 10));
    const segments = 128;

    // RingGeometry expects innerRadius, outerRadius
    const geom = new THREE.RingGeometry(inner, outer, segments);
    // Flip UVs so texture maps correctly on both sides
    geom.computeVertexNormals();

    // Load texture if provided
    let map: THREE.Texture | null = null;
    if (ring.texture && ring.texture.trim()) {
      try {
        const [t] = await this.textureService.loadMultipleTextures([ring.texture]);
        map = t;
      } catch {
        map = null;
      }
    }

    const mat = new THREE.MeshBasicMaterial({
      color: map ? 0xffffff : (ring.color ? new THREE.Color(ring.color) : new THREE.Color(colorFallback)),
      map: map ?? undefined,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: map ? 0.95 : 0.85,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geom, mat);
    // Slight tilt so ring is visible (if ring has no tilt, keep flat)
    // We'll leave rotation to the owner (if you want ring tilt, set mesh.rotation.x)
    mesh.renderOrder = 10;
    return mesh;
  }

  /**
   * Attach rings for a star and its planets.
   * Called after the star and satellites are built and added to the scene.
   */
  private async addRingsToHierarchy(star: Star): Promise<void> {
    if (!star) return;

    // Helper to attach a ring mesh to an owner group
    const attach = async (owner: any, ringCfg: RingConfig | undefined, isStar = false) => {
      if (!ringCfg) return;
      const mesh = await this.createRingMesh(ringCfg, '#cfcfcf');
      // For planets, attach to the planet.group so it moves with the planet.
      // For star-level belt, attach to star.group.
      const parent = owner.group ?? owner;
      mesh.position.set(0, 0, 0);
      // If the ring has a tilt, apply it (degrees -> radians)
      const tiltDeg = (ringCfg as any).tilt ?? 0;
      mesh.rotation.x = (tiltDeg * Math.PI) / 180;
      parent.add(mesh);
      // store a reference so we can toggle visibility later if needed
      (owner as any).__ringMesh = mesh;
    };

    // Star-level rings (asteroid belt)
    const starCfg = (star.config as any);
    if (Array.isArray(starCfg.rings)) {
      for (const r of starCfg.rings) {
        await attach(star, r, true);
      }
    }

    // Planet-level rings
    for (const planet of star.satellites) {
      const pCfg = (planet.config as any);
      if (Array.isArray(pCfg.rings)) {
        for (const r of pCfg.rings) {
          await attach(planet, r, false);
        }
      }
    }
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find(d => d.name?.toLowerCase() === 'sun');
    if (!sunData) { console.warn('[WebGl] SSE planets payload contains no Sun.'); return; }

    console.log(`Star data: ${sunData}`);

    this.star = await this.starFactory.build(sunData);
    this._controls.setStar(this.star);
    this.scene.add(this.star.group);

    const planetData = dataList.filter(d => d.name?.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetData);
    this.star.updateHierarchy(0);

    this.buildOrbitLines(this.star);
    this.collectSelectable(this.star);
    // console.log('[WebGl] Solar system built — bodies:', Object.keys(this.selectable).length);

    // console.log(this.star);
    // Attach ring meshes for star and planets (textures/colors from RingConfig)
    // this.addRingsToHierarchy(this.star).catch(err => {
    //   console.warn('[WebGl] Failed to add rings:', err);
    // });


    // DEBUG: log all moons
    const logMoons = (body: any) => {
      if (body instanceof OrbitingBody && body.satellites.length) {
        console.log(`🌕 ${body.name} moons:`, body.satellites.map(m => m.name));
      }
      body.satellites?.forEach(logMoons);
    };
    logMoons(this.star);

    // DEBUG: log all rings on stars and planets
    const logRings = (body: any) => {
      // Only consider Star or Planet instances (avoid treating constructors as truthy)
      const isStarOrPlanet = (body instanceof Star) || (body instanceof Planet);

      if (isStarOrPlanet && Array.isArray(body.rings) && body.rings.length > 0) {
        console.log(`🌕 ${body.name} rings:`, body.rings.map((r: any) => r.name ?? '(unnamed)'));
      }

      // Recurse into child bodies (planets -> moons etc.), not into ring objects
      if (Array.isArray(body.satellites)) {
        for (const child of body.satellites) logRings(child);
      }
    };

    // Start from the star object (call the correct function)
    logRings(this.star);

    console.log(this.star);

    console.log('[WebGl] Solar system built — selectable bodies:', this.selectable.length);
  }

  /**
   * Recursively builds Keplerian ellipse `LineLoop` objects for all orbiting bodies.
   * Planets → `planetOrbitLines`; moons → `moonOrbitLines`.
   *
   * @param {any}     body   - Current body in the hierarchy.
   * @param {boolean} isMoon - `true` when `body` is a moon.
   */
  private buildOrbitLines(body: any, isMoon = false): void {
    if (body instanceof OrbitingBody) {
      const a = body.getSemiMajorAxis();
      const e = body.orbitingConfig.eccentricity ?? 0;
      const inc = (body.orbitingConfig.inclination ?? 0) * Math.PI / 180;
      const pts: THREE.Vector3[] = [];

      for (let i = 0; i <= 128; i++) {
        const nu = (i / 128) * 2 * Math.PI;
        const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
        pts.push(new THREE.Vector3(
          r * Math.cos(nu),
          r * Math.sin(nu) * Math.cos(inc),
          r * Math.sin(nu) * Math.sin(inc),
        ));
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const material = new THREE.LineBasicMaterial({
        color: (body.config as any).color || '#ffffff',
        transparent: true,
        opacity: isMoon ? 0.4 : 0.7,
      });
      const line = new THREE.LineLoop(geometry, material);
      line.visible = isMoon ? this.showMoonOrbits : this.showPlanetOrbits;
      this.scene.add(line);

      if (isMoon) this.moonOrbitLines.set(body.name, line);
      else this.planetOrbitLines.set(body.name, line);
    }

    for (const sat of body.satellites ?? []) {
      this.buildOrbitLines(sat, true); // all satellites of planets are moons
    }
  }

  /**
   * Walks the body hierarchy and collects all `highlight` meshes into `selectable`.
   *
   * @param {any} body - Root body to start the walk from.
   */
  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of body.satellites ?? []) this.collectSelectable(sat);
  }

  // ─── Internal: WebSocket orbit integration ─────────────────────────────────

  /**
   * Subscribes to WebSocket messages and applies incoming true-anomaly updates
   * to all orbiting bodies in the scene hierarchy.
   */
  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
          this.simulationTime = data.simulationTime;
          this.applyTrueAnomalies(data.trueAnomalies);
        }
      } catch (err) {
        console.warn('[WebGl] Could not parse WS message:', err);
      }
    });
  }

  /**
   * Recursively applies a map of name→true-anomaly to all orbiting bodies.
   *
   * @param {Record<string, number>} angles - Map of body name → true anomaly in radians.
   */
  private applyTrueAnomalies(angles: Record<string, number>): void {
    const apply = (body: any) => {
      if (body instanceof OrbitingBody && angles[body.name] !== undefined) {
        body.setAngle(angles[body.name]);
      }
      if (body.satellites) {
        for (const sat of body.satellites) apply(sat);
      }
    };
    if (this.star) apply(this.star);
  }

  // ─── Internal: animation loop ──────────────────────────────────────────────

  /**
   * Recursive RAF-based animation loop.
   * Runs: hierarchy update → camera animation tick → controls update → render.
   */
  animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000;

    if (this.star) this.star.updateHierarchy(elapsed);

    this.tickCameraAnim();
    this._controls.update(delta);

    if (elapsed - this.lastSaveMs >= 2000) {
      this.saveCameraState();
      this.lastSaveMs = elapsed;
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Advances the in-progress camera animation by one frame using a cubic ease-out.
   * No-ops when no animation is pending.
   */
  private tickCameraAnim(): void {
    if (!this.cameraAnim) return;
    const t = Math.min((Date.now() - this.cameraAnim.startMs) / this.cameraAnim.durationMs, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(this.cameraAnim.fromPos, this.cameraAnim.toPos, eased);
    this.camera.up.lerpVectors(this.cameraAnim.fromUp, this.cameraAnim.toUp, eased).normalize();
    this.camera.lookAt(this.cameraAnim.lookAt);
    this._controls.syncEuler();
    if (t >= 1) this.cameraAnim = null;
  }

  // ─── Internal: camera persistence ──────────────────────────────────────────

  private restoreCameraState(): void {
    if (this.cameraRestored) return;
    try {
      const raw = sessionStorage.getItem(this.SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        this.camera.position.set(s.px, s.py, s.pz);
        this.camera.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      }
    } catch { /* ignore corrupt session data */ }
    this.cameraRestored = true;
  }

  private saveCameraState(): void {
    try {
      sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({
        px: this.camera.position.x, py: this.camera.position.y, pz: this.camera.position.z,
        qx: this.camera.quaternion.x, qy: this.camera.quaternion.y,
        qz: this.camera.quaternion.z, qw: this.camera.quaternion.w,
      }));
    } catch { /* storage may be full */ }
  }

  // ─── Internal: selection helpers ───────────────────────────────────────────

  /**
   * Resolves a Three.js mesh back to the corresponding celestial body name
   * by inspecting the parent group's naming convention (`${name}_group`).
   *
   * @param {THREE.Object3D} mesh - The hit mesh from the raycaster.
   * @returns {string | null} Body name, or `null` if it cannot be resolved.
   */
  private resolveBodyName(mesh: THREE.Object3D): string | null {
    let obj: THREE.Object3D | null = mesh;
    while (obj) {
      if (obj.name?.endsWith('_group')) {
        return obj.name.replace('_group', '');
      }
      obj = obj.parent;
    }
    return null;
  }

  /**
   * Sets the `visible` flag on the highlight mesh of a named body.
   *
   * @param {string}  name    - Body name.
   * @param {boolean} visible - Desired highlight visibility.
   */
  private setHighlight(name: string, visible: boolean): void {
    const body = this.findBodyByName(name) as any;
    if (body?.highlight) body.highlight.visible = visible;
  }

  /**
   * Searches the full body hierarchy (planets + their moons) for a body by name.
   *
   * @param {string} name - Case-insensitive body name to search for.
   * @returns {any | null} The found body, or `null`.
   */
  findBodyByName(name: string): any | null {
    if (!this.star) return null;
    const lower = name.toLowerCase();
    for (const planet of this.star.satellites) {
      if (planet.name.toLowerCase() === lower) return planet;
      for (const moon of planet.satellites) {
        if (moon.name.toLowerCase() === lower) return moon;
      }
    }
    return null;
  }
}
