import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import * as THREE from 'three';
import { OrbitingBody, RingConfig, SIMULATION_CONSTANTS, VISUAL_SCALE } from '../galaxy/celestial.model';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';
import { AssetTextureService } from './asset-texture.service';
import { HeliocentricControls } from './heliocentric.controls';
import { Magnetometer } from './tools/magnetometer';
import {
  BodySnapshot,
  CameraInfo,
  CameraView,
  ICelestialRenderer,
  NavigationMode,
  NavigationRoute,
  SystemSnapshot
} from './webgl.interface';
export {
  BodySnapshot,
  CameraInfo, CameraView, NavigationMode, NavigationRoute, NavigationWaypoint, SystemSnapshot
} from './webgl.interface';

@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {

  readonly scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  active = false;
  selectedNames = new Set<string>();

  // ── Loading state ────────────────────────────────────────────────────────────
  /** Emits once when the solar system (star + planets + rings) is fully built. */
  private readonly readySubject = new Subject<void>();
  readonly ready$ = this.readySubject.asObservable();

  /** Streams human-readable build progress to the loader overlay. */
  private readonly loadingStageSubject = new BehaviorSubject<string>('Connecting to server…');
  readonly loadingStage$ = this.loadingStageSubject.asObservable();

  private setStage(msg: string): void { this.loadingStageSubject.next(msg); }
  // ─────────────────────────────────────────────────────────────────────────────

  get selectedPlanetName(): string | null {
    return this.selectedNames.size > 0
      ? [...this.selectedNames][this.selectedNames.size - 1]
      : null;
  }

  private keplerianRings = new Set<THREE.InstancedMesh | THREE.Mesh>();

  spectroscopyMode = false;
  private spectroscopyLine?: THREE.LineSegments;

  magnetometerMode = false;
  private magnetometer: Magnetometer | null = null;

  showPlanetOrbits = true;
  showMoonOrbits = false;
  showMoonsOfSelected: boolean;
  navMode: NavigationMode;

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
  private navRouteTravelSpeed = 2000;
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
    let diff = Math.atan2(camPos.z, camPos.x) - Math.atan2(bodyPos.z, bodyPos.x);
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    return diff;
  }

  getCameraAzimuth(): number {
    if (!this.camera) {
      return 0;
    }

    const dir = new THREE.Vector3();

    this.camera.getWorldDirection(dir);

    return Math.atan2(dir.x, dir.y);
  }

  resetSimulation(): void {
    this.wsService.sendReset();
    this.resetRings();

    this.simulationTime = Date.now();
    this.lastSimTime = undefined;

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
        this.updateNavPathLine();
        break;
    }

    if (mode !== NavigationMode.FASTEST_TRAVEL && this.navPathLine) {
      this.navPathLine.visible = false;
    }
  }

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

  toggleSpectroscopyMode(): void {
    this.spectroscopyMode = !this.spectroscopyMode;

    this.setAllDebugAxisVisibility(this.spectroscopyMode);

    if (this.spectroscopyMode) {
      this.createSpectroscopyLines();
    } else if (this.spectroscopyLine) {
      this.scene.remove(this.spectroscopyLine);
      this.spectroscopyLine = undefined;
    }
  }

  toggleMagnetometerMode(): void {
    this.magnetometerMode = !this.magnetometerMode;

    if (this.magnetometerMode && !this.magnetometer && this.star) {
      this.magnetometer = new Magnetometer(this.scene, this.star);
    }

    if (this.magnetometer) {
      this.magnetometer.toggle();
    }
  }

  private setAllDebugAxisVisibility(visible: boolean): void {
    if (!this.star) return;

    this.star.updateDebugAxisVisibility(visible);

    for (const planet of this.star.satellites) {
      planet.updateDebugAxisVisibility(visible);
      for (const moon of planet.satellites) {
        moon.updateDebugAxisVisibility(visible);
      }
    }
  }

  private createSpectroscopyLines(): void {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.45,
      linewidth: 2.5,
    });
    this.spectroscopyLine = new THREE.LineSegments(geometry, material);
    this.scene.add(this.spectroscopyLine);
  }

  private updateSpectroscopyLines(): void {
    if (!this.spectroscopyLine || !this.star) return;

    const lines: THREE.Vector3[] = [];

    const sunPos = new THREE.Vector3(0, 0, 0);

    for (const planet of this.star.satellites) {
      const pwp = this.getWorldPos(planet);
      lines.push(sunPos.clone(), pwp);
      for (const moon of planet.satellites) {
        const mwp = this.getWorldPos(moon);
        lines.push(pwp, mwp);
        lines.push(sunPos.clone(), mwp);
      }
    }

    for (const name of this.selectedNames) {
      const body = this.findBodyByName(name);
      if (body) {
        lines.push(sunPos.clone(), this.getWorldPos(body));
      }
    }

    const positions = new Float32Array(lines.length * 3);
    let i = 0;
    for (const p of lines) {
      positions[i++] = p.x;
      positions[i++] = p.y;
      positions[i++] = p.z;
    }

    this.spectroscopyLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
  }

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
    this.cameraAnim = null;
  }

  disengageNavRoute(): void {
    this.navRoute.active = false;
  }

  getSelectionHierarchyLabels(): string[] {
    if (!this.star || this.selectedNames.size === 0) return [];
    const result: string[] = [];

    if (this.selectedNames.has(this.star.name)) result.push(this.star.name);

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

  clearWaypoints(): void { this.clearNavWaypoints(); }

  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') { event.preventDefault(); this._controls.toggle(); return; }
    if (event.code === 'Escape' && this.navRoute.active) { this.disengageNavRoute(); return; }
    if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); this.wsService.sendSpeed(Math.min(10_000, ((this as any)._lastSpeed ?? 1) * 2)); }
    if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); this.wsService.sendSpeed(Math.max(0.25, ((this as any)._lastSpeed ?? 1) / 2)); }
    if (event.code === 'BracketLeft') { event.preventDefault(); this._controls.adjustMovementSpeed(-0.1); }
    if (event.code === 'BracketRight') { event.preventDefault(); this._controls.adjustMovementSpeed(0.1); }
  }

  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [], simulationTime }) => {
      if (typeof simulationTime === 'number') this.simulationTime = simulationTime;
      await this.createSolarSystem(planets);
    });
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find(d => d.name?.toLowerCase() === 'sun');
    if (!sunData) { console.warn('[WebGl] No Sun in SSE payload.'); return; }

    this.setStage('Building star…');
    this.star = await this.starFactory.build(sunData);
    this._controls.setStar(this.star);
    this.scene.add(this.star.group);

    const planetData = dataList.filter(d => d.name?.toLowerCase() !== 'sun');
    this.setStage(`Loading ${planetData.length} planets & moons…`);
    await this.starFactory.attachSatellites(this.star, planetData);
    this.star.updateHierarchy(0);

    this.setStage('Drawing orbital paths…');
    this.buildOrbitLines(this.star);

    this.setStage('Registering celestial bodies…');
    this.collectSelectable(this.star);

    this.setStage('Assembling rings & belts…');
    await this.buildRings(this.star, sunData);

    console.log('[WebGl] Solar system ready — selectable:', this.selectable.length);

    // Signal consumers: the solar system is fully built.
    this.setStage('Ready');
    this.readySubject.next();
  }

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

  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of body.satellites ?? []) this.collectSelectable(sat);
  }

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

    let texture: THREE.Texture | undefined;
    if (textureUrl) {
      const tex = await this.textureService.loadMultipleTextures([textureUrl]);
      if (tex[0]?.image) texture = tex[0];
    }
    const hasTexture = !!texture;

    const vertexShader = `
      uniform float uTime;
      uniform float uVibrationTime;
      uniform float uVibrationStrength;
      uniform float uOuterRadius;
      varying vec3 vPosition;
      ${hasTexture ? 'varying vec2 vUv;' : ''}
      attribute vec3 position;
      attribute vec3 normal;
      ${hasTexture ? 'attribute vec2 uv;' : ''}

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
        vec3 noisePos = pos * 0.5;
        float t = uTime * 1.5;

        vec3 offset = randomVector(floor(noisePos * 10.0)) * 0.4;
        offset += sin(noisePos * 5.0 + t) * 0.1;
        offset += cos(noisePos.yzx * 3.0 - t * 1.3) * 0.1;

        pos += offset;

        vec3 instancePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ringRadius = length(instancePos);
        float angle = atan(instancePos.z, instancePos.x);
        float wave = sin(angle * 12.0 + uVibrationTime * 35.0) * uVibrationStrength;
        float outerBias = ringRadius / uOuterRadius;
        pos += normal * (wave * outerBias * 0.6);

        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
        vPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
        ${hasTexture ? 'vUv = uv;' : ''}
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform vec3 uColor;
      ${hasTexture ? `
        uniform sampler2D uTexture;
        varying vec2 vUv;
      ` : ''}
      void main() {
        ${hasTexture ? `
          vec4 texColor = texture2D(uTexture, vUv);
          gl_FragColor = texColor * vec4(uColor, 0.9);
        ` : `
          gl_FragColor = vec4(uColor, 0.9);
        `}
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uVibrationTime: { value: 0 },
        uVibrationStrength: { value: 0 },
        uOuterRadius: { value: outer },
        ...(hasTexture && { uTexture: { value: texture } }),
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const tiltRad = (tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const positions: THREE.Vector3[] = [];
    const scales: number[] = [];
    const attempts = count * 3;

    for (let i = 0; i < attempts && positions.length < count; i++) {
      const angle = Math.random() * 2 * Math.PI;

      const u = Math.random();
      const r = inner + Math.sqrt(u) * (outer - inner);

      const rj = r + (Math.random() - 0.5) * (outer - inner) * 0.04;

      let zOffset: number;

      if (keplerian) {
        const g = (Math.random() + Math.random() - 1);
        zOffset = g * thickness * rj * 0.3;
      } else {
        zOffset = Math.sin(angle * 6) * thickness * rj * 0.12;
      }

      const x = rj * Math.cos(angle);
      const z = rj * Math.sin(angle);
      const y = zOffset;

      const finalX = x;
      const finalY = y * cosT - z * sinT;
      const finalZ = y * sinT + z * cosT;

      positions.push(new THREE.Vector3(finalX, finalY, finalZ));

      scales.push(0.4 + Math.random() * 1.8);
    }

    if (positions.length === 0) {
      return;
    }

    let particleRadius: number;

    if (particleSizeOverride) {
      particleRadius = particleSizeOverride;
    } else if (keplerian) {
      particleRadius = Math.min(12, (outer - inner) * 0.008);
    } else {
      particleRadius = Math.min(4, (outer - inner) * 0.004);
    }

    particleRadius = Math.max(0.2, particleRadius);

    const geometry = new THREE.SphereGeometry(Math.max(0.05, particleRadius), 5, 5);
    geometry.computeVertexNormals();

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

    for (const planet of star.satellites) {
      const pCfg = planet.config as any;
      const rings: RingConfig[] = Array.isArray(pCfg.rings) ? pCfg.rings : [];
      if (rings.length === 0) continue;

      const visualDiameter = (pCfg.diameter ?? 2) * VISUAL_SCALE;
      const orbGroup = (planet as any).orbitalGroup as THREE.Group;

      for (const ring of rings) {
        if (!ring?.name) continue;

        const minSafeRadius = visualDiameter * 0.55;
        let localInner = ring.inner ?? 0;
        let localOuter = ring.outer ?? 0;

        if (localInner <= minSafeRadius || localOuter <= localInner) {
          localInner = visualDiameter * 1.15;
          localOuter = visualDiameter * 2.2;
          console.warn(`[WebGl] Ring "${ring.name}" radii adjusted to visual scale: [${localInner.toFixed(1)}, ${localOuter.toFixed(1)}]`);
        }

        const tiltDeg = (ring as any).tilt ?? 0;
        const ringSpeed = ((ring as any).rotationSpeed ?? 0.005) / 1000;

        if ((ring.particleCount ?? 0) > 0) {
          await this.buildParticleRingMesh(
            localInner, localOuter, ring.particleCount!, tiltDeg, ring.thickness ?? 0.02,
            ring.color ?? '#e8d8b0', ring.texture, false, orbGroup,
            ringSpeed, ring.particleSize,
          );
        } else {
          const washer = this.buildWasher(localInner, localOuter, tiltDeg, ring.color ?? '#e8d8b0', ring.texture, ringSpeed);
          washer.name = `ring_${ring.name}_washer`;
          orbGroup.add(washer);
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

  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'orbitUpdate') {
          this.simulationTime = data.simulationTime;
          this.applyTrueAnomalies(data.trueAnomalies);
        }

        else if (data.type === 'orbitSync') {
          this.simulationTime = data.simulationTime;
          this.applyTrueAnomalies(data.trueAnomalies);
        }

        else if (data.type === 'ringUpdate') {
          // save for later
        }

      } catch (err) {
        console.warn('[WebGl] WS parse error:', err);
      }
    });
  }

  private applyTrueAnomalies(angles: Record<string, number>): void {
    const apply = (body: any) => {
      if (body instanceof OrbitingBody && angles[body.name] !== undefined) body.setAngle(angles[body.name]);
      if (body.satellites) for (const sat of body.satellites) apply(sat);
    };
    if (this.star) apply(this.star);
  }

  animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000;

    if (this.star) this.star.updateHierarchy(elapsed);

    if (this.cinematicFollow.active && this.navMode === NavigationMode.CINEMATIC && !this.cameraAnim) {
      const body = this.findBodyByName(this.cinematicFollow.bodyName) as any;
      if (body) {
        const bodyPos = this.getWorldPos(body);
        this.camera.position.copy(bodyPos).add(this.cinematicFollow.worldOffset);
        this.camera.lookAt(bodyPos);
        this._controls.syncEuler();
      }
    }

    if (this.spectroscopyMode && this.spectroscopyLine) {
      this.updateSpectroscopyLines();
    }

    if (this.magnetometer?.active) {
      this.magnetometer.update();
    }

    if (this.lastSimTime === undefined) {
      this.lastSimTime = this.simulationTime;
    }

    let deltaSimMs = Math.min(this.simulationTime - this.lastSimTime, 500);
    this.lastSimTime = this.simulationTime;

    for (const ring of this.keplerianRings) {
      if (ring.userData?.rotate) {
        const deltaAngle = ring.userData.angularSpeedRadPerMs * deltaSimMs;
        ring.rotateY(deltaAngle);
      }
      if (ring.material && ring.material.uniforms) {
        ring.material.uniforms.uTime.value = performance.now() / 1000;
      }
    }

    this.tickCameraAnim();

    if (this.navRoute.active && this.navRoute.waypoints.length > 0) {
      this.tickNavRoute(delta);
    }

    this._controls.update(delta);

    if (this.navMode === NavigationMode.FASTEST_TRAVEL && this.navPathLine) {
      this.updateNavPathLine();
    }

    if (elapsed - this.lastSaveMs >= 2000) { this.saveCameraState(); this.lastSaveMs = elapsed; }
    this.renderer.render(this.scene, this.camera);
  }

  private tickNavRoute(delta: number): void {
    const wps = this.navRoute.waypoints;
    if (wps.length === 0) return;

    const idx = this.navRoute.currentIndex;
    const wp = wps[idx];

    let targetPos = new THREE.Vector3();
    if (wp.type === 'body' && wp.bodyName) {
      const body = this.findBodyByName(wp.bodyName);
      if (body) targetPos = this.getWorldPos(body);
    } else if (wp.type === 'coordinate' && wp.position) {
      targetPos = wp.position.clone();
    }

    if (this.navRoute.progress < 1) {
      const dist = this.navRouteFromPos.distanceTo(targetPos);
      const step = (this.navRouteTravelSpeed * delta) / Math.max(1, dist);
      this.navRoute.progress = Math.min(1, this.navRoute.progress + step);

      const t = this.navRoute.progress;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      const viewOffset = new THREE.Vector3(0, 0, 400);
      const camTarget = targetPos.clone().add(viewOffset);
      this.camera.position.lerpVectors(this.navRouteFromPos, camTarget, eased);

      const lookTarget = targetPos.clone();
      const currentLook = this.camera.getWorldDirection(new THREE.Vector3()).add(this.camera.position);
      const blendLook = currentLook.lerp(lookTarget, 0.02);
      this.camera.lookAt(blendLook);
      this._controls.syncEuler();
    } else {

      if (this.navRoute.orbitRemaining <= 0) {
        this.navRoute.orbitRemaining = wp.durationSec;
        this.navOrbitAngle = 0;
        this.navOrbitRadius = 400;
        this.navOrbitCenter.copy(targetPos);
      }

      this.navRoute.orbitRemaining -= delta;
      this.navOrbitAngle += delta * 0.3;
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
