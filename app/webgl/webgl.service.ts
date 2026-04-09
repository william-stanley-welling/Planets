import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { StarFactory } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { SIMULATION_CONSTANTS } from '../galaxy/planet.model';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';

// ---------------------------------------------------------------------------
// Camera presets
// ---------------------------------------------------------------------------

export enum CameraView {
  /** Top-down along +Z axis — full ecliptic disc visible. */
  OVERVIEW = 'overview',
  /** Edge-on from the +X axis — disc appears as a line. */
  ECLIPTIC = 'ecliptic',
  /** Cinematic 30° elevation — shows depth of the system. */
  CINEMATIC = 'cinematic',
}

// Neptune ≈ 30.07 AU
const OUTER_AU = 30.07;
const OUTER_SCENE = OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU; // ≈ 44 984

const CAMERA_PRESETS: Record<CameraView, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
  [CameraView.OVERVIEW]: {
    pos: new THREE.Vector3(0, 0, OUTER_SCENE * 3.2),   // above ecliptic (Z axis)
    up: new THREE.Vector3(0, 1, 0),
  },
  [CameraView.ECLIPTIC]: {
    pos: new THREE.Vector3(OUTER_SCENE * 2.4, OUTER_SCENE * 0.15, 0),
    up: new THREE.Vector3(0, 0, 1),
  },
  [CameraView.CINEMATIC]: {
    pos: new THREE.Vector3(OUTER_SCENE * 0.8, OUTER_SCENE * 0.6, OUTER_SCENE * 2.0),
    up: new THREE.Vector3(0, 1, 0),
  },
};

// ---------------------------------------------------------------------------
// Body snapshot (for the mini-map)
// ---------------------------------------------------------------------------

export interface BodySnapshot {
  name: string;
  x: number;   // scene units
  y: number;
  color: string;
  au: number;
  isStar: boolean;
}

export interface SystemSnapshot {
  bodies: BodySnapshot[];
  camera: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// Camera animation (integrated into main animate loop — no racing RAF)
// ---------------------------------------------------------------------------

interface CameraAnim {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  lookAt: THREE.Vector3;
  fromUp: THREE.Vector3;
  toUp: THREE.Vector3;
  startMs: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Flight controls (pointer-lock FPS)
// ---------------------------------------------------------------------------

class HeliocentricControls {
  /**
   * Units per second at normal speed.
   * At 3 000 u/s, Earth (1 496 u) is ~0.5 s away; Neptune (~45 000 u) ~15 s.
   * Hold Shift for ×10 boost.
   */
  movementSpeed = 3000.0;
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
    private domElement: HTMLElement,
  ) {
    this.euler.setFromQuaternion(camera.quaternion);

    document.addEventListener('pointerlockchange', this.boundLockChange);
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
  }

  /**
   * Sync internal Euler to the camera quaternion after an external lookAt().
   * Call this whenever you set camera.quaternion outside the controls loop,
   * otherwise the next mouse-move will snap back to the old orientation.
   */
  syncEuler(): void {
    this.euler.setFromQuaternion(this.camera.quaternion);
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
}

// ---------------------------------------------------------------------------
// Skybox helper (cube texture)
// ---------------------------------------------------------------------------

class SkyboxLoader {
  private loader = new THREE.CubeTextureLoader();

  load(urls: string[]): THREE.CubeTexture {
    return this.loader.load(
      urls,
      (tex) => { tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; },
      undefined,
      (err) => console.error('[Skybox] Load error:', err),
    );
  }
}

// ---------------------------------------------------------------------------
// Camera session persistence (sessionStorage)
// ---------------------------------------------------------------------------

interface CameraSession {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
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

  width = 800;
  height = 800;
  active = false;

  private readonly SESSION_KEY = 'helio_cam';
  private readonly SAVE_INTERVAL = 2000; // ms between camera saves
  private lastSaveMs = 0;

  /** Active camera animation — processed inside animate(), no separate RAF. */
  private cameraAnim: CameraAnim | null = null;

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

  // ── Initialisation ─────────────────────────────────────────────────────────

  init(height: number, width: number): void {
    this.height = height;
    this.width = width;

    // Camera: FOV 45°, near 0.1, far 2 000 000 (Neptune ≈ 45 000 scene units)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2_000_000);

    // Default start: OVERVIEW (top-down), looks at origin
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

    // Ambient fill so bodies are never completely dark
    const ambient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    this.scene.add(ambient);

    // Skybox
    const skyUrls = [
      'galaxy_rit.png', 'galaxy_lft.png',
      'galaxy_top.png', 'galaxy_btm.png',
      'galaxy_frn.png', 'galaxy_bak.png',
    ].map(f => `/images/skybox/${f}`);

    const skybox = new SkyboxLoader();
    this.scene.background = skybox.load(skyUrls);

    // Invisible skybox mesh for raycasting boundary
    const skyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(200_000, 200_000, 200_000),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, visible: false }),
    );
    this.scene.add(skyMesh);
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  isActive() { return this.active; }
  getRenderer() { return this.renderer; }
  getScene() { return this.scene; }
  getCamera() { return this.camera; }

