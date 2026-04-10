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
    
    /* Camera info box (top-left) */
    .info-panel { position: absolute; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); border-radius: 8px; padding: 8px 12px; font-family: monospace; font-size: 0.75rem; color: #ccddff; border: 1px solid rgba(255,255,255,0.2); z-index: 200; pointer-events: none; }
    .camera-info { top: 20px; left: 20px; text-align: left; }
    .date-info { bottom: 20px; right: 20px; text-align: right; }
    
    /* Planet panel (top-right, lower to avoid overlap) */
    .planet-panel { position: absolute; top: 100px; right: 20px; width: 220px; max-height: 70vh; background: rgba(0,0,0,0.82); border: 1px solid rgba(255,255,255,0.22); border-radius: 10px; overflow-y: auto; padding: 10px 8px; z-index: 200; }
    .planet-label { color: rgba(255,255,255,0.45); font-size: 0.65rem; padding: 0 6px 4px; text-transform: uppercase; }
    .planet-card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-left: 3px solid transparent; border-radius: 6px; margin-bottom: 6px; padding: 6px 8px; cursor: pointer; transition: all 0.18s ease; display: flex; align-items: center; justify-content: space-between; }
    .planet-card:hover { background: rgba(255,255,255,0.14); transform: translateX(4px); }
    .planet-name { color: #e8eeff; font-size: 0.9rem; font-weight: 600; }
    .planet-meta { color: rgba(255,255,255,0.4); font-size: 0.7rem; margin-top: 2px; }
    .indicator-canvas { width: 24px; height: 24px; margin-left: 8px; }
    
    /* Vertical sliders panel (left side, below camera info) */
    .sliders-panel { position: absolute; top: 120px; left: 20px; background: rgba(0,0,0,0.7); border-radius: 12px; padding: 12px; backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2); z-index: 200; pointer-events: auto; display: flex; gap: 20px; }
    .slider-container { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .slider-label { font-size: 0.7rem; color: #ccddff; text-transform: uppercase; }
    input[type="range"].vertical { writing-mode: bt-lr; -webkit-appearance: slider-vertical; width: 20px; height: 150px; background: #334; }
    .preset-buttons { display: flex; gap: 4px; margin-top: 8px; }
    .preset-buttons button { background: #223; border: none; color: #ccf; border-radius: 3px; padding: 2px 6px; font-size: 0.6rem; cursor: pointer; }
    .speed-value { font-size: 0.7rem; color: #ffaa66; }
    
    .orbit-controls { position: absolute; top: 20px; left: 220px; display: flex; gap: 8px; z-index: 200; pointer-events: auto; }
    .orbit-controls button { background: rgba(0,0,0,0.7); border: 1px solid #6699ff; color: #ccddff; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 0.7rem; }
    
    .minimap-wrap { position: absolute; bottom: 60px; left: 16px; z-index: 200; }
    .minimap-label { color: rgba(255,255,255,0.35); font-size: 0.6rem; margin-bottom: 3px; text-transform: uppercase; }
    canvas.minimap { border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; display: block; }
  `],
  template: `
    <div id="content" (click)="onContentClick($event)">
      <span class="hud-hint">{{ webGl.controls?.locked ? 'FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift = 10× speed · Mouse look' : 'Click viewport or press Space to enter flight mode' }}</span>

      <!-- Camera info (top-left) -->
      <div class="info-panel camera-info">
        <div>📍 POS: {{ cameraPos.x | number:'1.0-0' }}, {{ cameraPos.y | number:'1.0-0' }}, {{ cameraPos.z | number:'1.0-0' }}</div>
        <div>🔆 DIR: {{ cameraDir.x | number:'1.2-2' }}, {{ cameraDir.y | number:'1.2-2' }}, {{ cameraDir.z | number:'1.2-2' }}</div>
        <div>⚡ CAM SPEED: {{ cameraSpeed | number:'0.0-0' }} u/s</div>
      </div>

      <!-- Date info (bottom-right) -->
      <div class="info-panel date-info">
        <div>📅 SIM DATE: {{ simulationDate | date:'yyyy-MM-dd HH:mm:ss' }}</div>
        <div>⏱️ ΔT = {{ dateOffsetDays | number:'1.2-2' }} days</div>
        <div>⏩ SIM SPEED: {{ simSpeed | number:'1.1-1' }}x</div>
      </div>

      <!-- Sliders for simulation and camera speed -->
      <div class="sliders-panel">
        <div class="slider-container">
          <div class="slider-label">SIM TIME</div>
          <input type="range" class="vertical" min="0" max="100" [value]="simSpeedSlider" (input)="onSimSpeedSlider($event)" orient="vertical">
          <div class="speed-value">{{ simSpeed }}x</div>
          <div class="preset-buttons">
            <button (click)="setSimSpeed(0.25)">¼</button>
            <button (click)="setSimSpeed(0.5)">½</button>
            <button (click)="setSimSpeed(1)">1</button>
            <button (click)="setSimSpeed(2)">2</button>
            <button (click)="setSimSpeed(4)">4</button>
            <button (click)="setSimSpeed(5)">5</button>
            <button (click)="setSimSpeed(10)">10</button>
            <button (click)="setSimSpeed(100)">100</button>
          </div>
        </div>
        <div class="slider-container">
          <div class="slider-label">CAM MOVE</div>
          <input type="range" class="vertical" min="0" max="100" [value]="camSpeedSlider" (input)="onCamSpeedSlider($event)" orient="vertical">
          <div class="speed-value">{{ camBaseSpeed | number:'0.0-0' }} u/s</div>
          <div class="preset-buttons">
            <button (click)="setCamSpeed(0.1)">0.1x</button>
            <button (click)="setCamSpeed(0.5)">0.5x</button>
            <button (click)="setCamSpeed(1)">1x</button>
            <button (click)="setCamSpeed(2)">2x</button>
            <button (click)="setCamSpeed(4)">4x</button>
          </div>
        </div>
      </div>

      <!-- Orbit toggles -->
      <div class="orbit-controls">
        <button (click)="webGl.togglePlanetOrbits(!webGl.showPlanetOrbits)">🌍 Planet Orbits</button>
        <button (click)="webGl.toggleMoonOrbits(!webGl.showMoonOrbits)">🌙 Moon Orbits</button>
        <button (click)="toggleSelectedPlanetMoons()">🔘 Toggle Moons of Selected</button>
      </div>

      <!-- Planet panel (top-right) -->
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

      <!-- Mini-map -->
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
  simSpeed = 1;
  camBaseSpeed = 3000;
  simSpeedSlider = 50;   // maps 0-100 to 0.25-4
  camSpeedSlider = 50;   // maps 0-100 to 100-50000

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
    if ((event.target as HTMLElement).closest('.planet-panel, .cam-views, .minimap-wrap, .orbit-controls, .sliders-panel')) return;
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
    for (let [planetName, canvas] of this.triangleIndicators.entries()) {
      const angle = this.webGl.getBodyPhaseAngle(planetName);
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

  // private startInfoUpdate() {
  //   setInterval(() => {
  //     const info = this.webGl.getCameraInfo();
  //     this.cameraPos = { x: info.position.x, y: info.position.y, z: info.position.z };
  //     this.cameraDir = { x: info.direction.x, y: info.direction.y, z: info.direction.z };
  //     this.cameraSpeed = info.velocity;
  //     this.simulationDate = new Date(this.webGl.simulationTime);
  //     const now = Date.now();
  //     this.dateOffsetDays = (this.webGl.simulationTime - now) / 86400000;
  //     this.updateTriangleIndicators();
  //   }, 100);
  // }
  private startInfoUpdate() {
    setInterval(() => {
      const info = this.webGl.getCameraInfo();
      this.cameraPos = info.position;
      this.cameraDir = info.direction;
      this.cameraSpeed = info.velocity;
      this.simulationDate = new Date(this.webGl.simulationTime);
      this.dateOffsetDays = (this.webGl.simulationTime - Date.now()) / 86400000;
      this.updateTriangleIndicators();
    }, 80);
  }

  // Simulation speed control
  setSimSpeed(speed: number) {
    this.simSpeed = Math.min(100, Math.max(0.25, speed));
    this.webGl.setSimulationSpeed(this.simSpeed);
    // map speed 0.25-100 to slider 0-100 (exponential)
    const min = 0.25, max = 100;
    const t = Math.log(this.simSpeed / min) / Math.log(max / min);
    this.simSpeedSlider = t * 100;
  }

  onSimSpeedSlider(event: Event) {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.simSpeedSlider = val;
    const t = val / 100;
    const min = 0.25, max = 100;
    const speed = min * Math.pow(max / min, t);
    this.setSimSpeed(speed);
  }

  // Camera base speed control
  setCamSpeed(multiplier: number) {
    let newBase = 3000 * multiplier;
    newBase = Math.min(50000, Math.max(100, newBase));
    // adjust the controls
    this.webGl.setCameraBaseSpeed(newBase);
    this.camBaseSpeed = newBase;
    // map 100-50000 to slider 0-100 (log)
    const t = Math.log(newBase / 100) / Math.log(50000 / 100);
    this.camSpeedSlider = t * 100;
  }

  onCamSpeedSlider(event: Event) {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.camSpeedSlider = val;
    const t = val / 100;
    const speed = 100 * Math.pow(50000 / 100, t);
    this.setCamSpeed(speed / 3000);
  }

  toggleSelectedPlanetMoons() {
    if (this.webGl.selectedPlanetName) this.webGl.toggleMoonsOfPlanet(this.webGl.selectedPlanetName, !this.webGl.showMoonOrbits);
  }

  goToPlanet(planet: any, event: MouseEvent) {
    event.stopPropagation();
    this.activeView = null;
    this.webGl.navigateToPlanet(planet.name);
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
