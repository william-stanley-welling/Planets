import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { Planet } from '../galaxy/planet.model';
import { OrbitingBody, SIMULATION_CONSTANTS } from '../galaxy/celestial.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';
import { ICelestialRenderer, CameraInfo, SystemSnapshot, CameraView, BodySnapshot } from './webgl.interface';

export { CameraView, SystemSnapshot, BodySnapshot, CameraInfo } from './webgl.interface';

// ----------------------------------------------------------------------------
// HeliocentricControls with mass‑based speed scaling and mouse wheel
// ----------------------------------------------------------------------------
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

  private boundMouseMove = this.onMouseMove.bind(this);
  private boundLockChange = this.onLockChange.bind(this);
  private boundKeyDown = (e: KeyboardEvent) => { this.keys[e.code] = true; };
  private boundKeyUp = (e: KeyboardEvent) => { this.keys[e.code] = false; };
  private boundWheel = this.onWheel.bind(this);

  constructor(private camera: THREE.Camera, private domElement: HTMLElement) {
    this.euler.setFromQuaternion(camera.quaternion);
    document.addEventListener('pointerlockchange', this.boundLockChange);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('wheel', this.boundWheel);
    this.domElement.tabIndex = 0;
    this.domElement.style.outline = 'none';
    this.lastPos.copy(camera.position);
    this.lastTime = performance.now();
  }

  setStar(star: Star) { this.starRef = star; }

  get locked(): boolean { return this.isLocked; }
  enterFlight(): void { if (!this.isLocked) { this.domElement.focus(); this.domElement.requestPointerLock(); } }
  exitFlight(): void { document.exitPointerLock(); }
  toggle(): void { this.isLocked ? this.exitFlight() : this.enterFlight(); }

  adjustMovementSpeed(delta: number) {
    this.baseMovementSpeed = Math.max(100, Math.min(50000, this.baseMovementSpeed * (1 + delta)));
    this.updateSpeedScale();
  }

  private updateSpeedScale() {
    if (!this.starRef) return;
    const camPos = this.camera.position;
    let nearestMass = 0;
    let nearestDistSq = Infinity;
    const checkBody = (body: any) => {
      if (body === this.starRef) return;
      const pos = new THREE.Vector3();
      if (body.orbitalGroup) body.orbitalGroup.getWorldPosition(pos);
      else if (body.group) body.group.getWorldPosition(pos);
      else return;
      const d2 = camPos.distanceToSquared(pos);
      if (d2 < nearestDistSq) {
        nearestDistSq = d2;
        nearestMass = body.mass || 0;
      }
      if (body.satellites) body.satellites.forEach(checkBody);
    };
    checkBody(this.starRef);
    const massScale = Math.max(0.2, Math.min(1, 1 / (1 + nearestMass / 1e24)));
    this.movementSpeed = this.baseMovementSpeed * massScale;
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
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    this.adjustMovementSpeed(delta);
  }
}

