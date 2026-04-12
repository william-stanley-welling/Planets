/**
 * @fileoverview Core Three.js rendering service for the heliocentric simulation.
 *
 * Provides:
 *  - `HeliocentricControls` — pointer-lock first-person camera with mass-adaptive speed.
 *  - `WebGl` — Angular service owning the Three.js scene, animation loop,
 *    WebSocket orbit integration, raycasting selection, camera navigation,
 *    ring/asteroid-belt rendering, and navigation-mode management.
 *
 * Navigation modes (stored in localStorage):
 *  - DISCOVERY      — top-down overview; navigates directly above the target.
 *  - CINEMATIC      — oblique follow-cam; geostationary lock tracks the orbit.
 *  - FASTEST_TRAVEL — experimental propulsion stub; queues waypoints.
 *
 * Ring rendering (two-phase):
 *  - Phase 1 (always): solid `THREE.RingGeometry` washer with inclination tilt.
 *  - Phase 2 (opt-in): `THREE.Points` sinusoidal wobble-washer when
 *    `RingConfig.particleCount > 0`.  The asteroid belt uses particles only.
 *
 * @module webgl.service
 */

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import * as THREE from 'three';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import { OrbitingBody, RingConfig, SIMULATION_CONSTANTS } from '../galaxy/celestial.model';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';
import { AssetTextureService } from './asset-texture.service';
import {
  BodySnapshot,
  CameraInfo,
  CameraView,
  ICelestialRenderer,
  NavigationMode,
  SystemSnapshot,
  TravelVesselState,
} from './webgl.interface';

export {
  BodySnapshot,
  CameraInfo, CameraView, NavigationMode, SystemSnapshot, TravelVesselState
} from './webgl.interface';

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
 *  - Mass-adaptive speed scaling: decelerates near massive nearby bodies.
 */
class HeliocentricControls {
  baseMovementSpeed = 3000.0;
  movementSpeed = 3000.0;
  lookSpeed = 0.002;
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

  setStar(star: Star): void { this.starRef = star; }
  get locked(): boolean { return this.isLocked; }
  enterFlight(): void { if (!this.isLocked) { this.domElement.focus(); this.domElement.requestPointerLock(); } }
  exitFlight(): void { document.exitPointerLock(); }
  toggle(): void { this.isLocked ? this.exitFlight() : this.enterFlight(); }

  adjustMovementSpeed(delta: number): void {
    this.baseMovementSpeed = Math.max(100, Math.min(50_000, this.baseMovementSpeed * (1 + delta)));
    this.updateSpeedScale();
  }

  private updateSpeedScale(): void {
    if (!this.starRef) return;
    const camPos = this.camera.position;
    let nearestMass = 0, nearestDistSq = Infinity;
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
    this.movementSpeed = this.baseMovementSpeed * Math.max(0.2, Math.min(1, 1 / (1 + nearestMass / 1e24)));
  }

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

  syncEuler(): void { this.euler.setFromQuaternion(this.camera.quaternion); }

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
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x - e.movementY * this.lookSpeed));
    this.camera.quaternion.setFromEuler(this.euler);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.isLocked) return;
    this.adjustMovementSpeed(e.deltaY > 0 ? -0.1 : 0.1);
  }

  handleResize(): void { }
}

// ---------------------------------------------------------------------------
// WebGl service
// ---------------------------------------------------------------------------

/**
 * Angular service that owns the complete Three.js scene for the solar system.
 *
 * @implements {ICelestialRenderer}
 */
