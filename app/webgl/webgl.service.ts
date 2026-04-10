import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { Planet } from '../galaxy/planet.model';
import { Moon } from '../galaxy/moon.model';
import { OrbitingBody, SIMULATION_CONSTANTS } from '../galaxy/celestial.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';

export enum CameraView {
  OVERVIEW = 'overview',
  ECLIPTIC = 'ecliptic',
  CINEMATIC = 'cinematic',
}

const OUTER_AU = 30.07;
const OUTER_SCENE = OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

const CAMERA_PRESETS: Record<CameraView, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
  [CameraView.OVERVIEW]: { pos: new THREE.Vector3(0, 0, OUTER_SCENE * 3.2), up: new THREE.Vector3(0, 1, 0) },
  [CameraView.ECLIPTIC]: { pos: new THREE.Vector3(OUTER_SCENE * 2.4, OUTER_SCENE * 0.15, 0), up: new THREE.Vector3(0, 0, 1) },
  [CameraView.CINEMATIC]: { pos: new THREE.Vector3(OUTER_SCENE * 0.8, OUTER_SCENE * 0.6, OUTER_SCENE * 2.0), up: new THREE.Vector3(0, 1, 0) },
};

export interface BodySnapshot {
  name: string;
  x: number; y: number;
  color: string;
  au: number;
  isStar: boolean;
}

export interface SystemSnapshot {
  bodies: BodySnapshot[];
  camera: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// HeliocentricControls with velocity tracking
// ---------------------------------------------------------------------------
class HeliocentricControls {
  movementSpeed = 3000.0;
  lookSpeed = 0.002;
  velocity = 0;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private keys: Record<string, boolean> = {};
  private isLocked = false;
  private lastPos = new THREE.Vector3();
  private lastTime = 0;

  private boundMouseMove = this.onMouseMove.bind(this);
  private boundLockChange = this.onLockChange.bind(this);
  private boundKeyDown = (e: KeyboardEvent) => { this.keys[e.code] = true; };
  private boundKeyUp = (e: KeyboardEvent) => { this.keys[e.code] = false; };

  constructor(private camera: THREE.Camera, private domElement: HTMLElement) {
    this.euler.setFromQuaternion(camera.quaternion);
    document.addEventListener('pointerlockchange', this.boundLockChange);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    this.domElement.tabIndex = 0;
    this.domElement.style.outline = 'none';
    this.lastPos.copy(camera.position);
    this.lastTime = performance.now();
  }

  get locked(): boolean { return this.isLocked; }
  enterFlight(): void { if (!this.isLocked) { this.domElement.focus(); this.domElement.requestPointerLock(); } }
  exitFlight(): void { document.exitPointerLock(); }
  toggle(): void { this.isLocked ? this.exitFlight() : this.enterFlight(); }

  update(delta: number): void {
    if (!this.isLocked) return;
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
    const newPos = this.camera.position;
    this.velocity = newPos.distanceTo(this.lastPos) / dt;
    this.lastPos.copy(newPos);
    this.lastTime = now;
  }

  syncEuler(): void { this.euler.setFromQuaternion(this.camera.quaternion); }
  handleResize(): void { }
  dispose(): void {
    document.removeEventListener('pointerlockchange', this.boundLockChange);
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('keydown', this.boundKeyDown);
    document.removeEventListener('keyup', this.boundKeyUp);
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
}

// ---------------------------------------------------------------------------
// WebGl service
// ---------------------------------------------------------------------------
@Injectable({ providedIn: 'root' })
export class WebGl {
  clock: THREE.Clock;
  scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  controls!: HeliocentricControls;

  width = 800; height = 800; active = false;
  simulationTime = Date.now();

  // Orbit lines
  private orbitLines = new Map<string, THREE.LineLoop>();
  public showPlanetOrbits = true;
  public showMoonOrbits = false;
  public selectedPlanetName: string | null = null;