  // ── Input ──────────────────────────────────────────────────────────────────

  keyDown(event: KeyboardEvent): void {
    if (event.code === 'Space') {
      event.preventDefault();
      this.controls.toggle();
    }
  }

  // ── Solar-system construction ──────────────────────────────────────────────

  loadPlanets(): void {
    this.sseService.on('planets').subscribe({
      next: async ({ planets = [] }) => { await this.createSolarSystem(planets); },
      error: (err) => console.error('[WebGl] Planet SSE error:', err),
    });
  }

  private async createSolarSystem(dataList: any[]): Promise<void> {
    const sunData = dataList.find((d: any) => d.name?.toLowerCase() === 'sun');
    if (!sunData) {
      console.error('[WebGl] No Sun data found in SSE payload.');
      return;
    }

    // ── Star ────────────────────────────────────────────────────────────────
    this.star = await this.starFactory.buildStar(sunData);
    this.scene.add(this.star.group);
    console.log(`[Scene] ★ Star added: "${this.star.name}"`);

    // ── Planets + moons ─────────────────────────────────────────────────────
    const planetDataList = dataList.filter((d: any) => d.name?.toLowerCase() !== 'sun');
    await this.starFactory.attachSatellites(this.star, planetDataList);

    // Log the full hierarchy
    for (const planet of this.star.satellites) {
      const au = (planet as any).config?.au ?? '?';
      console.log(`[Scene]   ● Planet added: "${planet.name}"  au=${au}`);

      for (const moon of planet.satellites) {
        console.log(`[Scene]       ◦ Moon added: "${moon.name}"  parent="${planet.name}"`);
      }
    }

    // Tick once at t=0 so every body is positioned before first render
    this.star.updateHierarchy(0);

    // Collect highlights for raycasting
    this.selectable = [];
    this.collectSelectable(this.star);

    console.log(`[Scene] Solar system built — ${this.star.satellites.length} planets, `
      + `${this.star.satellites.reduce((n, p) => n + p.satellites.length, 0)} moons.`);
  }

  private collectSelectable(body: any): void {
    if (body.highlight) this.selectable.push(body.highlight);
    for (const sat of (body.satellites ?? [])) {
      this.collectSelectable(sat);
    }
  }

  // ── WebSocket orbit sync (legacy — client drives Kepler, server ignored) ──

