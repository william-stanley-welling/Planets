import * as THREE from 'three';
import { Star } from '../galaxy/star.model';

export {
  BodySnapshot,
  CameraInfo, CameraView, NavigationMode, NavigationRoute, NavigationWaypoint, SystemSnapshot
} from './webgl.interface';

export class HeliocentricControls {
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
