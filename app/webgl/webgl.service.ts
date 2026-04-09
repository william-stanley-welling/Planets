import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';

class HeliocentricControls {
  movementSpeed = 100.0;
  lookSpeed = 0.002;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private keys: Record<string, boolean> = {};
  private isLocked = false;

  private boundMouseMove = this.onMouseMove.bind(this);
  private boundLockChange = this.onLockChange.bind(this);

  private boundKeyDown = (e: KeyboardEvent) => { this.keys[e.code] = true; };
  private boundKeyUp = (e: KeyboardEvent) => { this.keys[e.code] = false; };

  constructor(
    private camera: THREE.Camera,
    private domElement: HTMLElement
  ) {
    this.euler.setFromQuaternion(camera.quaternion);

    document.addEventListener('pointerlockchange', this.boundLockChange);
    // FIX: register key listeners on construction so they are always active
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);

    this.domElement.tabIndex = 0;
    this.domElement.style.outline = 'none';
  }

  get locked(): boolean { return this.isLocked; }

  enterFlight(): void {
    if (this.isLocked) return;
    this.domElement.focus();
    this.domElement.requestPointerLock();
  }

  exitFlight(): void {
    document.exitPointerLock();
  }

  toggle(): void {
    this.isLocked ? this.exitFlight() : this.enterFlight();
  }

  update(delta: number): void {
    if (!this.isLocked) return;

    const speed = this.movementSpeed * delta;
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
  }

  handleResize(): void { }

  dispose(): void {
    document.removeEventListener('pointerlockchange', this.boundLockChange);
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('keydown', this.boundKeyDown);
    document.removeEventListener('keyup', this.boundKeyUp);
  }

  private onLockChange(): void {
    this.isLocked = document.pointerLockElement === this.domElement;

    if (this.isLocked) {
      document.addEventListener('mousemove', this.boundMouseMove);
    } else {
      document.removeEventListener('mousemove', this.boundMouseMove);
      this.keys = {};
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isLocked) return;

    this.euler.y -= e.movementX * this.lookSpeed;
    this.euler.x -= e.movementY * this.lookSpeed;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));

    this.camera.quaternion.setFromEuler(this.euler);
  }

  setKey(code: string, pressed: boolean): void {
    this.keys[code] = pressed;
  }
}

class TextureService {
  private cubeTextureLoader = new THREE.CubeTextureLoader();
  loadCubeTexture(urls: string[]): THREE.CubeTexture {
    return this.cubeTextureLoader.load(urls,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
      },
      undefined,
      (err) => console.error('Skybox load error:', err)
    );
  }
}

interface CameraSession {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
}

@Injectable({ providedIn: 'root' })
export class WebGl {
  clock: THREE.Clock;
  scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  star!: Star;
  selectable: THREE.Object3D[] = [];
  skybox!: THREE.Mesh;
  raycaster: THREE.Raycaster;
  controls!: HeliocentricControls;
  width = 800;
  height = 800;
  active = false;

  private readonly SESSION_KEY = 'helio_cam';
  private readonly SAVE_INTERVAL = 2;
  private lastSaveTime = 0;

  constructor(
    private starFactory: StarFactory,
    private sseService: SseService,
    private wsService: WebSocketService
  ) {
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.raycaster = new THREE.Raycaster();
  }

  init(height: number, width: number) {
    this.height = height;
    this.width = width;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2_000_000);
    this.camera.position.set(1490, 300, 300);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    this.restoreCameraState();

    this.controls = new HeliocentricControls(this.camera, this.renderer.domElement);
    this.controls.movementSpeed = 100.0;
    this.controls.lookSpeed = 0.002;

    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000011, 1);
    this.renderer.shadowMap.enabled = true;

    const ambient = new THREE.AmbientLight(0xaaaaaa, 0.8);
    this.scene.add(ambient);

    const textureService = new TextureService();
    const urls = [
      'galaxy_rit.png', 'galaxy_lft.png',
      'galaxy_top.png', 'galaxy_btm.png',
      'galaxy_frn.png', 'galaxy_bak.png'
    ].map(f => `/images/skybox/${f}`);
    this.scene.background = textureService.loadCubeTexture(urls);

    const skyGeo = new THREE.BoxGeometry(200_000, 200_000, 200_000);
    const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, visible: false });
    this.skybox = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.skybox);
  }

  isActive() { return this.active; }
  getRenderer() { return this.renderer; }
  getScene() { return this.scene; }
  getCamera() { return this.camera; }

  keyDown(event: KeyboardEvent) {
    if (event.code === 'Space') {
      event.preventDefault();
      this.controls.toggle();
    }
  }

  loadPlanets() {
    this.sseService.on('planets').subscribe({
      next: async ({ planets = [] }) => {
        await this.createSolarSystem(planets);
      },
      error: (err) => console.error('Planet SSE error:', err)
    });
  }

  private async createSolarSystem(dataList: any[]) {
    const sunData = dataList.find((d: any) => d.name.toLowerCase() === 'sun');
    if (!sunData) return;

    // Build central star
    this.star = await this.starFactory.buildStar(sunData as any);
    this.scene.add(this.star.group);

    // Build and attach all satellites (planets) via the planet (satellite) factory
    const planetData = dataList.filter((d: any) => d.name.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetData);

    // Initial orbit positions (t = 0)
    this.star.updateHierarchy(0);

    // Collect all highlights for raycasting / selection
    this.selectable = [];
    this.addSelectableRecursively(this.star);
  }

  private addSelectableRecursively(body: any) {
    if (body.highlight) this.selectable.push(body.highlight);
    if (body.satellites) {
      body.satellites.forEach((sat: any) => this.addSelectableRecursively(sat));
    }
  }

  observePlanets() {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
          // Server positions are ignored — client now drives true Keplerian heliocentric orbits
          // (moons and planets revolve via THREE.Group hierarchy + getOrbitalPosition)
          // This was the old circular approximation; new design is fully accurate and hierarchical.
        }
      } catch (e) { }
    });
  }

  resize(height: number, width: number) {
    this.height = height;
    this.width = width;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000; // simTime in milliseconds (matches TIME_SCALE_SECONDS_PER_DAY scaling)

    if (this.star) {
      this.star.updateHierarchy(elapsed); // recursive rotation + Keplerian revolve for Sun → planets → moons
    }

    this.controls.update(delta);

    if (elapsed - this.lastSaveTime >= this.SAVE_INTERVAL) {
      this.saveCameraState();
      this.lastSaveTime = elapsed;
    }

    this.renderer.render(this.scene, this.camera);
  }

  start() {
    this.loadPlanets();
    this.observePlanets();
    this.renderer.clear();
    this.animate();
    this.active = true;
  }

  private saveCameraState(): void {
    try {
      const state: CameraSession = {
        px: this.camera.position.x,
        py: this.camera.position.y,
        pz: this.camera.position.z,
        qx: this.camera.quaternion.x,
        qy: this.camera.quaternion.y,
        qz: this.camera.quaternion.z,
        qw: this.camera.quaternion.w,
      };
      sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(state));
    } catch { }
  }

  private restoreCameraState(): void {
    try {
      const raw = sessionStorage.getItem(this.SESSION_KEY);
      if (!raw) return;

      const s: CameraSession = JSON.parse(raw);

      const posValid = [s.px, s.py, s.pz].every(v => typeof v === 'number' && isFinite(v));
      const rotValid = [s.qx, s.qy, s.qz, s.qw].every(v => typeof v === 'number' && isFinite(v));
      if (!posValid || !rotValid) return;

      this.camera.position.set(s.px, s.py, s.pz);
      this.camera.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    } catch { }
  }
}