@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {

  readonly scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  active = false;
  selectedNames = new Set<string>();

  private keplerianRings = new Set<THREE.InstancedMesh>();

  get selectedPlanetName(): string | null {
    return this.selectedNames.size > 0
      ? [...this.selectedNames][this.selectedNames.size - 1]
      : null;
  }

  showPlanetOrbits = true;
  showMoonOrbits = false;
  showMoonsOfSelected: boolean;
  navMode: NavigationMode;

  /** Experimental vessel state (stub). */
  readonly vesselState: TravelVesselState = {
    fuel: 1000,
    fuelCapacity: 1000,
    waypoints: [],
    enRoute: false,
    deltaVBudget: 500,
  };

  private readonly clock = new THREE.Clock();
  private _controls!: HeliocentricControls;

  /**
   * Orbit lines for bodies orbiting the star (planets).
   * Parented to the scene, centred at world origin.
   */
  private planetOrbitLines = new Map<string, THREE.LineLoop>();

  /**
   * Orbit lines for bodies orbiting a planet (moons).
   * Parented to the planet's `orbitalGroup` so they track position each frame.
   */
  private moonOrbitLines = new Map<string, THREE.LineLoop>();

  private simulationTimeSubject = new Subject<number>();
  get simulationTime$(): Observable<number> { return this.simulationTimeSubject.asObservable(); }

  private _simulationTime = Date.now();
  get simulationTime(): number { return this._simulationTime; }
  set simulationTime(v: number) {
    this._simulationTime = v;
    this.simulationTimeSubject.next(v);
  }

  get simulationDate(): Date {
    const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
    return new Date(J2000_MS + this._simulationTime);
  }

  private cameraAnim: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    lookAt: THREE.Vector3;
    fromUp: THREE.Vector3; toUp: THREE.Vector3;
    startMs: number; durationMs: number;
  } | null = null;

  /**
   * Cinematic geostationary follow state.
   * When `active`, `animate()` updates the camera every frame to maintain
   * the stored world-space offset from the locked body's orbital group.
   */
  private cinematicFollow: {
    active: boolean;
    bodyName: string;
    /** Camera offset in world space, computed at lock time. */
    worldOffset: THREE.Vector3;
  } = { active: false, bodyName: '', worldOffset: new THREE.Vector3() };

  private readonly SESSION_KEY = 'helio_cam';
  private readonly NAV_MODE_KEY = 'helio_navMode';
  private readonly MOONS_OF_SELECTED_KEY = 'helio_moonsOfSelected';
  private lastSaveMs = 0;
  private cameraRestored = false;

  private readonly raycaster = new THREE.Raycaster();

  onSelectionChanged?: (names: Set<string>) => void;

  private static readonly OUTER_AU = 30.07;
  private static readonly OUTER_SCENE = WebGl.OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

  private static readonly CAMERA_PRESETS: Record<CameraView, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
    [CameraView.OVERVIEW]: { pos: new THREE.Vector3(0, 0, WebGl.OUTER_SCENE * 3.2), up: new THREE.Vector3(0, 1, 0) },
    [CameraView.ECLIPTIC]: { pos: new THREE.Vector3(WebGl.OUTER_SCENE * 2.4, WebGl.OUTER_SCENE * 0.15, 0), up: new THREE.Vector3(0, 0, 1) },
    [CameraView.CINEMATIC]: { pos: new THREE.Vector3(WebGl.OUTER_SCENE * 0.8, WebGl.OUTER_SCENE * 0.6, WebGl.OUTER_SCENE * 2.0), up: new THREE.Vector3(0, 1, 0) },
  };

  constructor(
    private starFactory: StarFactory,
    private sseService: SseService,
    private wsService: WebSocketService,
    private textureService: AssetTextureService,
  ) {
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    // Restore persistent preferences.
    try {
      this.showMoonsOfSelected = localStorage.getItem(this.MOONS_OF_SELECTED_KEY) === 'true';
      const saved = localStorage.getItem(this.NAV_MODE_KEY) as NavigationMode | null;
      this.navMode = Object.values(NavigationMode).includes(saved as NavigationMode)
        ? (saved as NavigationMode)
        : NavigationMode.DISCOVERY;
    } catch {
      this.showMoonsOfSelected = false;
      this.navMode = NavigationMode.DISCOVERY;
    }

    window.addEventListener('wheel', (e) => {
      if (this.navMode === NavigationMode.CINEMATIC && this.cinematicFollow.active) {
        const delta = e.deltaY > 0 ? 1.1 : 0.9;
        this.cinematicFollow.worldOffset.multiplyScalar(delta);
        e.preventDefault();
      }
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

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
    new THREE.CubeTextureLoader().load(skyUrls, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    });
  }

  start(): void {
    this.loadPlanets();
    this.observePlanets();
    this.animate();
    this.active = true;
  }

  resize(height: number, width: number): void {
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  selectInRect(start: THREE.Vector2, end: THREE.Vector2, additive: boolean): void {
    if (!this.camera) return;
    const rect = new THREE.Box2().set(start, end);
    const selected = new Set<string>();

    for (const selectable of this.selectable) {
      // Get the body name from the highlight mesh
      const bodyName = this.resolveBodyName(selectable);
      if (!bodyName) continue;
      // Compute screen position of the body's world position
      const bodyPos = this.getWorldPos(this.findBodyByName(bodyName));
      const screenPos = bodyPos.project(this.camera);
      // Convert from NDC [-1,1] to canvas coordinates (same as start/end)
      const canvasX = (screenPos.x + 1) / 2 * this.renderer.domElement.clientWidth;
      const canvasY = (1 - (screenPos.y + 1) / 2) * this.renderer.domElement.clientHeight;
      if (rect.containsPoint(new THREE.Vector2(canvasX, canvasY))) {
        selected.add(bodyName);
      }
    }

    if (!additive) {
      // Clear previous selection
      for (const name of this.selectedNames) this.setHighlight(name, false);
      this.selectedNames.clear();
    }
    for (const name of selected) {
      if (!this.selectedNames.has(name)) {
        this.selectedNames.add(name);
        this.setHighlight(name, true);
      }
    }
    this.refreshMoonHighlights();
    this.onSelectionChanged?.(new Set(this.selectedNames));
    // Optionally navigate to the new selection
    if (this.selectedNames.size > 0) this.navigateToSelection();
  }

  // ─── Public accessors ──────────────────────────────────────────────────────

  isActive(): boolean { return this.active; }
  getRenderer(): THREE.WebGLRenderer { return this.renderer; }
  getScene(): THREE.Scene { return this.scene; }
  getCamera(): THREE.PerspectiveCamera { return this.camera; }
  get controls(): HeliocentricControls { return this._controls; }

  getCameraInfo(): CameraInfo {
    return {
      position: this.camera.position.clone(),
      direction: this.camera.getWorldDirection(new THREE.Vector3()),
      velocity: this._controls.velocity,
    };
  }

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

  getBodyPhaseAngle(bodyName: string): number {
    if (!this.star) return 0;
    const body = this.star.satellites.find(p => p.name === bodyName) as any;
    if (!body?.orbitalGroup) return 0;
    const bodyPos = body.orbitalGroup.position;
    const camPos = this.camera.position;
    let diff = Math.atan2(camPos.y, camPos.x) - Math.atan2(bodyPos.y, bodyPos.x);
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    return diff;
  }

  getCameraAzimuth(): number {
    if (!this.camera) return 0;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return Math.atan2(dir.x, dir.z);
  }

  resetSimulation(): void {
    this.wsService.sendReset();
  }

  // ─── Navigation mode ───────────────────────────────────────────────────────

  /**
   * Switches the camera navigation mode, repositions the camera to the mode's
   * canonical starting position, and persists the choice to `localStorage`.
   *
   * - DISCOVERY      → top-down overview above the solar disc.
   * - CINEMATIC      → cinematic oblique preset; re-locks to current selection if any.
   * - FASTEST_TRAVEL → does not reposition; vessel retains current position.
   *
   * @param {NavigationMode} mode - Target navigation mode.
   */
  setNavigationMode(mode: NavigationMode): void {
    this.navMode = mode;
    this.cinematicFollow.active = false; // clear any active lock first

    try { localStorage.setItem(this.NAV_MODE_KEY, mode); } catch { /* storage unavailable */ }

    switch (mode) {
      case NavigationMode.DISCOVERY:
        // Fly to top-down overview.
        this.moveCameraTo(
          WebGl.CAMERA_PRESETS[CameraView.OVERVIEW].pos,
          new THREE.Vector3(),
          new THREE.Vector3(0, 1, 0),
          2000,
        );
        break;

      case NavigationMode.CINEMATIC:
        // If a body is already selected, activate cinematic lock on it.
        if (this.selectedPlanetName) {
          this.navigateToPlanet(this.selectedPlanetName, 2000);
        } else {
          this.moveCameraTo(
            WebGl.CAMERA_PRESETS[CameraView.CINEMATIC].pos,
            new THREE.Vector3(),
            new THREE.Vector3(0, 1, 0),
            2000,
          );
        }
        break;

      case NavigationMode.FASTEST_TRAVEL:
        // Stub: vessel stays put; do not reposition.
        break;
    }
  }

  // ─── Camera navigation ─────────────────────────────────────────────────────

  moveCameraTo(
    toPos: THREE.Vector3,
    lookAt: THREE.Vector3 = new THREE.Vector3(),
    toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
    durationMs = 1800,
  ): void {
    // Break any active cinematic lock unless we are about to set a new one.
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

  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = WebGl.CAMERA_PRESETS[view];
    this.cinematicFollow.active = false;
    this.moveCameraTo(preset.pos, new THREE.Vector3(), preset.up, durationMs);
  }

  /**
   * Navigates to a named body.  Behaviour is mode-dependent:
   *
   * **DISCOVERY** — flies high above the body looking straight down so the
   * target body and all its moons are visible on screen.
   *
   * **CINEMATIC** — flies to an oblique offset then activates geostationary
   * orbital follow so the camera travels with the body's orbit.
   *
   * **FASTEST_TRAVEL** — queues a waypoint; does not move immediately unless
   * the vessel can plot a valid route.
   */
  navigateToPlanet(bodyName: string, durationMs = 2200): void {
    if (this.navMode === NavigationMode.FASTEST_TRAVEL) {
      this.queueWaypoint(bodyName);
      return;
    }

    const target = this.findBodyByName(bodyName);
    if (!target) return;

    const targetPos = this.getWorldPos(target);
    const diameter = (target.config as any).diameter ?? 2;

    // Collect moon positions to include them in the bounding frame.
    const boundsPositions: THREE.Vector3[] = [targetPos];
    for (const moon of (target as any).satellites ?? []) {
      boundsPositions.push(this.getWorldPos(moon));
    }

    const { centroid, maxRadius } = this.boundingSphere(boundsPositions);

    if (this.navMode === NavigationMode.DISCOVERY) {
      // Top-down: position directly above the centroid looking down.
      const altitude = Math.max(maxRadius * 3.5, diameter * 40, 800);
      const camPos = centroid.clone().add(new THREE.Vector3(0, 0, altitude));
      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
      return;
    }

    if (this.navMode === NavigationMode.CINEMATIC) {
      // Oblique offset: pull back along the radial direction plus up and forward.
      const radial = targetPos.clone().normalize();
      if (radial.lengthSq() < 0.001) radial.set(1, 0, 0);
      const viewDist = Math.max(maxRadius * 4.0, diameter * 50, 1000);
      const camPos = centroid.clone()
        .addScaledVector(radial, viewDist * 0.4)
        .add(new THREE.Vector3(0, viewDist * 0.3, viewDist * 0.7));

      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);

      // Activate geostationary lock after the animation completes.
      setTimeout(() => {
        if (this.navMode !== NavigationMode.CINEMATIC) return;
        const freshPos = this.getWorldPos(this.findBodyByName(bodyName) ?? target);
        this.cinematicFollow = {
          active: true,
          bodyName,
          worldOffset: this.camera.position.clone().sub(freshPos),
        };
      }, durationMs + 50);
    }
  }

  /**
   * Repositions the camera to frame all currently selected bodies.
   * Moon satellites of selected planets are included in the bounding sphere.
   *
   * When only one body is selected, delegates to {@link navigateToPlanet}.
   */
  navigateToSelection(durationMs = 2200): void {
    if (!this.star || this.selectedNames.size === 0) return;

    if (this.selectedNames.size === 1) {
      this.navigateToPlanet([...this.selectedNames][0], durationMs);
      return;
    }

    const positions: THREE.Vector3[] = [];
    for (const name of this.selectedNames) {
      const body = this.findBodyByName(name) as any;
      if (!body) continue;
      positions.push(this.getWorldPos(body));
      // Include moons of selected planets.
      for (const moon of body.satellites ?? []) {
        positions.push(this.getWorldPos(moon));
      }
    }
    if (positions.length === 0) return;

    const { centroid, maxRadius } = this.boundingSphere(positions);

    if (this.navMode === NavigationMode.DISCOVERY) {
      const altitude = Math.max(maxRadius * 3.5, 1500);
      const camPos = centroid.clone().add(new THREE.Vector3(0, 0, altitude));
      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
    } else {
      // CINEMATIC (multi) and FASTEST_TRAVEL both use oblique framing;
      // multi-select disables cinematic lock.
      const viewDist = Math.max(maxRadius * 3.0, 1500);
      const camPos = centroid.clone().add(new THREE.Vector3(0, viewDist * 0.45, viewDist));
      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
    }
  }

  setSimulationSpeed(speed: number): void { this.wsService.sendSpeed(speed); }

  setCameraBaseSpeed(speed: number): void {
    if (this._controls) this._controls.baseMovementSpeed = speed;
  }

  // ─── Selection ─────────────────────────────────────────────────────────────

  handleCanvasClick(event: MouseEvent, multiselect = false): void {
    if (!this.camera || this.selectable.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ((event.clientY - rect.top) / rect.height) * -2 + 1,
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.selectable, false);
    if (hits.length === 0) { if (!multiselect) this.clearSelection(); return; }

    const bodyName = this.resolveBodyName(hits[0].object);
    if (!bodyName) return;

    if (multiselect) {
      if (this.selectedNames.has(bodyName)) {
        this.selectedNames.delete(bodyName);
        this.setHighlight(bodyName, false);
      } else {
        this.selectedNames.add(bodyName);
        this.setHighlight(bodyName, true);
      }
      if (this.selectedNames.size > 1) this.navigateToSelection();
    } else {
      for (const prev of this.selectedNames) this.setHighlight(prev, false);
      this.selectedNames.clear();
      this.selectedNames.add(bodyName);
      this.setHighlight(bodyName, true);

      // In cinematic mode, a click on a body immediately locks onto it.
      if (this.navMode === NavigationMode.CINEMATIC) {
        this.navigateToPlanet(bodyName);
      }
    }
    this.refreshMoonHighlights();
    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  selectBodies(names: string[], navigate = true): void {
    for (const prev of this.selectedNames) this.setHighlight(prev, false);
    this.selectedNames.clear();
    for (const name of names) { this.selectedNames.add(name); this.setHighlight(name, true); }
    if (navigate) {
      names.length === 1 ? this.navigateToPlanet(names[0]) : this.navigateToSelection();
    }
    this.refreshMoonHighlights();
    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  clearSelection(): void {
    for (const name of this.selectedNames) this.setHighlight(name, false);
    this.selectedNames.clear();
    this.cinematicFollow.active = false;
    this.refreshMoonHighlights();
    this.onSelectionChanged?.(new Set());
  }

  // ─── Orbit-line visibility ─────────────────────────────────────────────────

  /** Shows or hides all planet orbit lines only.  Moon lines are unaffected. */
  togglePlanetOrbits(visible: boolean): void {
    this.showPlanetOrbits = visible;
    for (const line of this.planetOrbitLines.values()) line.visible = visible;
  }

  /** Shows or hides all moon orbit lines only.  Planet lines are unaffected. */
  toggleMoonOrbits(visible: boolean): void {
    this.showMoonOrbits = visible;
    for (const line of this.moonOrbitLines.values()) line.visible = visible;
  }

  /** Toggles moon orbit lines for one specific planet without touching the global flag. */
  toggleMoonsOfPlanet(planetName: string, visible: boolean): void {
    const planet = this.star?.satellites.find(p => p.name === planetName);
    if (!planet) return;
    for (const moon of planet.satellites) {
      const line = this.moonOrbitLines.get(moon.name);
      if (line) line.visible = visible;
    }
  }

  // ─── Moon-of-selected highlighting ─────────────────────────────────────────

  /** Toggles the "moons of selected" flag and persists it to localStorage. */
  toggleShowMoonsOfSelected(): boolean {
    this.showMoonsOfSelected = !this.showMoonsOfSelected;
    try { localStorage.setItem(this.MOONS_OF_SELECTED_KEY, String(this.showMoonsOfSelected)); } catch { }
    this.refreshMoonHighlights();
    return this.showMoonsOfSelected;
  }

  /**
   * Re-evaluates moon highlight visibility.
   * Moon halos are shown only when `showMoonsOfSelected` is on AND the moon's
   * parent planet is currently in `selectedNames`.
   */
  private refreshMoonHighlights(): void {
    if (!this.star) return;
    for (const planet of this.star.satellites) {
      const parentSelected = this.selectedNames.has(planet.name);
      for (const moon of planet.satellites) {
        const mb = moon as any;
        if (mb.highlight) mb.highlight.visible = this.showMoonsOfSelected && parentSelected;
      }
    }
  }

  // ─── Fastest-travel stub ───────────────────────────────────────────────────

  /**
   * Adds a body name to the vessel's waypoint queue.
   * Stub: does not compute trajectories yet.
   *
   * @param {string} bodyName - Target body name.
   */
  queueWaypoint(bodyName: string): void {
    if (!this.vesselState.waypoints.includes(bodyName)) {
      this.vesselState.waypoints.push(bodyName);
    }
    // TODO: compute Hohmann-transfer Δv and initiate route if fuel permits.
    console.info(`[FastestTravel] Waypoint queued: ${bodyName}. Route planning TBD.`);
  }

  /** Clears all queued waypoints and cancels autonomous travel. */
  clearWaypoints(): void {
    this.vesselState.waypoints = [];
    this.vesselState.enRoute = false;
  }

  // ─── Keyboard input ────────────────────────────────────────────────────────

  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') { event.preventDefault(); this._controls.toggle(); return; }
    if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); this.wsService.sendSpeed(Math.min(10_000, ((this as any)._lastSpeed ?? 1) * 2)); }
    if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); this.wsService.sendSpeed(Math.max(0.25, ((this as any)._lastSpeed ?? 1) / 2)); }
    if (event.code === 'BracketLeft') { event.preventDefault(); this._controls.adjustMovementSpeed(-0.1); }
    if (event.code === 'BracketRight') { event.preventDefault(); this._controls.adjustMovementSpeed(0.1); }
  }

  // ─── Internal: scene loading ───────────────────────────────────────────────

  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [] }) => {
      await this.createSolarSystem(planets);
    });
  }

  loadUniverse(): void {
    this.sseService.on('universe').subscribe(async (payload: any) => {
      try {
        const universe = payload?.universe;
        if (!universe?.stars?.length) { console.warn('[WebGl] No star data in universe payload.'); return; }
        const starObj = universe.stars[0];
        const planetsArray = Array.isArray(starObj.planets) ? [...starObj.planets] : [];
        if (typeof payload.simulationTime === 'number') this.simulationTime = payload.simulationTime;
        await this.createSolarSystem([starObj, ...planetsArray]);
      } catch (err) { console.error('[WebGl] Failed to process universe payload:', err); }
    });
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find(d => d.name?.toLowerCase() === 'sun');
    if (!sunData) { console.warn('[WebGl] No Sun in SSE payload.'); return; }

    this.star = await this.starFactory.build(sunData);
    this._controls.setStar(this.star);
    this.scene.add(this.star.group);

    const planetData = dataList.filter(d => d.name?.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetData);
    this.star.updateHierarchy(0);

    this.buildOrbitLines(this.star);
    this.collectSelectable(this.star);
    await this.buildRings(this.star, sunData);

    console.log('[WebGl] Solar system ready — selectable:', this.selectable.length);
  }

  // ─── Internal: orbit lines ─────────────────────────────────────────────────

  /**
   * Recursively builds Keplerian ellipse `LineLoop` objects.
   *
   * Classification: the star is not an `OrbitingBody` so its satellites (planets)
   * use the scene as parent → planet lines.  A planet's satellites (moons) use the
   * planet's `orbitalGroup` as parent → moon lines that translate with the planet.
   */
  private buildOrbitLines(
    body: any,
    parentGroup: THREE.Group | THREE.Scene = this.scene,
  ): void {
    if (!(body instanceof OrbitingBody)) {
      // Star level: recurse directly into children at scene level.
      for (const sat of body.satellites ?? []) this.buildOrbitLines(sat, this.scene);
      return;
    }

    const isMoon = parentGroup !== (this.scene as unknown);
    const a = body.getSemiMajorAxis();
    const e = body.orbitingConfig.eccentricity ?? 0;
    const inc = (body.orbitingConfig.inclination ?? 0) * Math.PI / 180;
    const pts: THREE.Vector3[] = [];

    for (let i = 0; i <= 128; i++) {
      const nu = (i / 128) * 2 * Math.PI;
      const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
      pts.push(new THREE.Vector3(r * Math.cos(nu), r * Math.sin(nu) * Math.cos(inc), r * Math.sin(nu) * Math.sin(inc)));
    }

    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: (body.config as any).color || (isMoon ? '#aaaadd' : '#ffffff'),
        transparent: true,
        opacity: isMoon ? 0.5 : 0.75,
      }),
    );
    line.visible = isMoon ? this.showMoonOrbits : this.showPlanetOrbits;
    parentGroup.add(line);

    if (isMoon) this.moonOrbitLines.set(body.name, line);
    else this.planetOrbitLines.set(body.name, line);

    for (const sat of body.satellites ?? []) this.buildOrbitLines(sat, body.orbitalGroup);
  }

  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of body.satellites ?? []) this.collectSelectable(sat);
  }

  // ─── Internal: ring rendering ──────────────────────────────────────────────

  // ⭐ NEW: Build asteroid belt or planetary ring using Perlin noise and individual sphere meshes (instanced for performance)
  private async buildParticleRingMesh(
    inner: number,
    outer: number,
    count: number,
    tiltDeg: number,
    thickness: number,
    color: string,
    textureUrl: string | undefined,
    keplerian: boolean,
    parentGroup: THREE.Group,
  ): Promise<void> {
    // Load asteroid texture once
    let texture: THREE.Texture | undefined;
    if (textureUrl) {
      const tex = await this.textureService.loadMultipleTextures([textureUrl]);
      if (tex[0]?.image) texture = tex[0];
    }
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: texture ? 0xffffff : new THREE.Color(color),
      roughness: 0.8,
      metalness: 0.2,
    });

    const noise = new ImprovedNoise();
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    // Prepare positions and scales
    const positions: THREE.Vector3[] = [];
    const scales: number[] = [];

    for (let i = 0; i < count; i++) {
      // Radial distribution: more particles near the middle using noise
      let r = inner + Math.random() * (outer - inner);
      // Use 3D noise to modulate density: sample at (r, angle, 0)
      const angle = Math.random() * 2 * Math.PI;
      const noiseVal = noise.noise(r * 0.1, angle, 0);
      // Probability of keeping particle based on noise (higher near middle)
      const prob = Math.max(0, Math.min(1, 1 - Math.abs(r - (inner + outer) / 2) / ((outer - inner) / 2) * 0.8 + noiseVal * 0.3));
      if (Math.random() > prob) continue; // cull particle

      // Vertical scatter: thicker in middle, thinning out
      let z: number;
      if (keplerian) {
        // Asteroid belt: puffier
        z = (Math.random() - 0.5) * 2 * thickness * r * (1 - Math.abs(r - (inner + outer) / 2) / ((outer - inner) / 2) * 0.5);
      } else {
        // Planetary ring: sinusoidal wobble
        const waves = 6;
        z = Math.sin(angle * waves) * thickness * r * 0.15;
      }

      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);
      // Apply tilt
      const px = x;
      const py = y * cosT - z * sinT;
      const pz = y * sinT + z * cosT;
      positions.push(new THREE.Vector3(px, py, pz));

      // Random size between 0.5 and 2.0
      scales.push(0.5 + Math.random() * 1.5);
    }

    if (positions.length === 0) return;

    // Use InstancedMesh for performance
    const geometry = new THREE.SphereGeometry(1, 8, 8);
    const instancedMesh = new THREE.InstancedMesh(geometry, material, positions.length);
    instancedMesh.castShadow = true;
    instancedMesh.receiveShadow = false;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < positions.length; i++) {
      dummy.position.copy(positions[i]);
      dummy.scale.set(scales[i], scales[i], scales[i]);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;

    parentGroup.add(instancedMesh);

    // Store rotation data for Keplerian motion if needed
    if (keplerian) {
      // For simplicity, we'll rotate the entire instanced mesh around Y axis over time
      // In animate loop: if ring has keplerianRotation, rotate group
      (instancedMesh.userData as any) = { keplerian, angularSpeed: 0.01 }; // approximate


      this.keplerianRings.add(instancedMesh);
    }
  }

  /**
   * Builds ring systems for the star (asteroid belt) and all planets.
   *
   * **Unit note**: `RingConfig.inner` and `RingConfig.outer` in `universe.json`
   * are stored as heliocentric scene units (same axis as planet `x`).
   *  - For star-level rings (asteroid belt) these are used directly.
   *  - For planet-level rings the planet's semi-major axis is subtracted to
   *    obtain a planet-local radius.  If the result is non-positive (data
   *    artefact in current universe.json) the ring falls back to
   *    `planet.diameter × 1.3` (inner) and `planet.diameter × 2.5` (outer).
   *
   * Phase 1 (solid washer) is always rendered.
   * Phase 2 (particle cloud) is layered on top when `particleCount > 0`.
   * The asteroid belt uses Phase 2 only (no solid disc).
   *
   * @param {Star} star     - Root star whose ring array holds the asteroid belt.
   * @param {any}  starData - Raw SSE star payload (contains nested planet arrays).
   */
  private async buildRings(star: Star, starData: any): Promise<void> {
    // ── Star-level rings (asteroid belt) ──────────────────────────────────────
    const starRings: RingConfig[] = Array.isArray((star.config as any).rings)
      ? (star.config as any).rings
      : (Array.isArray(starData.rings) ? starData.rings : []);

    for (const ring of starRings) {
      if (!ring?.name) continue;
      const inner = Math.max(0.1, ring.inner ?? 0);
      const outer = Math.max(inner + 1, ring.outer ?? (inner + 100));
      const tiltDeg = (ring as any).tilt ?? 0;

      // Asteroid belt: particles only (no solid disc — it's not a uniform ring).
      if ((ring.particleCount ?? 0) > 0) {
        // Inside buildRings, for asteroid belt:
        await this.buildParticleRingMesh(
          inner, outer, ring.particleCount!, tiltDeg, ring.thickness ?? 0.5,
          ring.color ?? '#b0a090', ring.texture, true, this.scene
        );
        // const pts = this.buildParticleRing(inner, outer, ring.particleCount!, tiltDeg, ring.thickness ?? 0.05, true);
        // const points = new THREE.Points(
        //   new THREE.BufferGeometry().setFromPoints(pts),
        //   new THREE.PointsMaterial({ color: ring.color ?? '#b0a090', size: 4, sizeAttenuation: true }),
        // );
        // points.name = `ring_${ring.name}_particles`;
        // this.scene.add(points);
      } else {
        // Solid washer fallback for star rings without particle count.
        const mesh = this.buildWasher(inner, outer, tiltDeg, ring.color ?? '#b0a090', ring.texture);
        mesh.name = `ring_${ring.name}_washer`;
        this.scene.add(mesh);
      }
    }

    // ── Planet-level rings ────────────────────────────────────────────────────
    for (const planet of star.satellites) {
      const pCfg = planet.config as any;
      const rings: RingConfig[] = Array.isArray(pCfg.rings) ? pCfg.rings : [];
      if (rings.length === 0) continue;

      const sma = (planet as any).getSemiMajorAxis?.() ?? 0;
      const diameter = pCfg.diameter ?? 2;

      for (const ring of rings) {
        if (!ring?.name) continue;

        // Derive planet-local ring radii.
        let localInner = (ring.inner ?? 0) - sma;
        let localOuter = (ring.outer ?? 0) - sma;

        // Fallback when heliocentric subtraction yields non-positive radii.
        if (localInner <= 0 || localOuter <= localInner) {
          localInner = diameter * 1.3;
          localOuter = diameter * 2.5;
        }

        const tiltDeg = (ring as any).tilt ?? 0;
        const orbGroup = (planet as any).orbitalGroup as THREE.Group;

        // Phase 1: solid washer (always).
        const washer = this.buildWasher(localInner, localOuter, tiltDeg, ring.color ?? '#e8d8b0', ring.texture);
        washer.name = `ring_${ring.name}_washer`;
        orbGroup.add(washer);

        // Phase 2: particle overlay when particleCount > 0.
        if ((ring.particleCount ?? 0) > 0) {
          // For planetary rings:
          if ((ring.particleCount ?? 0) > 0) {
            await this.buildParticleRingMesh(
              localInner, localOuter, ring.particleCount!, tiltDeg, ring.thickness ?? 0.02,
              ring.color ?? '#e8d8b0', ring.texture, false, orbGroup
            );
          }
          // const pts = this.buildParticleRing(localInner, localOuter, ring.particleCount!, tiltDeg, ring.thickness ?? 0.02, false);
          // const points = new THREE.Points(
          //   new THREE.BufferGeometry().setFromPoints(pts),
          //   new THREE.PointsMaterial({ color: ring.color ?? '#e8d8b0', size: 2, sizeAttenuation: true }),
          // );
          // points.name = `ring_${ring.name}_particles`;
          // orbGroup.add(points);
        }

        console.log(`[WebGl] Ring built: ${ring.name} local r=[${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
      }
    }
  }

  /**
   * Builds a flat `THREE.RingGeometry` washer mesh.
   *
   * @param {number}  inner    - Inner radius in scene units.
   * @param {number}  outer    - Outer radius in scene units (clamped > inner).
   * @param {number}  tiltDeg  - Inclination tilt in degrees (rotation around X-axis).
   * @param {string}  color    - CSS hex fallback colour.
   * @param {string}  [texture] - Optional texture URL.
   * @returns {THREE.Mesh} The washer mesh, ready to add to a group.
   */
  private buildWasher(
    inner: number,
    outer: number,
    tiltDeg: number,
    color: string,
    texture?: string,
  ): THREE.Mesh {
    const safeInner = Math.max(0.1, inner);
    const safeOuter = Math.max(safeInner + 0.1, outer);

    const geom = new THREE.RingGeometry(safeInner, safeOuter, 128);

    // Fix RingGeometry UVs so a ring texture maps radially (u = 0→1 from inner→outer).
    const pos = geom.attributes['position'] as THREE.BufferAttribute;
    const uvAttr = geom.attributes['uv'] as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      const u = (r - safeInner) / (safeOuter - safeInner);
      const v = (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1;
      uvAttr.setXY(i, u, v);
    }
    uvAttr.needsUpdate = true;
    geom.computeVertexNormals();

    // Attempt texture load (fire-and-forget; material updates reactively).
    let map: THREE.Texture | undefined;
    if (texture?.trim()) {
      this.textureService.loadMultipleTextures([texture]).then(([t]) => {
        if (t.image && mat.map !== t) {
          t.colorSpace = THREE.SRGBColorSpace;
          mat.map = t;
          mat.needsUpdate = true;
        }
      });
    }

    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = (tiltDeg * Math.PI) / 180;
    mesh.renderOrder = 5;
    return mesh;
  }

  /**
   * Generates point positions for a sinusoidal wobble-washer particle ring.
   *
   * Each point is placed at a random radius between `inner` and `outer`,
   * at a random azimuthal angle.  When `scatter` is true (asteroid belt mode)
   * the vertical scatter is proportional to `thickness × radius` so the belt
   * has a realistic puffiness.  For planetary rings the wobble is a small
   * sinusoidal wave to simulate the ring's slight corrugation.
   *
   * @param {number}  inner         - Inner radius (scene units).
   * @param {number}  outer         - Outer radius (scene units).
   * @param {number}  count         - Number of points.
   * @param {number}  tiltDeg       - Inclination tilt (degrees, X-axis rotation applied to positions).
   * @param {number}  thickness     - Vertical scatter factor.
   * @param {boolean} scatter       - `true` for random asteroid-belt scatter; `false` for sinusoidal wobble.
   * @returns {THREE.Vector3[]} Array of point positions.
   */
  private buildParticleRing(
    inner: number,
    outer: number,
    count: number,
    tiltDeg: number,
    thickness: number,
    scatter: boolean,
  ): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * 2 * Math.PI;
      const r = inner + Math.random() * (outer - inner);

      let z: number;
      if (scatter) {
        // Random vertical scatter — asteroid belt puffiness.
        z = (Math.random() - 0.5) * 2 * thickness * r;
      } else {
        // Sinusoidal wobble — planetary ring corrugation.
        const waves = 6;
        z = Math.sin(angle * waves) * thickness * r * 0.15;
      }

      // Flat ring position.
      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);

      // Apply inclination tilt (rotate around X-axis).
      pts.push(new THREE.Vector3(x, y * cosT - z * sinT, y * sinT + z * cosT));
    }
    return pts;
  }

  // ─── Internal: WebSocket orbit integration ─────────────────────────────────

  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
          this.simulationTime = data.simulationTime;
          this.applyTrueAnomalies(data.trueAnomalies);
        }
      } catch (err) { console.warn('[WebGl] WS parse error:', err); }
    });
  }

  private applyTrueAnomalies(angles: Record<string, number>): void {
    const apply = (body: any) => {
      if (body instanceof OrbitingBody && angles[body.name] !== undefined) body.setAngle(angles[body.name]);
      if (body.satellites) for (const sat of body.satellites) apply(sat);
    };
    if (this.star) apply(this.star);
  }

  // ─── Internal: animation loop ──────────────────────────────────────────────

  animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000;

    if (this.star) this.star.updateHierarchy(elapsed);

    // Cinematic geostationary follow: override camera every frame while locked.
    if (this.cinematicFollow.active && this.navMode === NavigationMode.CINEMATIC && !this.cameraAnim) {
      const body = this.findBodyByName(this.cinematicFollow.bodyName) as any;
      if (body) {
        const bodyPos = this.getWorldPos(body);
        this.camera.position.copy(bodyPos).add(this.cinematicFollow.worldOffset);
        this.camera.lookAt(bodyPos);
        this._controls.syncEuler();
      }
    }

    // Rotate asteroid belt (Keplerian motion) ***THIS DOESNT WORK!!***
    // this.scene.children.forEach(child => {
    //   if (child.isInstancedMesh && child.userData?.keplerian) {
    //     child.rotation.y += 0.005; // very slow drift
    //   }
    // });

    // Rotate asteroid belt (Keplerian motion)
    const deltaSec = this.clock.getDelta();
    for (const ring of this.keplerianRings) {
      // Approximate orbital angular speed: 2π / (period in seconds)
      // For simplicity, use a fixed small increment per frame
      ring.rotation.y += 0.002 * (deltaSec * 60); // scale with frame rate
    }

    this.tickCameraAnim();
    this._controls.update(delta);

    if (elapsed - this.lastSaveMs >= 2000) { this.saveCameraState(); this.lastSaveMs = elapsed; }

    this.renderer.render(this.scene, this.camera);
  }

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
    } catch { }
    this.cameraRestored = true;
  }

  private saveCameraState(): void {
    try {
      sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({
        px: this.camera.position.x, py: this.camera.position.y, pz: this.camera.position.z,
        qx: this.camera.quaternion.x, qy: this.camera.quaternion.y,
        qz: this.camera.quaternion.z, qw: this.camera.quaternion.w,
      }));
    } catch { }
  }

  // ─── Internal: helpers ─────────────────────────────────────────────────────

  private resolveBodyName(mesh: THREE.Object3D): string | null {
    let obj: THREE.Object3D | null = mesh;
    while (obj) {
      if (obj.name?.endsWith('_group')) return obj.name.replace('_group', '');
      obj = obj.parent;
    }
    return null;
  }

  setHighlight(name: string, visible: boolean): void {
    const body = this.findBodyByName(name) as any;
    if (body?.highlight) body.highlight.visible = visible;
  }

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

  /**
   * Returns the world position of a body's moving point (orbitalGroup preferred,
   * falls back to group centre).
   */
  private getWorldPos(body: any): THREE.Vector3 {
    const pos = new THREE.Vector3();
    const group = body.orbitalGroup ?? body.group;
    if (group) group.getWorldPosition(pos);
    return pos;
  }

  /**
   * Computes the centroid and maximum radius of a set of positions.
   */
  private boundingSphere(positions: THREE.Vector3[]): { centroid: THREE.Vector3; maxRadius: number } {
    const centroid = new THREE.Vector3();
    for (const p of positions) centroid.add(p);
    centroid.divideScalar(positions.length);
    let maxRadius = 0;
    for (const p of positions) maxRadius = Math.max(maxRadius, centroid.distanceTo(p));
    return { centroid, maxRadius };
  }
}