// ----------------------------------------------------------------------------
// Main WebGL service
// ----------------------------------------------------------------------------
@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {
  scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  active = false;
  simulationTime = Date.now();

  private clock: THREE.Clock;
  private _controls!: HeliocentricControls;
  private orbitLines = new Map<string, THREE.LineLoop>();
  private cameraAnim: any = null;
  public showPlanetOrbits = true;
  public showMoonOrbits = false;
  public selectedPlanetName: string | null = null;

  public get controls(): HeliocentricControls {
    return this._controls;
  }

  private readonly SESSION_KEY = 'helio_cam';
  private lastSaveMs = 0;
  private cameraRestored = false;

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
  ) {
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
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

  getCameraInfo(): CameraInfo {
    return {
      position: this.camera.position.clone(),
      direction: this.camera.getWorldDirection(new THREE.Vector3()),
      velocity: this._controls.velocity
    };
  }

  getSystemSnapshot(): SystemSnapshot {
    const bodies: BodySnapshot[] = [{ name: 'Sun', x: 0, y: 0, color: '#ffcc44', au: 0, isStar: true }];
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
          isStar: false
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
    const bodyAngle = Math.atan2(bodyPos.y, bodyPos.x);
    const camAngle = Math.atan2(camPos.y, camPos.x);
    let diff = camAngle - bodyAngle;
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    return diff;
  }

  setSimulationSpeed(speed: number) {
    this.wsService.sendSpeed(speed);
  }

  loadPlanets(): void {
    this.sseService.on('planets').subscribe(async ({ planets = [] }) => {
      await this.createSolarSystem(planets);
    });
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find((d: any) => d.name?.toLowerCase() === 'sun');
    if (!sunData) return;
    this.star = await this.starFactory.build(sunData);
    this._controls.setStar(this.star);
    this.scene.add(this.star.group);

    const planetDataList = dataList.filter((d: any) => d.name?.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetDataList);
    this.star.updateHierarchy(0);

    this.createOrbitLines(this.star);
    this.collectSelectable(this.star);
  }

  private createOrbitLines(body: any, isMoon = false): void {
    if (body instanceof OrbitingBody && (!isMoon || this.showMoonOrbits)) {
      const a = body.getSemiMajorAxis();
      const e = body.orbitingConfig.eccentricity ?? 0;
      const inc = (body.orbitingConfig.inclination ?? 0) * Math.PI / 180;
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
      const material = new THREE.LineBasicMaterial({ color: (body.config as any).color || '#ffffff' });
      const ellipse = new THREE.LineLoop(geometry, material);
      ellipse.visible = !isMoon ? this.showPlanetOrbits : this.showMoonOrbits;
      this.scene.add(ellipse);
      this.orbitLines.set(body.name, ellipse);
    }
    for (const sat of body.satellites ?? []) {
      this.createOrbitLines(sat, true);
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

  private applyAngles(angles: Record<string, number>): void {
    const apply = (body: any) => {
      if (body instanceof OrbitingBody && angles[body.name] !== undefined) {
        body.setAngle(angles[body.name]);
      }
      for (const sat of body.satellites) apply(sat);
    };
    if (this.star) apply(this.star);
  }

  moveCameraTo(toPos: THREE.Vector3, lookAt: THREE.Vector3 = new THREE.Vector3(0, 0, 0), toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0), durationMs = 1800): void {
    this.cameraAnim = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      lookAt: lookAt.clone(),
      fromUp: this.camera.up.clone(),
      toUp: toUp.clone(),
      startMs: Date.now(),
      durationMs
    };
  }

  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = WebGl.CAMERA_PRESETS[view];
    this.moveCameraTo(preset.pos, new THREE.Vector3(0, 0, 0), preset.up, durationMs);
  }

  navigateToPlanet(planetName: string, durationMs = 2000): void {
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

  togglePlanetOrbits(visible: boolean): void {
    this.showPlanetOrbits = visible;
    for (let [name, line] of this.orbitLines.entries()) {
      if (!name.toLowerCase().includes('moon')) line.visible = visible;
    }
  }

  toggleMoonOrbits(visible: boolean): void {
    this.showMoonOrbits = visible;
    for (let [name, line] of this.orbitLines.entries()) {
      if (name.toLowerCase().includes('moon')) line.visible = visible;
    }
  }

  toggleMoonsOfPlanet(planetName: string, visible: boolean): void {
    const planet = this.star.satellites.find(p => p.name === planetName);
    if (planet) {
      for (const moon of planet.satellites) {
        const line = this.orbitLines.get(moon.name);
        if (line) line.visible = visible;
      }
    }
  }

  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') {
      event.preventDefault();
      this._controls.toggle();
      return;
    }
    // Simulation speed control: + / - (or Equal and Minus)
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      event.preventDefault();
      this.setSimulationSpeed(Math.min(10, (this as any).currentSimSpeed + 0.1) || 1.1);
    } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      this.setSimulationSpeed(Math.max(0, ((this as any).currentSimSpeed - 0.1) || 0.9));
    }
    // Camera movement speed: BracketLeft = slower, BracketRight = faster
    if (event.code === 'BracketLeft') {
      event.preventDefault();
      this._controls.adjustMovementSpeed(-0.1);
    } else if (event.code === 'BracketRight') {
      event.preventDefault();
      this._controls.adjustMovementSpeed(0.1);
    }
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

  resize(height: number, width: number): void {
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
    this._controls.update(delta);
    if (elapsed - this.lastSaveMs >= 2000) {
      this.saveCameraState();
      this.lastSaveMs = elapsed;
    }
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
}