  observePlanets(): void {
    this.wsService.emitter.subscribe((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'orbitUpdate' || data.type === 'orbitSync') {
          // Server positions ignored — client computes true Keplerian orbits.
        }
      } catch { }
    });
  }

  // ── Camera animation (integrated into animate loop) ────────────────────────

  /**
   * Smoothly animate the camera to `toPos`, looking at `lookAt`.
   * The animation is processed inside `animate()` — no separate RAF loop,
   * which was the cause of the sun-flicker / position-jump bug.
   */
  moveCameraTo(
    toPos: THREE.Vector3,
    lookAt: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
    toUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
    durationMs: number = 1800,
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

  private tickCameraAnim(): void {
    const a = this.cameraAnim;
    if (!a) return;

    const t = Math.min((Date.now() - a.startMs) / a.durationMs, 1);
    const eased = 1 - Math.pow(1 - t, 3);   // cubic ease-out

    this.camera.position.lerpVectors(a.fromPos, a.toPos, eased);
    this.camera.up.lerpVectors(a.fromUp, a.toUp, eased).normalize();
    this.camera.lookAt(a.lookAt);
    this.controls.syncEuler();   // keep FPS controls in sync

    if (t >= 1) this.cameraAnim = null;
  }

  // ── Preset camera views ────────────────────────────────────────────────────

  /**
   * Jump to a named preset view with a smooth animation.
   *
   * OVERVIEW  — top-down along +Z, all planets visible.
   * ECLIPTIC  — edge-on from +X; ecliptic disc appears as a line.
   * CINEMATIC — 30° elevation, angled perspective.
   */
  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = CAMERA_PRESETS[view];
    this.moveCameraTo(preset.pos, new THREE.Vector3(0, 0, 0), preset.up, durationMs);
    console.log(`[Camera] Preset: ${view}`);
  }

  // ── Navigate to a planet ───────────────────────────────────────────────────

  /**
   * Fly the camera to the planet's current Keplerian position.
   *
   * Offset strategy:
   *   - Pull back away from the Sun by `viewDist` along the planet's
   *     radial direction.
   *   - Raise by `viewDist` above the ecliptic (+Z).
   *   - Look at the planet's world position.
   *
   * This ensures the camera lands near the planet regardless of where
   * in its orbit it currently is.
   */
  navigateToPlanet(planetName: string, durationMs = 2000): void {
    if (!this.star || !this.camera) return;

    const planet = this.star.satellites.find(
      p => p.name.toLowerCase() === planetName.toLowerCase()
    ) as any;

    if (!planet) {
      console.warn(`[Camera] Planet not found: "${planetName}"`);
      return;
    }

    // Force hierarchy update so world matrices are current
    const simTime = this.clock.elapsedTime * 1000;
    this.star.updateHierarchy(simTime);

    const planetPos = new THREE.Vector3();
    planet.orbitalGroup.getWorldPosition(planetPos);

    const diameter = planet.config?.diameter ?? 2;
    const viewDist = Math.max(diameter * 25, 500);

    // Radial direction away from Sun
    const radial = planetPos.clone().normalize();
    if (radial.lengthSq() < 0.001) radial.set(0, 1, 0); // Sun edge-case

    const camPos = planetPos.clone()
      .addScaledVector(radial, viewDist * 0.5)      // pull back outward from sun
      .add(new THREE.Vector3(0, 0, viewDist));       // raise above ecliptic

    console.log(`[Camera] Navigating to "${planet.name}" at`, planetPos.toArray().map(v => v.toFixed(0)));

    this.moveCameraTo(camPos, planetPos, new THREE.Vector3(0, 1, 0), durationMs);
  }

  // ── World-position helper ─────────────────────────────────────────────────

  getPlanetWorldPosition(planetName: string): THREE.Vector3 {
    if (!this.star) return new THREE.Vector3();
    const planet = this.star.satellites.find(
      p => p.name.toLowerCase() === planetName.toLowerCase()
    ) as any;
    if (!planet) return new THREE.Vector3();

    const pos = new THREE.Vector3();
    planet.orbitalGroup.getWorldPosition(pos);
    return pos;
  }

  // ── System snapshot (mini-map data) ───────────────────────────────────────

  /**
   * Returns a lightweight snapshot of planet world positions for the
   * dashboard mini-map.  Does NOT call updateHierarchy — reads whatever
   * positions were set by the last animate() tick.
   */
  getSystemSnapshot(): SystemSnapshot {
    const bodies: BodySnapshot[] = [];

    bodies.push({ name: 'Sun', x: 0, y: 0, color: '#ffcc44', au: 0, isStar: true });

    if (this.star) {
      for (const planet of this.star.satellites) {
        const pos = new THREE.Vector3();
        (planet as any).orbitalGroup?.getWorldPosition(pos);

        bodies.push({
          name: planet.name,
          x: pos.x,
          y: pos.y,
          color: (planet as any).config?.color || '#aaaaff',
          au: (planet as any).config?.au ?? 0,
          isStar: false,
        });
      }
    }

    const cam = this.camera?.position ?? new THREE.Vector3();
    return {
      bodies,
      camera: { x: cam.x, y: cam.y, z: cam.z },
    };
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  resize(height: number, width: number): void {
    this.height = height;
    this.width = width;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }

  animate(): void {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime * 1000; // simTime (ms)

    // 1. Advance Keplerian simulation
    if (this.star) {
      this.star.updateHierarchy(elapsed);
    }

    // 2. Advance camera animation (single source of truth — no separate RAF)
    this.tickCameraAnim();

    // 3. Free-flight controls
    this.controls.update(delta);

    // 4. Persist camera state (throttled)
    if (elapsed - this.lastSaveMs >= this.SAVE_INTERVAL) {
      this.saveCameraState();
      this.lastSaveMs = elapsed;
    }

    this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    this.loadPlanets();
    this.observePlanets();
    this.renderer.clear();
    this.animate();
    this.active = true;
  }

  // ── Camera persistence ────────────────────────────────────────────────────

  private saveCameraState(): void {
    try {
      const s: CameraSession = {
        px: this.camera.position.x, py: this.camera.position.y, pz: this.camera.position.z,
        qx: this.camera.quaternion.x, qy: this.camera.quaternion.y,
        qz: this.camera.quaternion.z, qw: this.camera.quaternion.w,
      };
      sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(s));
    } catch { }
  }

  private restoreCameraState(): void {
    try {
      const raw = sessionStorage.getItem(this.SESSION_KEY);
      if (!raw) return;

      const s: CameraSession = JSON.parse(raw);
      const posOk = [s.px, s.py, s.pz].every(v => typeof v === 'number' && isFinite(v));
      const rotOk = [s.qx, s.qy, s.qz, s.qw].every(v => typeof v === 'number' && isFinite(v));
      if (!posOk || !rotOk) return;

      this.camera.position.set(s.px, s.py, s.pz);
      this.camera.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    } catch { }
  }
}
