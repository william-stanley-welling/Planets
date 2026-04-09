import { CommonModule } from '@angular/common';
import {
  AfterViewInit, Component, ElementRef, HostListener,
  OnDestroy, ViewChild
} from '@angular/core';
import * as THREE from 'three';
import { CameraView, SystemSnapshot, WebGl } from './webgl/webgl.service';
import { SIMULATION_CONSTANTS } from './galaxy/planet.model';

@Component({
  selector: 'dashboard',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    #content {
      position: relative;
      width: 100%;
      height: 100vh;
      overflow: hidden;
    }

    /* ── HUD hint ──────────────────────────────────────── */
    .hud-hint {
      position: absolute;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      color: #ccc;
      padding: 0.5rem 1.2rem;
      border-radius: 6px;
      font-size: 0.85rem;
      pointer-events: none;
      z-index: 100;
      white-space: nowrap;
    }

    /* ── Camera view buttons ───────────────────────────── */
    .cam-views {
      position: absolute;
      top: 16px;
      left: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 200;
    }

    .cam-btn {
      background: rgba(0,0,0,0.75);
      border: 1px solid rgba(255,255,255,0.35);
      border-radius: 6px;
      color: #e0e8ff;
      cursor: pointer;
      font-size: 0.78rem;
      letter-spacing: 0.04em;
      padding: 7px 14px;
      text-align: left;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }

    .cam-btn:hover, .cam-btn.active {
      background: rgba(30, 80, 160, 0.85);
      border-color: #6699ff;
      color: #fff;
    }

    /* ── Planet panel ──────────────────────────────────── */
    .planet-panel {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 200px;
      max-height: 80vh;
      background: rgba(0,0,0,0.82);
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 10px;
      overflow-y: auto;
      padding: 10px 8px;
      z-index: 200;
      scrollbar-width: thin;
    }

    .planet-label {
      color: rgba(255,255,255,0.45);
      font-size: 0.65rem;
      letter-spacing: 0.1em;
      padding: 0 6px 4px;
      text-transform: uppercase;
    }

    .planet-card {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      border-left: 3px solid transparent;
      border-radius: 6px;
      margin-bottom: 6px;
      padding: 8px 10px;
      cursor: pointer;
      transition: all 0.18s ease;
    }

    .planet-card:hover {
      background: rgba(255,255,255,0.14);
      border-color: rgba(255,255,255,0.5);
      transform: translateX(4px);
    }

    .planet-name {
      color: #e8eeff;
      font-size: 0.95rem;
      font-weight: 600;
    }

    .planet-meta {
      color: rgba(255,255,255,0.4);
      font-size: 0.7rem;
      margin-top: 2px;
    }

    /* ── Mini-map ──────────────────────────────────────── */
    .minimap-wrap {
      position: absolute;
      bottom: 60px;
      left: 16px;
      z-index: 200;
    }

    .minimap-label {
      color: rgba(255,255,255,0.35);
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      margin-bottom: 3px;
      text-transform: uppercase;
    }

    canvas.minimap {
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px;
      display: block;
    }
  `],
  template: `
    <div id="content" (click)="onContentClick($event)">

      <!-- Flight hint -->
      <span class="hud-hint">
        {{ webGl.controls?.locked
            ? 'FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift = 10× speed · Mouse look'
            : 'Click viewport or press Space to enter flight mode' }}
      </span>

      <!-- Camera view presets -->
      <div class="cam-views">
        <button class="cam-btn" [class.active]="activeView === 'overview'"
                (click)="setView(CameraView.OVERVIEW, $event)">⊙ Overview</button>
        <button class="cam-btn" [class.active]="activeView === 'ecliptic'"
                (click)="setView(CameraView.ECLIPTIC, $event)">— Ecliptic</button>
        <button class="cam-btn" [class.active]="activeView === 'cinematic'"
                (click)="setView(CameraView.CINEMATIC, $event)">◈ Cinematic</button>
      </div>

      <!-- Planet navigation panel -->
      <div class="planet-panel">
        <div class="planet-label">Planets</div>
        <div *ngFor="let planet of planets"
             class="planet-card"
             [style.border-left-color]="planet.config?.color || '#4488ff'"
             (click)="goToPlanet(planet, $event)">
          <div class="planet-name">{{ planet.name }}</div>
          <div class="planet-meta">{{ planet.config?.au | number:'1.2-2' }} AU</div>
        </div>
      </div>

      <!-- Mini-map -->
      <div class="minimap-wrap">
        <div class="minimap-label">Solar System</div>
        <canvas #minimap class="minimap" width="200" height="200"></canvas>
      </div>

    </div>
  `,
})
export class DashboardComponent implements AfterViewInit, OnDestroy {

  @ViewChild('minimap') minimapRef!: ElementRef<HTMLCanvasElement>;

  readonly CameraView = CameraView;   // expose enum to template

  planets: any[] = [];
  activeView: string | null = null;

  private minimapCtx!: CanvasRenderingContext2D;
  private minimapRaf = 0;
  private destroyed = false;

  constructor(
    public elementRef: ElementRef,
    public webGl: WebGl,
  ) { }

  // ── Host listeners ─────────────────────────────────────────────────────────

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void { this.webGl.keyDown(e); }

  @HostListener('window:resize')
  onResize(): void {
    const c = this.elementRef.nativeElement.querySelector('#content');
    if (c) this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  onContentClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('.planet-panel, .cam-views, .minimap-wrap')) return;
    if (!this.webGl.controls?.locked) this.webGl.controls?.enterFlight();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

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

    // Mini-map canvas
    this.minimapCtx = this.minimapRef.nativeElement.getContext('2d')!;
    this.startMiniMapLoop();

    // Wait for SSE to load planets, then populate sidebar
    setTimeout(() => this.loadPlanetList(), 1200);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.minimapRaf);
  }

  // ── Planet list ────────────────────────────────────────────────────────────

  private loadPlanetList(): void {
    if (!this.webGl.star?.satellites?.length) {
      // Retry until the SSE payload has been processed
      setTimeout(() => this.loadPlanetList(), 600);
      return;
    }

    this.planets = [...this.webGl.star.satellites]
      .filter((b: any) => b.name?.toLowerCase() !== 'sun')
      .sort((a: any, b: any) => (a.config?.au ?? 0) - (b.config?.au ?? 0));
  }

  // ── Camera view buttons ────────────────────────────────────────────────────

  setView(view: CameraView, event: MouseEvent): void {
    event.stopPropagation();
    this.activeView = view;
    this.webGl.setCameraView(view);
  }

  // ── Planet navigation ─────────────────────────────────────────────────────

  goToPlanet(planet: any, event: MouseEvent): void {
    event.stopPropagation();
    if (!planet || !this.webGl.star || !this.webGl.camera) return;

    this.activeView = null;
    this.webGl.navigateToPlanet(planet.name);
  }

  // ── Mini-map ───────────────────────────────────────────────────────────────

  private startMiniMapLoop(): void {
    const draw = () => {
      if (this.destroyed) return;
      this.drawMiniMap();
      this.minimapRaf = requestAnimationFrame(draw);
    };
    this.minimapRaf = requestAnimationFrame(draw);
  }

  private drawMiniMap(): void {
    const ctx = this.minimapCtx;
    if (!ctx || !this.webGl.camera) return;

    const W = 200, H = 200;
    const cx = W / 2, cy = H / 2;

    // Map Neptune's orbit (30 AU) to 90% of the half-canvas
    const AU_SCENE = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU; // 1496
    const OUTER_AU = 30.5;
    const scale = (W * 0.45) / (OUTER_AU * AU_SCENE);     // px per scene unit

    // ── Background ───────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0, 4, 18, 0.9)';
    ctx.fillRect(0, 0, W, H);

    const snap: SystemSnapshot = this.webGl.getSystemSnapshot();

    // ── Orbit rings ──────────────────────────────────────────────────────────
    ctx.lineWidth = 0.5;
    for (const body of snap.bodies) {
      if (body.isStar || body.au <= 0) continue;
      const r = body.au * AU_SCENE * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.stroke();
    }

    // ── Bodies ───────────────────────────────────────────────────────────────
    for (const body of snap.bodies) {
      const bx = cx + body.x * scale;
      const by = cy - body.y * scale;   // flip Y → screen space

      const r = body.isStar ? 5 : 2.5;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff';
      ctx.fill();

      if (!body.isStar && body.au <= OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), bx + 3.5, by - 2);
      }
    }

    // ── Camera position (projected to XY / ecliptic plane) ──────────────────
    const cam = snap.camera;
    let camX = cx + cam.x * scale;
    let camY = cy - cam.y * scale;

    // Clamp inside canvas with a margin
    const M = 8;
    const clamped = camX < M || camX > W - M || camY < M || camY > H - M;
    camX = Math.max(M, Math.min(W - M, camX));
    camY = Math.max(M, Math.min(H - M, camY));

    // Draw camera marker
    ctx.beginPath();
    ctx.arc(camX, camY, 3, 0, Math.PI * 2);
    ctx.fillStyle = clamped ? '#ff8844' : '#00ff88';
    ctx.fill();
    ctx.strokeStyle = clamped ? '#cc4400' : '#00cc66';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw a line from sun toward camera (direction only, capped at edge)
    const dx = camX - cx, dy = camY - cy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 4) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (dx / len) * Math.min(len, 90), cy + (dy / len) * Math.min(len, 90));
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // CAM label
    ctx.fillStyle = clamped ? '#ff8844' : '#00ff88';
    ctx.font = '7px monospace';
    ctx.fillText('CAM', camX + 4, camY + 3);

    // ── Border ───────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