  private readonly SESSION_KEY = 'helio_cam';
  private lastSaveMs = 0;
  private cameraAnim: any = null;
  private cameraRestored = false;

  constructor(
    private starFactory: StarFactory,
    private sseService: SseService,
    private wsService: WebSocketService,
  ) {
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
  }

  init(height: number, width: number): void {
    this.height = height; this.width = width;
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2_000_000);
    const overview = CAMERA_PRESETS[CameraView.OVERVIEW];
    this.camera.position.copy(overview.pos);
    this.camera.up.copy(overview.up);
    this.camera.lookAt(0, 0, 0);
    this.restoreCameraState();
    this.scene.add(this.camera);
    this.controls = new HeliocentricControls(this.camera, this.renderer.domElement);
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000011, 1);
    this.renderer.shadowMap.enabled = true;
    this.scene.add(new THREE.AmbientLight(0xaaaaaa, 0.6));

    // Skybox
    const skyUrls = ['galaxy_rit.png', 'galaxy_lft.png', 'galaxy_top.png', 'galaxy_btm.png', 'galaxy_frn.png', 'galaxy_bak.png']
      .map(f => `/images/skybox/${f}`);
    new THREE.CubeTextureLoader().load(skyUrls, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; this.scene.background = tex; });
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
    } catch (e) { }
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

  getCameraInfo() {
    return {
      position: this.camera.position.clone(),
      direction: this.camera.getWorldDirection(new THREE.Vector3()),
      velocity: this.controls.velocity
    };
  }

  getSystemSnapshot(): SystemSnapshot {
    const bodies: BodySnapshot[] = [{ name: 'Sun', x: 0, y: 0, color: '#ffcc44', au: 0, isStar: true }];
    if (this.star) {
      for (const planet of this.star.satellites as Planet[]) {
        const pos = new THREE.Vector3();
        (planet as any).orbitalGroup?.getWorldPosition(pos);
        bodies.push({ name: planet.name, x: pos.x, y: pos.y, color: planet.config?.color || '#aaaaff', au: planet.config?.au ?? 0, isStar: false });
      }
    }
    const cam = this.camera?.position ?? new THREE.Vector3();
    return { bodies, camera: { x: cam.x, y: cam.y, z: cam.z } };
  }

  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [] }) => {
      await this.createSolarSystem(planets);
    });
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find((d: any) => d.name?.toLowerCase() === 'sun');
    if (!sunData) return;
    this.star = await this.starFactory.buildStar(sunData);
    this.scene.add(this.star.group);

    const planetDataList = dataList.filter((d: any) => d.name?.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetDataList);
    this.star.updateHierarchy(0);

    // Create orbit lines
    this.createOrbitLines(this.star);
    this.collectSelectable(this.star);
    console.log(`Solar system built — ${this.star.satellites.length} planets`);
  }

  private createOrbitLines(body: any, isMoon = false) {
    if (body instanceof OrbitingBody && (!isMoon || this.showMoonOrbits)) {
      const a = body.getSemiMajorAxis();
      const e = body.config.eccentricity ?? 0;
      const inc = (body.config.inclination ?? 0) * Math.PI / 180;
      const points: THREE.Vector3[] = [];
      const segments = 128;
      for (let i = 0; i <= segments; i++) {
        const nu = (i / segments) * 2 * Math.PI;
        const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
        const x = r * Math.cos(nu);
        const y = r * Math.sin(nu);
        points.push(new THREE.Vector3(x, y * Math.cos(inc), y * Math.sin(inc)));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: body.config?.color || '#ffffff' });
      const ellipse = new THREE.LineLoop(geometry, material);
      ellipse.visible = !isMoon ? this.showPlanetOrbits : this.showMoonOrbits;
      this.scene.add(ellipse);
      this.orbitLines.set(body.name, ellipse);
    }
    for (const sat of body.satellites ?? []) {
      this.createOrbitLines(sat, true);
    }
  }

  togglePlanetOrbits(visible: boolean) {
    this.showPlanetOrbits = visible;
    for (let [name, line] of this.orbitLines.entries()) {
      if (!name.toLowerCase().includes('moon')) line.visible = visible;
    }
  }
  toggleMoonOrbits(visible: boolean) {
    this.showMoonOrbits = visible;
    for (let [name, line] of this.orbitLines.entries()) {
      if (name.toLowerCase().includes('moon')) line.visible = visible;
    }
  }
  toggleMoonsOfPlanet(planetName: string, visible: boolean) {
    const planet = this.star.satellites.find(p => p.name === planetName);
    if (planet) {
      for (const moon of planet.satellites) {
        const line = this.orbitLines.get(moon.name);
        if (line) line.visible = visible;
      }
    }
  }

  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of (body.satellites ?? [])) this.collectSelectable(sat);
  }

  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
        this.simulationTime = data.simulationTime;
        this.applyAngles(data.angles);
      }
    });
  }

  private applyAngles(angles: Record<string, number>) {
    const apply = (body: any) => {
      if (body instanceof OrbitingBody && angles[body.name] !== undefined) {
        body.setAngle(angles[body.name]);
      }
      for (const sat of body.satellites) apply(sat);
    };
    if (this.star) apply(this.star);
  }

  moveCameraTo(toPos: THREE.Vector3, lookAt: THREE.Vector3 = new THREE.Vector3(0, 0, 0), toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0), durationMs = 1800) {
    this.cameraAnim = {
      fromPos: this.camera.position.clone(), toPos: toPos.clone(), lookAt: lookAt.clone(),
      fromUp: this.camera.up.clone(), toUp: toUp.clone(), startMs: Date.now(), durationMs
    };
  }

  setCameraView(view: CameraView, durationMs = 2000) {
    const preset = CAMERA_PRESETS[view];
    this.moveCameraTo(preset.pos, new THREE.Vector3(0, 0, 0), preset.up, durationMs);
  }

  navigateToPlanet(planetName: string, durationMs = 2000) {
    const planet = this.star.satellites.find(p => p.name.toLowerCase() === planetName.toLowerCase()) as any;
    if (!planet) return;
    const planetPos = new THREE.Vector3();
    planet.orbitalGroup.getWorldPosition(planetPos);
    const diameter = planet.config?.diameter ?? 2;
    const viewDist = Math.max(diameter * 25, 500);
    const radial = planetPos.clone().normalize();
    if (radial.lengthSq() < 0.001) radial.set(0, 1, 0);
    const camPos = planetPos.clone().addScaledVector(radial, viewDist * 0.5).add(new THREE.Vector3(0, 0, viewDist));
    this.moveCameraTo(camPos, planetPos, new THREE.Vector3(0, 1, 0), durationMs);
  }

  private tickCameraAnim(): void {
    if (!this.cameraAnim) return;
    const t = Math.min((Date.now() - this.cameraAnim.startMs) / this.cameraAnim.durationMs, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(this.cameraAnim.fromPos, this.cameraAnim.toPos, eased);
    this.camera.up.lerpVectors(this.cameraAnim.fromUp, this.cameraAnim.toUp, eased).normalize();
    this.camera.lookAt(this.cameraAnim.lookAt);
    this.controls.syncEuler();
    if (t >= 1) this.cameraAnim = null;
  }

  resize(height: number, width: number) {
    this.height = height; this.width = width;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000;
    if (this.star) this.star.updateHierarchy(elapsed);
    this.tickCameraAnim();
    this.controls.update(delta);
    if (elapsed - this.lastSaveMs >= 2000) { this.saveCameraState(); this.lastSaveMs = elapsed; }
    this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    this.loadPlanets();
    this.observePlanets();
    this.animate();
    this.active = true;
  }

  isActive() { return this.active; }
  getRenderer() { return this.renderer; }
  getScene() { return this.scene; }
  getCamera() { return this.camera; }
  keyDown(event: KeyboardEvent) { if (event.code === 'Space') { event.preventDefault(); this.controls.toggle(); } }
}
