/**
 * @fileoverview Core Three.js rendering service for the heliocentric simulation.
 * @module webgl.service
 *
 * Bug fixes applied:
 *  1. resetSimulation() now immediately updates local simulationTime + forces render.
 *  2. Asteroid belt split into 3 differential-rotation Keplerian zones; uniform random distribution.
 *  3. Asteroid particle size capped to configurable small value (not belt-width / 200).
 *  4. Planet rings: ring.inner / ring.outer used directly (not minus sma); fallback uses VISUAL_SCALE.
 *  5. getCameraAzimuth() fixed to XY-plane (atan2(dir.x, dir.y)) matching minimap projection.
 *  6. contextmenu suppressed; star added to selectable set; selection ordered hierarchically.
 *     findBodyByName now also matches the star itself.
 *
 * New feature: Navigation Route (FASTEST_TRAVEL mode)
 *  - Waypoints: named bodies OR world-XY coordinates.
 *  - 3-D dashed path line rendered in scene.
 *  - Engage route: camera flies autonomously, user may still rotate (look around).
 *  - Geostationary orbit at each waypoint for configurable durationSec.
 *  - Optional loop route.
 */

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import * as THREE from 'three';
import { OrbitingBody, RingConfig, SIMULATION_CONSTANTS, VISUAL_SCALE } from '../galaxy/celestial.model';
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
  NavigationRoute,
  SystemSnapshot,
  TravelVesselState
} from './webgl.interface';

export {
  BodySnapshot,
  CameraInfo, CameraView, NavigationMode, NavigationRoute, NavigationWaypoint, SystemSnapshot, TravelVesselState
} from './webgl.interface';

