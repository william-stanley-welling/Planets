import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import * as THREE from 'three';
import { CameraView, SystemSnapshot, WebGl } from './webgl/webgl.service';
import { SIMULATION_CONSTANTS } from './galaxy/celestial.model';

@Component({
  selector: 'dashboard',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    #content { position: relative; width: 100%; height: 100vh; overflow: hidden; }
    .hud-hint { position: absolute; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); color: #ccc; padding: 0.5rem 1.2rem; border-radius: 6px; font-size: 0.85rem; pointer-events: none; z-index: 100; white-space: nowrap; }
    .cam-views { position: absolute; top: 16px; left: 16px; display: flex; flex-direction: column; gap: 6px; z-index: 200; }
    .cam-btn { background: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.35); border-radius: 6px; color: #e0e8ff; cursor: pointer; font-size: 0.78rem; padding: 7px 14px; text-align: left; transition: background 0.15s; white-space: nowrap; }
    .cam-btn:hover, .cam-btn.active { background: rgba(30,80,160,0.85); border-color: #6699ff; color: #fff; }
    .planet-panel { position: absolute; top: 20px; right: 20px; width: 220px; max-height: 80vh; background: rgba(0,0,0,0.82); border: 1px solid rgba(255,255,255,0.22); border-radius: 10px; overflow-y: auto; padding: 10px 8px; z-index: 200; }
    .planet-label { color: rgba(255,255,255,0.45); font-size: 0.65rem; padding: 0 6px 4px; text-transform: uppercase; }
    .planet-card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-left: 3px solid transparent; border-radius: 6px; margin-bottom: 6px; padding: 6px 8px; cursor: pointer; transition: all 0.18s ease; display: flex; align-items: center; justify-content: space-between; }
    .planet-card:hover { background: rgba(255,255,255,0.14); transform: translateX(4px); }
    .planet-name { color: #e8eeff; font-size: 0.9rem; font-weight: 600; }
    .planet-meta { color: rgba(255,255,255,0.4); font-size: 0.7rem; margin-top: 2px; }
    .indicator-canvas { width: 24px; height: 24px; margin-left: 8px; }
    .info-panel { position: absolute; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); border-radius: 8px; padding: 8px 12px; font-family: monospace; font-size: 0.75rem; color: #ccddff; border: 1px solid rgba(255,255,255,0.2); z-index: 200; pointer-events: none; }
    .camera-info { bottom: 20px; right: 20px; text-align: right; }
    .date-info { bottom: 20px; left: 20px; }
    .orbit-controls { position: absolute; top: 20px; left: 120px; display: flex; gap: 8px; z-index: 200; pointer-events: auto; }
    .orbit-controls button { background: rgba(0,0,0,0.7); border: 1px solid #6699ff; color: #ccddff; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 0.7rem; }
    .minimap-wrap { position: absolute; bottom: 60px; left: 16px; z-index: 200; }
    .minimap-label { color: rgba(255,255,255,0.35); font-size: 0.6rem; margin-bottom: 3px; text-transform: uppercase; }
    canvas.minimap { border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; display: block; }
  `],
  template: `
    <div id="content" (click)="onContentClick($event)">
      <span class="hud-hint">{{ webGl.controls?.locked ? 'FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift = 10× speed · Mouse look' : 'Click viewport or press Space to enter flight mode' }}</span>

      <div class="cam-views">
        <button class="cam-btn" [class.active]="activeView === 'overview'" (click)="setView(CameraView.OVERVIEW, $event)">⊙ Overview</button>
        <button class="cam-btn" [class.active]="activeView === 'ecliptic'" (click)="setView(CameraView.ECLIPTIC, $event)">— Ecliptic</button>
        <button class="cam-btn" [class.active]="activeView === 'cinematic'" (click)="setView(CameraView.CINEMATIC, $event)">◈ Cinematic</button>
      </div>

      <div class="orbit-controls">
        <button (click)="webGl.togglePlanetOrbits(!webGl.showPlanetOrbits)">🌍 Planet Orbits</button>
        <button (click)="webGl.toggleMoonOrbits(!webGl.showMoonOrbits)">🌙 Moon Orbits</button>
        <button (click)="toggleSelectedPlanetMoons()">🔘 Toggle Moons of Selected</button>
      </div>

      <div class="planet-panel">
        <div class="planet-label">Planets</div>
        <div *ngFor="let planet of planets" class="planet-card" [style.border-left-color]="planet.config?.color || '#4488ff'" (click)="goToPlanet(planet, $event)">
          <div>
            <div class="planet-name">{{ planet.name }}</div>
            <div class="planet-meta">{{ planet.config?.au | number:'1.2-2' }} AU</div>
          </div>
          <canvas #indicator [attr.data-planet]="planet.name" class="indicator-canvas" width="24" height="24"></canvas>
        </div>
      </div>

      <div class="info-panel camera-info">
        <div>📍 POS: {{ cameraPos.x | number:'1.0-0' }}, {{ cameraPos.y | number:'1.0-0' }}, {{ cameraPos.z | number:'1.0-0' }}</div>
        <div>🔆 DIR: {{ cameraDir.x | number:'1.2-2' }}, {{ cameraDir.y | number:'1.2-2' }}, {{ cameraDir.z | number:'1.2-2' }}</div>
        <div>⚡ SPEED: {{ cameraSpeed | number:'1.0-0' }} u/s</div>
      </div>

      <div class="info-panel date-info">
        <div>📅 SIM DATE: {{ simulationDate | date:'yyyy-MM-dd HH:mm:ss' }}</div>
        <div>⏱️ ΔT = {{ dateOffsetDays | number:'1.2-2' }} days</div>
      </div>

      <div class="minimap-wrap">
        <div class="minimap-label">Solar System</div>
        <canvas #minimap class="minimap" width="200" height="200"></canvas>
      </div>
    </div>
  `
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  @ViewChild('minimap') minimapRef!: ElementRef<HTMLCanvasElement>;
  readonly CameraView = CameraView;

  planets: any[] = [];
  activeView: string | null = null;

  cameraPos = { x: 0, y: 0, z: 0 };
  cameraDir = { x: 0, y: 0, z: 0 };
  cameraSpeed = 0;
  simulationDate = new Date();
  dateOffsetDays = 0;

  private minimapCtx!: CanvasRenderingContext2D;
  private minimapRaf = 0;
  private destroyed = false;
  private triangleIndicators = new Map<string, HTMLCanvasElement>();

  constructor(public elementRef: ElementRef, public webGl: WebGl) { }

  @HostListener('window:keydown', ['$event']) onKeyDown(e: KeyboardEvent) { this.webGl.keyDown(e); }
  @HostListener('window:resize') onResize() {
    const c = this.elementRef.nativeElement.querySelector('#content');
    if (c) this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  onContentClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('.planet-panel, .cam-views, .minimap-wrap, .orbit-controls')) return;
    if (!this.webGl.controls?.locked) this.webGl.controls?.enterFlight();
  }

  ngAfterViewInit(): void {
    const container = this.elementRef.nativeElement.querySelector('#content');
    const rendererEl = this.webGl.getRenderer().domElement;
    container.appendChild(rendererEl);
    rendererEl.style.width = '100%';
    rendererEl.style.height = '100%';
    if (!this.webGl.isActive()) {
      this.webGl.init(container.clientHeight, container.clientWidth);
      this.webGl.start();
    }
    this.onResize();
    this.minimapCtx = this.minimapRef.nativeElement.getContext('2d')!;
    this.startMiniMapLoop();
    this.startInfoUpdate();
    setTimeout(() => this.loadPlanetList(), 1200);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.minimapRaf);
  }

  private loadPlanetList(): void {
    if (!this.webGl.star?.satellites?.length) { setTimeout(() => this.loadPlanetList(), 600); return; }
    this.planets = [...this.webGl.star.satellites]
      .filter((b: any) => b.name?.toLowerCase() !== 'sun')
      .sort((a: any, b: any) => (a.config?.au ?? 0) - (b.config?.au ?? 0));
    // Create triangle indicators
    setTimeout(() => this.initTriangleIndicators(), 100);
  }

  private initTriangleIndicators() {
    const cards = document.querySelectorAll('.planet-card');
    cards.forEach(card => {
      const canvas = card.querySelector('canvas.indicator-canvas') as HTMLCanvasElement;
      const planetName = canvas?.getAttribute('data-planet');
      if (planetName) this.triangleIndicators.set(planetName, canvas);
    });
  }

  private updateTriangleIndicators() {
    const cameraPos = this.webGl.getCamera().position;
    const cameraDir = this.webGl.getCamera().getWorldDirection(new THREE.Vector3());
    for (let [planetName, canvas] of this.triangleIndicators.entries()) {
      const planet = this.webGl.star.satellites.find(p => p.name === planetName) as any;
      if (!planet) continue;
      const planetPos = new THREE.Vector3();
      planet.orbitalGroup.getWorldPosition(planetPos);
      const toPlanet = planetPos.clone().sub(cameraPos).normalize();
      const angle = Math.atan2(toPlanet.y, toPlanet.x);
      this.drawTriangle(canvas, angle);
    }
  }

  private drawTriangle(canvas: HTMLCanvasElement, angleRad: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffaa44';
    ctx.beginPath();
    const cx = w / 2, cy = h / 2;
    const tipX = cx + Math.cos(angleRad) * 10;
    const tipY = cy + Math.sin(angleRad) * 10;
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(cx + Math.cos(angleRad + 2.0) * 6, cy + Math.sin(angleRad + 2.0) * 6);
    ctx.lineTo(cx + Math.cos(angleRad - 2.0) * 6, cy + Math.sin(angleRad - 2.0) * 6);
    ctx.fill();
  }

  private startInfoUpdate() {
    setInterval(() => {
      const info = this.webGl.getCameraInfo();
      this.cameraPos = { x: info.position.x, y: info.position.y, z: info.position.z };
      this.cameraDir = { x: info.direction.x, y: info.direction.y, z: info.direction.z };
      this.cameraSpeed = info.velocity;
      this.simulationDate = new Date(this.webGl.simulationTime);
      const now = Date.now();
      this.dateOffsetDays = (this.webGl.simulationTime - now) / 86400000;
      this.updateTriangleIndicators();
    }, 100);
  }

  setView(view: CameraView, event: MouseEvent) { event.stopPropagation(); this.activeView = view; this.webGl.setCameraView(view); }
  goToPlanet(planet: any, event: MouseEvent) { event.stopPropagation(); this.activeView = null; this.webGl.navigateToPlanet(planet.name); }
  toggleSelectedPlanetMoons() {
    if (this.webGl.selectedPlanetName) this.webGl.toggleMoonsOfPlanet(this.webGl.selectedPlanetName, !this.webGl.showMoonOrbits);
  }

  private startMiniMapLoop() {
    const draw = () => {
      if (this.destroyed) return;
      this.drawMiniMap();
      this.minimapRaf = requestAnimationFrame(draw);
    };
    this.minimapRaf = requestAnimationFrame(draw);
  }

  private drawMiniMap() {
    const ctx = this.minimapCtx;
    if (!ctx || !this.webGl.camera) return;
    const W = 200, H = 200, cx = W / 2, cy = H / 2;
    const AU_SCENE = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const OUTER_AU = 30.5;
    const scale = (W * 0.45) / (OUTER_AU * AU_SCENE);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,4,18,0.9)';
    ctx.fillRect(0, 0, W, H);
    const snap = this.webGl.getSystemSnapshot();
    for (const body of snap.bodies) {
      if (body.isStar || body.au <= 0) continue;
      const r = body.au * AU_SCENE * scale;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.stroke();
    }
    for (const body of snap.bodies) {
      const bx = cx + body.x * scale, by = cy - body.y * scale;
      ctx.beginPath(); ctx.arc(bx, by, body.isStar ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff'; ctx.fill();
      if (!body.isStar && body.au <= OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), bx + 3.5, by - 2);
      }
    }
    const cam = snap.camera;
    let camX = cx + cam.x * scale, camY = cy - cam.y * scale;
    camX = Math.max(8, Math.min(W - 8, camX)); camY = Math.max(8, Math.min(H - 8, camY));
    ctx.beginPath(); ctx.arc(camX, camY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88'; ctx.fill();
    ctx.strokeStyle = '#00cc66'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#00ff88'; ctx.font = '7px monospace'; ctx.fillText('CAM', camX + 4, camY + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