// ---------------------------------------------------------------------------
// HeliocentricControls
// ---------------------------------------------------------------------------
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
  toggle(): void {
    if (this.isLocked) {
      this.exitFlight();
    } else {
      try { this.enterFlight(); }
      catch (err) { console.warn('Pointer lock not allowed right now.'); }
    }
  }

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

  /** Apply only the rotational part of a mouse event (used during route mode). */
  applyLookDelta(dx: number, dy: number): void {
    this.euler.y -= dx * this.lookSpeed;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x - dy * this.lookSpeed));
    this.camera.quaternion.setFromEuler(this.euler);
  }

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
@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {

  readonly scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  active = false;
  selectedNames = new Set<string>();

  private keplerianRings = new Set<THREE.InstancedMesh | THREE.Mesh>();

  get selectedPlanetName(): string | null {
    return this.selectedNames.size > 0
      ? [...this.selectedNames][this.selectedNames.size - 1]
      : null;
  }

  showPlanetOrbits = true;
  showMoonOrbits = false;
  showMoonsOfSelected: boolean;
  navMode: NavigationMode;

  /** @deprecated kept for template compatibility */
  readonly vesselState: TravelVesselState = {
    fuel: 1000, fuelCapacity: 1000, waypoints: [], enRoute: false, deltaVBudget: 500,
  };

  // ── Navigation Route state ────────────────────────────────────────────────
  readonly navRoute: NavigationRoute = {
    waypoints: [],
    loop: false,
    active: false,
    currentIndex: 0,
    progress: 0,
    orbitRemaining: 0,
  };

  private navPathLine: THREE.Line | null = null;
  private navRouteFromPos = new THREE.Vector3();
  private navRouteTravelSpeed = 2000; // scene units/sec
  private navOrbitAngle = 0;
  private navOrbitRadius = 0;
  private navOrbitCenter = new THREE.Vector3();

  private readonly clock = new THREE.Clock();
  private _controls!: HeliocentricControls;

  private planetOrbitLines = new Map<string, THREE.LineLoop>();
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
    const time = this._simulationTime;
    if (typeof time !== 'number' || isNaN(time)) return new Date();
    return new Date(time);
  }

  private lastSimTime: number | undefined;

  private cameraAnim: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    lookAt: THREE.Vector3;
    fromUp: THREE.Vector3; toUp: THREE.Vector3;
    startMs: number; durationMs: number;
  } | null = null;

  private cinematicFollow: {
    active: boolean;
    bodyName: string;
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
    [CameraView.OVERVIEW]: { pos: new THREE.Vector3(0, WebGl.OUTER_SCENE * 2, WebGl.OUTER_SCENE * 2), up: new THREE.Vector3(0, 1, 0) },
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

  // ─── Bug 6 fix: rect selection includes star; box uses canvas coords ───────
  selectInRect(start: { x: number; y: number }, end: { x: number; y: number }, additive: boolean): void {
    if (!this.camera) return;
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;

    const selected = new Set<string>();

    for (const selectable of this.selectable) {
      const bodyName = this.resolveBodyName(selectable);
      if (!bodyName) continue;
      const body = this.findBodyByName(bodyName);
      if (!body) continue;
      const bodyPos = this.getWorldPos(body);
      const ndc = bodyPos.clone().project(this.camera);
      const canvasX = (ndc.x + 1) / 2 * W;
      const canvasY = (1 - (ndc.y + 1) / 2) * H;
      if (canvasX >= minX && canvasX <= maxX && canvasY >= minY && canvasY <= maxY) {
        selected.add(bodyName);
      }
    }

    if (!additive) {
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
          x: pos.x, y: pos.z,
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
    // let diff = Math.atan2(camPos.y, camPos.x) - Math.atan2(bodyPos.y, bodyPos.x);
    let diff = Math.atan2(camPos.z, camPos.x) - Math.atan2(bodyPos.z, bodyPos.x);
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    return diff;
  }

  /**
   * Bug 5 fix: returns angle in the XY ecliptic plane (atan2(dir.x, dir.y))
   * so the minimap triangle tip correctly tracks the camera look direction.
   *
   * Derivation:
   *  - Minimap maps world +Y to canvas "up" (canvas -Y), world +X to canvas right.
   *  - ctx.rotate(θ) at tip (0,-r): tip lands at (r·sinθ, -r·cosθ).
   *  - Desired canvas tip = (dir.x, -dir.y) → sinθ = dir.x, cosθ = dir.y → θ = atan2(dir.x, dir.y).
   */
  getCameraAzimuth(): number {
    if (!this.camera) return 0;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    // return Math.atan2(dir.x, dir.y);
    return Math.atan2(dir.x, dir.z);
  }

  // ─── Bug 1 fix: reset immediately updates local state + forces render ───────
  resetSimulation(): void {
    this.wsService.sendReset();
    this.resetRings();

    // Immediately snap local simulation time so the HUD updates without waiting
    // for the next WebSocket message.
    this.simulationTime = Date.now();
    this.lastSimTime = undefined;

    // Force one render so the date panel refreshes right away.
    if (this.camera) this.renderer.render(this.scene, this.camera);
  }

  resetRings(): void {
    for (const ring of this.keplerianRings) {
      if (ring.userData?.rotate) {
        ring.userData.currentAngle = 0;
        ring.rotation.y = 0;
      }
    }
  }

  // ─── Navigation mode ───────────────────────────────────────────────────────

  setNavigationMode(mode: NavigationMode): void {
    this.navMode = mode;
    this.cinematicFollow.active = false;
    try { localStorage.setItem(this.NAV_MODE_KEY, mode); } catch { }

    switch (mode) {
      case NavigationMode.DISCOVERY:
        this.moveCameraTo(WebGl.CAMERA_PRESETS[CameraView.OVERVIEW].pos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 2000);
        break;
      case NavigationMode.CINEMATIC:
        if (this.selectedPlanetName) this.navigateToPlanet(this.selectedPlanetName, 2000);
        else this.moveCameraTo(WebGl.CAMERA_PRESETS[CameraView.CINEMATIC].pos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 2000);
        break;
      case NavigationMode.FASTEST_TRAVEL:
        // Ensure path line is created/shown.
        this.updateNavPathLine();
        break;
    }

    // Hide path line when leaving nav mode.
    if (mode !== NavigationMode.FASTEST_TRAVEL && this.navPathLine) {
      this.navPathLine.visible = false;
    }
  }

  // ─── Camera navigation ─────────────────────────────────────────────────────

  moveCameraTo(
    toPos: THREE.Vector3,
    lookAt: THREE.Vector3 = new THREE.Vector3(),
    toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
    durationMs = 1800,
  ): void {
    this.cameraAnim = {
      fromPos: this.camera.position.clone(), toPos: toPos.clone(),
      lookAt: lookAt.clone(),
      fromUp: this.camera.up.clone(), toUp: toUp.clone(),
      startMs: Date.now(), durationMs,
    };
  }

  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = WebGl.CAMERA_PRESETS[view];
    this.cinematicFollow.active = false;
    this.moveCameraTo(preset.pos, new THREE.Vector3(), preset.up, durationMs);
  }

  navigateToPlanet(bodyName: string, durationMs = 2200): void {
    if (this.navMode === NavigationMode.FASTEST_TRAVEL) {
      this.addNavWaypointBody(bodyName);
      return;
    }

    const target = this.findBodyByName(bodyName);
    if (!target) return;

    const targetPos = this.getWorldPos(target);
    const diameter = (target.config as any).diameter ?? 2;

    const boundsPositions: THREE.Vector3[] = [targetPos];
    for (const moon of (target as any).satellites ?? []) boundsPositions.push(this.getWorldPos(moon));
    const { centroid, maxRadius } = this.boundingSphere(boundsPositions);

    if (this.navMode === NavigationMode.DISCOVERY) {
      const altitude = Math.max(maxRadius * 3.5, diameter * 40, 800);
      const camPos = centroid.clone().add(new THREE.Vector3(0, 0, altitude));
      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
      return;
    }

    if (this.navMode === NavigationMode.CINEMATIC) {
      const radial = targetPos.clone().normalize();
      if (radial.lengthSq() < 0.001) radial.set(1, 0, 0);
      const viewDist = Math.max(maxRadius * 4.0, diameter * 50, 1000);
      const camPos = centroid.clone()
        .addScaledVector(radial, viewDist * 0.4)
        .add(new THREE.Vector3(0, viewDist * 0.3, viewDist * 0.7));

      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);

      setTimeout(() => {
        if (this.navMode !== NavigationMode.CINEMATIC) return;
        const freshPos = this.getWorldPos(this.findBodyByName(bodyName) ?? target);
        this.cinematicFollow = { active: true, bodyName, worldOffset: this.camera.position.clone().sub(freshPos) };
      }, durationMs + 50);
    }
  }

  navigateToSelection(durationMs = 2200): void {
    if (!this.star || this.selectedNames.size === 0) return;
    if (this.selectedNames.size === 1) { this.navigateToPlanet([...this.selectedNames][0], durationMs); return; }

    const positions: THREE.Vector3[] = [];
    for (const name of this.selectedNames) {
      const body = this.findBodyByName(name) as any;
      if (!body) continue;
      positions.push(this.getWorldPos(body));
      for (const moon of body.satellites ?? []) positions.push(this.getWorldPos(moon));
    }
    if (positions.length === 0) return;

    const { centroid, maxRadius } = this.boundingSphere(positions);

    if (this.navMode === NavigationMode.DISCOVERY) {
      const altitude = Math.max(maxRadius * 3.5, 1500);
      const camPos = centroid.clone().add(new THREE.Vector3(0, 0, altitude));
      this.cinematicFollow.active = false;
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
    } else {
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
      if (this.navMode === NavigationMode.CINEMATIC) this.navigateToPlanet(bodyName);
    }
    this.refreshMoonHighlights();
    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  selectBodies(names: string[], navigate = true): void {
    for (const prev of this.selectedNames) this.setHighlight(prev, false);
    this.selectedNames.clear();
    for (const name of names) { this.selectedNames.add(name); this.setHighlight(name, true); }
    if (navigate) names.length === 1 ? this.navigateToPlanet(names[0]) : this.navigateToSelection();
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

  togglePlanetOrbits(visible: boolean): void {
    this.showPlanetOrbits = visible;
    for (const line of this.planetOrbitLines.values()) line.visible = visible;
  }

  toggleMoonOrbits(visible: boolean): void {
    this.showMoonOrbits = visible;
    for (const line of this.moonOrbitLines.values()) line.visible = visible;
  }

  toggleMoonsOfPlanet(planetName: string, visible: boolean): void {
    const planet = this.star?.satellites.find(p => p.name === planetName);
    if (!planet) return;
    for (const moon of planet.satellites) {
      const line = this.moonOrbitLines.get(moon.name);
      if (line) line.visible = visible;
    }
  }

  toggleShowMoonsOfSelected(): boolean {
    this.showMoonsOfSelected = !this.showMoonsOfSelected;
    try { localStorage.setItem(this.MOONS_OF_SELECTED_KEY, String(this.showMoonsOfSelected)); } catch { }
    this.refreshMoonHighlights();
    return this.showMoonsOfSelected;
  }

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

  // ─── Navigation Route API ─────────────────────────────────────────────────

  addNavWaypointBody(bodyName: string, durationSec = 10): void {
    const exists = this.navRoute.waypoints.some(w => w.type === 'body' && w.bodyName === bodyName);
    if (exists) return;
    this.navRoute.waypoints.push({ type: 'body', bodyName, durationSec, label: bodyName });
    this.updateNavPathLine();
  }

  addNavWaypointCoordinate(worldX: number, worldY: number, durationSec = 5): void {
    const pos = new THREE.Vector3(worldX, worldY, 0);
    const idx = this.navRoute.waypoints.length + 1;
    this.navRoute.waypoints.push({
      type: 'coordinate', position: pos, durationSec,
      label: `Point ${idx} (${worldX.toFixed(0)}, ${worldY.toFixed(0)})`,
    });
    this.updateNavPathLine();
  }

  removeNavWaypoint(index: number): void {
    this.navRoute.waypoints.splice(index, 1);
    this.updateNavPathLine();
  }

  updateNavWaypointDuration(index: number, durationSec: number): void {
    if (this.navRoute.waypoints[index]) this.navRoute.waypoints[index].durationSec = durationSec;
  }

  clearNavWaypoints(): void {
    this.navRoute.waypoints = [];
    this.navRoute.active = false;
    this.navRoute.currentIndex = 0;
    this.navRoute.progress = 0;
    this.navRoute.orbitRemaining = 0;
    this.updateNavPathLine();
  }

  setNavRouteLoop(loop: boolean): void {
    this.navRoute.loop = loop;
    this.updateNavPathLine();
  }

  engageNavRoute(): void {
    if (this.navRoute.waypoints.length === 0) return;
    this.navRoute.active = true;
    this.navRoute.currentIndex = 0;
    this.navRoute.progress = 0;
    this.navRoute.orbitRemaining = 0;
    this.navRouteFromPos.copy(this.camera.position);
    this.cameraAnim = null; // cancel any pending fly-to
  }

  disengageNavRoute(): void {
    this.navRoute.active = false;
  }

  /** Returns the ordered list of display labels for the selection bar, hierarchically sorted. */
  getSelectionHierarchyLabels(): string[] {
    if (!this.star || this.selectedNames.size === 0) return [];
    const result: string[] = [];

    // Star first
    if (this.selectedNames.has(this.star.name)) result.push(this.star.name);

    // Planets by AU, then their selected moons
    const sortedPlanets = [...this.star.satellites].sort(
      (a, b) => ((a.config as any).au ?? 0) - ((b.config as any).au ?? 0)
    );
    for (const planet of sortedPlanets) {
      if (this.selectedNames.has(planet.name)) result.push(planet.name);
      for (const moon of planet.satellites) {
        if (this.selectedNames.has(moon.name)) result.push(`↳ ${moon.name}`);
      }
    }
    return result;
  }

  /** @deprecated kept for template compat */
  queueWaypoint(bodyName: string): void { this.addNavWaypointBody(bodyName); }
  clearWaypoints(): void { this.clearNavWaypoints(); }

  // ─── Keyboard input ────────────────────────────────────────────────────────

  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') { event.preventDefault(); this._controls.toggle(); return; }
    if (event.code === 'Escape' && this.navRoute.active) { this.disengageNavRoute(); return; }
    if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); this.wsService.sendSpeed(Math.min(10_000, ((this as any)._lastSpeed ?? 1) * 2)); }
    if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); this.wsService.sendSpeed(Math.max(0.25, ((this as any)._lastSpeed ?? 1) / 2)); }
    if (event.code === 'BracketLeft') { event.preventDefault(); this._controls.adjustMovementSpeed(-0.1); }
    if (event.code === 'BracketRight') { event.preventDefault(); this._controls.adjustMovementSpeed(0.1); }
  }

  // ─── Internal: scene loading ───────────────────────────────────────────────

  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [], simulationTime }) => {
      if (typeof simulationTime === 'number') this.simulationTime = simulationTime;
      await this.createSolarSystem(planets);
    });
  }

  loadUniverse(): void {
    this.sseService.on('universe').subscribe(async (payload: any) => {
      try {
        const universe = payload?.universe;
        if (!universe?.stars?.length) { console.warn('[WebGl] No star data.'); return; }
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

  private buildOrbitLines(body: any, parentGroup: THREE.Group | THREE.Scene = this.scene): void {
    if (!(body instanceof OrbitingBody)) {
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
      // pts.push(new THREE.Vector3(r * Math.cos(nu), r * Math.sin(nu) * Math.cos(inc), r * Math.sin(nu) * Math.sin(inc)));
      const x = r * Math.cos(nu);
      const z0 = r * Math.sin(nu);
      const y = -z0 * Math.sin(inc);
      const z = z0 * Math.cos(inc);
      pts.push(new THREE.Vector3(x, y, z));
    }

    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: (body.config as any).color || (isMoon ? '#aaaadd' : '#ffffff'),
        transparent: true, opacity: isMoon ? 0.5 : 0.75,
      }),
    );
    line.visible = isMoon ? this.showMoonOrbits : this.showPlanetOrbits;
    parentGroup.add(line);

    if (isMoon) this.moonOrbitLines.set(body.name, line);
    else this.planetOrbitLines.set(body.name, line);

    for (const sat of body.satellites ?? []) this.buildOrbitLines(sat, body.orbitalGroup);
  }

  /** Bug 6 fix: star's highlight mesh is now in selectable (set by StarFactory). */
  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of body.satellites ?? []) this.collectSelectable(sat);
  }

  // ─── Internal: ring rendering ──────────────────────────────────────────────

  /**
   * Bug 3 fix: particle size uses `ring.particleSize` if set, otherwise
   * clamps to a small fraction of ring width, max 4 scene units.
   *
   * Bug 2 fix: for Keplerian belts (asteroid belt) the particles are distributed
   * with pure-random uniform-area sampling and no Perlin density bands.
   * The belt is split into 3 radial zones each with its own InstancedMesh and
   * independently computed Keplerian rotation speed → differential rotation.
   */
  private async buildParticleRingMesh(
    inner: number,
    outer: number,
    count: number,
    tiltDeg: number,
    thickness: number,
    color: string,
    textureUrl: string | undefined,
    keplerian: boolean,
    parentGroup: THREE.Group | THREE.Scene,
    angularSpeedRadPerMs?: number,
    particleSizeOverride?: number,
  ): Promise<void> {

    const vertexShader = `
                            uniform float uTime;
                            varying vec3 vPosition;

                            float hash(vec3 p) {
                              return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
                            }

                            vec3 randomVector(vec3 p) {
                              return vec3(
                                hash(p + vec3(0.0)),
                                hash(p + vec3(1.0, 0.0, 0.0)),
                                hash(p + vec3(2.0, 0.0, 0.0))
                              ) * 2.0 - 1.0;
                            }

                            void main() {
                              vec3 pos = position;
                              vec3 noisePos = pos * 0.5;          // scale of noise
                              float t = uTime * 1.5;

                              // cheap pseudo‑random offset per particle based on its original position
                              vec3 offset = randomVector(floor(noisePos * 10.0)) * 0.4;
                              offset += sin(noisePos * 5.0 + t) * 0.1;
                              offset += cos(noisePos.yzx * 3.0 - t * 1.3) * 0.1;

                              pos += offset;

                              vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
                              vPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
                              gl_PointSize = 2.0;                // adjust if you switch to Points
                              gl_Position = projectionMatrix * mvPosition;
                            }
                          `;

    const fragmentShader = `
                            uniform vec3 uColor;
                            void main() {
                              gl_FragColor = vec4(uColor, 0.9);
                            }
                          `;

    let texture: THREE.Texture | undefined;
    if (textureUrl) {
      const tex = await this.textureService.loadMultipleTextures([textureUrl]);
      if (tex[0]?.image) texture = tex[0];
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const positions: THREE.Vector3[] = [];
    const scales: number[] = [];
    const attempts = count * 3;

    for (let i = 0; i < attempts && positions.length < count; i++) {
      const angle = Math.random() * 2 * Math.PI;
      // Uniform area distribution in annulus: r = sqrt(u) maps uniform [0,1] to uniform area
      const u = Math.random();
      const r = inner + Math.sqrt(u) * (outer - inner);
      // Small radial & angular jitter to break grid-like patterns
      const rj = r + (Math.random() - 0.5) * (outer - inner) * 0.04;

      let zOffset: number;
      if (keplerian) {
        // Asteroid belt: random Gaussian-style vertical scatter, heavier toward midplane
        const g = (Math.random() + Math.random() - 1); // ~Gaussian [-1,1]
        zOffset = g * thickness * rj * 0.3;
      } else {
        // Planetary ring: thin sinusoidal wobble
        zOffset = Math.sin(angle * 6) * thickness * rj * 0.12;
      }

      const x = rj * Math.cos(angle);
      const z = rj * Math.sin(angle);
      const y = zOffset;                     // thickness
      const finalX = x;
      const finalY = y * cosT - z * sinT;
      const finalZ = y * sinT + z * cosT;
      positions.push(new THREE.Vector3(finalX, finalY, finalZ));

      scales.push(0.4 + Math.random() * 1.8);
    }

    if (positions.length === 0) return;

    let particleRadius: number;
    if (particleSizeOverride) {
      particleRadius = particleSizeOverride;
    } else if (keplerian) {
      // Asteroid belt – far away, need larger particles
      particleRadius = Math.min(12, (outer - inner) * 0.008);
    } else {
      // Planetary rings – close to camera, keep small
      particleRadius = Math.min(4, (outer - inner) * 0.004);
    }
    particleRadius = Math.max(0.2, particleRadius);

    const geometry = new THREE.SphereGeometry(Math.max(0.05, particleRadius), 5, 5);
    const instancedMesh = new THREE.InstancedMesh(geometry, material, positions.length);
    instancedMesh.castShadow = false;
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

    if (keplerian) {
      const avgRadiusAU = ((inner + outer) / 2) / SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
      const periodYears = Math.sqrt(Math.pow(avgRadiusAU, 3));
      const periodMs = periodYears * 365.25 * 24 * 3600 * 1000;
      const speed = (2 * Math.PI) / periodMs;
      instancedMesh.userData = { rotate: true, angularSpeedRadPerMs: speed, currentAngle: 0 };
      this.keplerianRings.add(instancedMesh);
    } else if (angularSpeedRadPerMs && angularSpeedRadPerMs > 0) {
      instancedMesh.userData = { rotate: true, angularSpeedRadPerMs, currentAngle: 0 };
      this.keplerianRings.add(instancedMesh);
    }
  }

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
      const keplerian = (ring as any).keplerianRotation === true;

      if ((ring.particleCount ?? 0) > 0) {
        // Bug 2 fix: split into 3 zones with independent Keplerian speeds
        const zones = keplerian ? 3 : 1;
        const zoneCount = Math.ceil(ring.particleCount! / zones);
        const width = (outer - inner) / zones;
        for (let z = 0; z < zones; z++) {
          await this.buildParticleRingMesh(
            inner + z * width, inner + (z + 1) * width, zoneCount,
            tiltDeg, ring.thickness ?? 0.4,
            ring.color ?? '#b0a090', ring.texture, keplerian,
            this.star.group, undefined, ring.particleSize,
          );
        }
      } else {
        const mesh = this.buildWasher(inner, outer, tiltDeg, ring.color ?? '#b0a090', ring.texture);
        mesh.name = `ring_${ring.name}_washer`;
        this.star.group.add(mesh);
      }
    }

    // ── Planet-level rings ────────────────────────────────────────────────────
    for (const planet of star.satellites) {
      const pCfg = planet.config as any;
      const rings: RingConfig[] = Array.isArray(pCfg.rings) ? pCfg.rings : [];
      if (rings.length === 0) continue;

      const visualDiameter = (pCfg.diameter ?? 2) * VISUAL_SCALE;
      const orbGroup = (planet as any).orbitalGroup as THREE.Group;

      for (const ring of rings) {
        if (!ring?.name) continue;

        const minSafeRadius = visualDiameter * 0.55; // just outside surface
        let localInner = ring.inner ?? 0;
        let localOuter = ring.outer ?? 0;

        if (localInner <= minSafeRadius || localOuter <= localInner) {
          // Fallback uses actual visual scale
          localInner = visualDiameter * 1.15;
          localOuter = visualDiameter * 2.2;
          console.warn(`[WebGl] Ring "${ring.name}" radii adjusted to visual scale: [${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
        }

        const tiltDeg = (ring as any).tilt ?? 0;
        const ringSpeed = ((ring as any).rotationSpeed ?? 0.005) / 1000; // rad/ms
        const washer = this.buildWasher(localInner, localOuter, tiltDeg, ring.color ?? '#e8d8b0', ring.texture, ringSpeed);
        washer.name = `ring_${ring.name}_washer`;
        orbGroup.add(washer);

        if ((ring.particleCount ?? 0) > 0) {
          await this.buildParticleRingMesh(
            localInner, localOuter, ring.particleCount!, tiltDeg, ring.thickness ?? 0.02,
            ring.color ?? '#e8d8b0', ring.texture, false, orbGroup,
            ringSpeed, ring.particleSize,
          );
        }

        console.log(`[WebGl] Ring "${ring.name}" built: local r=[${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
      }
    }
  }

  private buildWasher(
    inner: number, outer: number, tiltDeg: number, color: string,
    texture?: string, angularSpeedRadPerMs?: number,
  ): THREE.Mesh {
    const safeInner = Math.max(0.1, inner);
    const safeOuter = Math.max(safeInner + 0.1, outer);

    const geom = new THREE.RingGeometry(safeInner, safeOuter, 128);
    const pos = geom.attributes['position'] as THREE.BufferAttribute;
    const uvAttr = geom.attributes['uv'] as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uvAttr.setXY(i, (r - safeInner) / (safeOuter - safeInner), (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1);
    }
    uvAttr.needsUpdate = true;
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false,
    });

    if (texture?.trim()) {
      this.textureService.loadMultipleTextures([texture]).then(([t]) => {
        if (t.image && mat.map !== t) { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; }
      });
    }

    const mesh = new THREE.Mesh(geom, mat);

    const tiltRad = (tiltDeg * Math.PI) / 180;
    mesh.rotation.x = -Math.PI / 2 + tiltRad;
    mesh.renderOrder = 5;

    if (angularSpeedRadPerMs && angularSpeedRadPerMs > 0) {
      mesh.userData = { rotate: true, angularSpeedRadPerMs, currentAngle: 0 };
      this.keplerianRings.add(mesh as any);
    }
    return mesh;
  }

  // ─── Internal: navigation path line ───────────────────────────────────────

  private updateNavPathLine(): void {
    const points: THREE.Vector3[] = [this.camera?.position.clone() ?? new THREE.Vector3()];

    for (const wp of this.navRoute.waypoints) {
      if (wp.type === 'body' && wp.bodyName) {
        const body = this.findBodyByName(wp.bodyName);
        if (body) points.push(this.getWorldPos(body));
      } else if (wp.type === 'coordinate' && wp.position) {
        points.push(wp.position.clone());
      }
    }

    if (this.navRoute.loop && points.length > 2) points.push(points[1].clone());

    if (points.length < 2) {
      if (this.navPathLine) this.navPathLine.visible = false;
      return;
    }

    const geomPts = points;
    if (!this.navPathLine) {
      const geom = new THREE.BufferGeometry().setFromPoints(geomPts);
      const mat = new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.7 });
      this.navPathLine = new THREE.Line(geom, mat);
      this.navPathLine.renderOrder = 10;
      this.scene.add(this.navPathLine);
    } else {
      this.navPathLine.geometry.setFromPoints(geomPts);
      this.navPathLine.geometry.attributes['position'].needsUpdate = true;
      this.navPathLine.visible = this.navMode === NavigationMode.FASTEST_TRAVEL;
    }
  }

  // ─── Internal: WebSocket orbit integration ─────────────────────────────────

  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
          this.simulationTime = data.simulationTime;
          if (data.type === 'orbitSync') this.lastSimTime = undefined;
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

  // ─── Animation loop ────────────────────────────────────────────────────────

  animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000;

    if (this.star) this.star.updateHierarchy(elapsed);

    // Cinematic follow
    if (this.cinematicFollow.active && this.navMode === NavigationMode.CINEMATIC && !this.cameraAnim) {
      const body = this.findBodyByName(this.cinematicFollow.bodyName) as any;
      if (body) {
        const bodyPos = this.getWorldPos(body);
        this.camera.position.copy(bodyPos).add(this.cinematicFollow.worldOffset);
        this.camera.lookAt(bodyPos);
        this._controls.syncEuler();
      }
    }

    if (this.lastSimTime === undefined) {
      this.lastSimTime = this.simulationTime;
    }

    let deltaSimMs = Math.min(this.simulationTime - this.lastSimTime, 500);
    this.lastSimTime = this.simulationTime;

    for (const ring of this.keplerianRings) {
      if (ring.userData?.rotate) {
        // ring.userData.currentAngle += ring.userData.angularSpeedRadPerMs * deltaSimMs;
        // ring.rotation.y = ring.userData.currentAngle;
        const deltaAngle = ring.userData.angularSpeedRadPerMs * deltaSimMs;
        ring.rotateY(deltaAngle);               // ← rotates around local Y
      }
      // Update shader time if it's a ShaderMaterial
      if (ring.material && ring.material.uniforms) {
        ring.material.uniforms.uTime.value = performance.now() / 1000;
      }
    }

    this.tickCameraAnim();

    // Navigation route (after cameraAnim so it takes precedence)
    if (this.navRoute.active && this.navRoute.waypoints.length > 0) {
      this.tickNavRoute(delta);
    }

    this._controls.update(delta);

    // Refresh path line every frame (bodies are moving)
    if (this.navMode === NavigationMode.FASTEST_TRAVEL && this.navPathLine) {
      this.updateNavPathLine();
    }

    if (elapsed - this.lastSaveMs >= 2000) { this.saveCameraState(); this.lastSaveMs = elapsed; }
    this.renderer.render(this.scene, this.camera);
  }

  // ─── Navigation route tick ─────────────────────────────────────────────────

  private tickNavRoute(delta: number): void {
    const wps = this.navRoute.waypoints;
    if (wps.length === 0) return;

    const idx = this.navRoute.currentIndex;
    const wp = wps[idx];

    // Resolve target world position for this waypoint
    let targetPos = new THREE.Vector3();
    if (wp.type === 'body' && wp.bodyName) {
      const body = this.findBodyByName(wp.bodyName);
      if (body) targetPos = this.getWorldPos(body);
    } else if (wp.type === 'coordinate' && wp.position) {
      targetPos = wp.position.clone();
    }

    // Travel phase: advance progress toward waypoint
    if (this.navRoute.progress < 1) {
      const dist = this.navRouteFromPos.distanceTo(targetPos);
      const step = (this.navRouteTravelSpeed * delta) / Math.max(1, dist);
      this.navRoute.progress = Math.min(1, this.navRoute.progress + step);
      // Ease in-out
      const t = this.navRoute.progress;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      // Position camera along path (user retains look control)
      const viewOffset = new THREE.Vector3(0, 0, 400); // stay back from target
      const camTarget = targetPos.clone().add(viewOffset);
      this.camera.position.lerpVectors(this.navRouteFromPos, camTarget, eased);
      // Gently look at target during travel
      const lookTarget = targetPos.clone();
      const currentLook = this.camera.getWorldDirection(new THREE.Vector3()).add(this.camera.position);
      const blendLook = currentLook.lerp(lookTarget, 0.02);
      this.camera.lookAt(blendLook);
      this._controls.syncEuler();
    } else {
      // Orbit phase: geostationary orbit around waypoint for durationSec
      if (this.navRoute.orbitRemaining <= 0) {
        this.navRoute.orbitRemaining = wp.durationSec;
        this.navOrbitAngle = 0;
        this.navOrbitRadius = 400;
        this.navOrbitCenter.copy(targetPos);
      }

      this.navRoute.orbitRemaining -= delta;
      this.navOrbitAngle += delta * 0.3; // rad/sec orbit speed
      const liveCenter = (wp.type === 'body' && wp.bodyName)
        ? (this.getWorldPos(this.findBodyByName(wp.bodyName)!))
        : targetPos;
      this.navOrbitCenter.copy(liveCenter);

      this.camera.position.set(
        this.navOrbitCenter.x + Math.cos(this.navOrbitAngle) * this.navOrbitRadius,
        this.navOrbitCenter.y + 200,
        this.navOrbitCenter.z + Math.sin(this.navOrbitAngle) * this.navOrbitRadius,
      );
      this.camera.lookAt(this.navOrbitCenter);
      this._controls.syncEuler();

      if (this.navRoute.orbitRemaining <= 0) {
        // Advance to next waypoint
        const nextIdx = idx + 1;
        if (nextIdx >= wps.length) {
          if (this.navRoute.loop) {
            this.navRoute.currentIndex = 0;
          } else {
            this.navRoute.active = false;
            return;
          }
        } else {
          this.navRoute.currentIndex = nextIdx;
        }
        this.navRouteFromPos.copy(this.camera.position);
        this.navRoute.progress = 0;
        this.navRoute.orbitRemaining = 0;
      }
    }
  }

  // ─── Camera animation tick ─────────────────────────────────────────────────

  private tickCameraAnim(): void {
    if (!this.cameraAnim || this.navRoute.active) return;
    const t = Math.min((Date.now() - this.cameraAnim.startMs) / this.cameraAnim.durationMs, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(this.cameraAnim.fromPos, this.cameraAnim.toPos, eased);
    this.camera.up.lerpVectors(this.cameraAnim.fromUp, this.cameraAnim.toUp, eased).normalize();
    this.camera.lookAt(this.cameraAnim.lookAt);
    this._controls.syncEuler();
    if (t >= 1) this.cameraAnim = null;
  }

  // ─── Camera persistence ────────────────────────────────────────────────────

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

  // ─── Helpers ───────────────────────────────────────────────────────────────

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

  /** Bug 6 fix: also checks the star itself. */
  findBodyByName(name: string): any | null {
    if (!this.star) return null;
    const lower = name.toLowerCase();
    if (this.star.name.toLowerCase() === lower) return this.star;
    for (const planet of this.star.satellites) {
      if (planet.name.toLowerCase() === lower) return planet;
      for (const moon of planet.satellites) {
        if (moon.name.toLowerCase() === lower) return moon;
      }
    }
    return null;
  }

  private getWorldPos(body: any): THREE.Vector3 {
    const pos = new THREE.Vector3();
    const group = body.orbitalGroup ?? body.group;
    if (group) group.getWorldPosition(pos);
    return pos;
  }

  private boundingSphere(positions: THREE.Vector3[]): { centroid: THREE.Vector3; maxRadius: number } {
    const centroid = new THREE.Vector3();
    for (const p of positions) centroid.add(p);
    centroid.divideScalar(positions.length);
    let maxRadius = 0;
    for (const p of positions) maxRadius = Math.max(maxRadius, centroid.distanceTo(p));
    return { centroid, maxRadius };
  }
}
