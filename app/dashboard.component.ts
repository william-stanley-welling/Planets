/**
 * @fileoverview Root dashboard component for the heliocentric simulation.
 *
 * Hosts the Three.js canvas, all HUD panels, and orchestrates:
 *  - Planet list with single/multi-select and fly-to navigation.
 *  - 3-D raycasting selection forwarded from canvas clicks.
 *  - Simulation-time and camera-speed sliders with preset buttons.
 *  - Orbit-line toggle controls.
 *  - Minimap canvas overlay.
 *  - Compass-needle indicators per planet card.
 *
 * @module dashboard.component
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { CameraView, SystemSnapshot, WebGl } from './webgl/webgl.service';
import { SIMULATION_CONSTANTS } from './galaxy/celestial.model';
import { Subscription } from 'rxjs';

/**
 * Root HUD component rendered over the Three.js viewport.
 *
 * @example
 * ```html
 * <dashboard></dashboard>
 * ```
 */
@Component({
  selector: 'dashboard',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    #content { position: relative; width: 100%; height: 100vh; overflow: hidden; }

    .hud-hint {
      position: absolute; bottom: 1.5rem; left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7); color: #ccc;
      padding: 0.5rem 1.2rem; border-radius: 6px;
      font-size: 0.85rem; pointer-events: none; z-index: 100; white-space: nowrap;
    }

    .info-panel {
      position: absolute; background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px); border-radius: 8px;
      padding: 8px 12px; font-family: monospace;
      font-size: 0.75rem; color: #ccddff;
      border: 1px solid rgba(255,255,255,0.2); z-index: 200; pointer-events: none;
    }
    .camera-info { top: 20px; left: 20px; text-align: left; }
    .date-info   { bottom: 20px; right: 20px; text-align: right; }

    /* Planet selector panel */
    .planet-panel {
      position: absolute; top: 100px; right: 20px;
      width: 220px; max-height: 70vh;
      background: rgba(0,0,0,0.82); border: 1px solid rgba(255,255,255,0.22);
      border-radius: 10px; overflow-y: auto; padding: 10px 8px; z-index: 200;
    }
    .planet-label { color: rgba(255,255,255,0.45); font-size: 0.65rem; padding: 0 6px 4px; text-transform: uppercase; }
    .planet-multiselect-hint { color: rgba(255,255,255,0.28); font-size: 0.6rem; padding: 0 6px 6px; }

    .planet-card {
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15);
      border-left: 3px solid transparent; border-radius: 6px;
      margin-bottom: 6px; padding: 6px 8px; cursor: pointer;
      transition: all 0.18s ease; display: flex; align-items: center; justify-content: space-between;
    }
    .planet-card:hover    { background: rgba(255,255,255,0.14); transform: translateX(4px); }
    .planet-card.selected { background: rgba(100,160,255,0.18); border-color: rgba(100,160,255,0.6); }

    .planet-name { color: #e8eeff; font-size: 0.9rem; font-weight: 600; }
    .planet-meta { color: rgba(255,255,255,0.4); font-size: 0.7rem; margin-top: 2px; }
    .indicator-canvas { width: 24px; height: 24px; margin-left: 8px; flex-shrink: 0; }

    /* Selection info strip */
    .selection-bar {
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,20,0.85); border: 1px solid rgba(80,140,255,0.5);
      border-radius: 6px; padding: 4px 14px; z-index: 210;
      color: #99ccff; font-family: monospace; font-size: 0.75rem;
      pointer-events: none; white-space: nowrap;
    }

    /* Speed sliders */
    .sliders-panel {
      position: absolute; top: 120px; left: 20px;
      background: rgba(0,0,0,0.7); border-radius: 12px; padding: 12px;
      backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2);
      z-index: 200; pointer-events: auto; display: flex; gap: 20px;
    }
    .slider-container { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .slider-label     { font-size: 0.7rem; color: #ccddff; text-transform: uppercase; }
    input[type="range"].vertical {
      writing-mode: bt-lr; -webkit-appearance: slider-vertical;
      width: 20px; height: 150px; background: #334;
    }
    .preset-buttons       { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
    .preset-buttons button {
      background: #223; border: none; color: #ccf;
      border-radius: 3px; padding: 2px 6px; font-size: 0.6rem; cursor: pointer;
    }
    .speed-value { font-size: 0.7rem; color: #ffaa66; }

    .orbit-controls { position: absolute; top: 20px; left: 220px; display: flex; gap: 8px; z-index: 200; pointer-events: auto; }
    .orbit-controls button {
      background: rgba(0,0,0,0.7); border: 1px solid #6699ff;
      color: #ccddff; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 0.7rem;
    }

    .minimap-wrap  { position: absolute; bottom: 60px; left: 16px; z-index: 200; }
    .minimap-label { color: rgba(255,255,255,0.35); font-size: 0.6rem; margin-bottom: 3px; text-transform: uppercase; }
    canvas.minimap { border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; display: block; }
  `],
  template: `
    <div id="content"
         (click)="onContentClick($event)"
         (mousedown)="onCanvasMouseDown($event)">

      <!-- Flight mode hint -->
      <span class="hud-hint">
        {{ webGl.controls?.locked
            ? 'FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift = 10× · Mouse look'
            : 'Click viewport or press Space to enter flight mode' }}
      </span>

      <!-- Camera diagnostics (top-left) -->
      <div class="info-panel camera-info">
        <div>📍 POS: {{ cameraPos.x | number:'1.0-0' }}, {{ cameraPos.y | number:'1.0-0' }}, {{ cameraPos.z | number:'1.0-0' }}</div>
        <div>🔆 DIR: {{ cameraDir.x | number:'1.2-2' }}, {{ cameraDir.y | number:'1.2-2' }}, {{ cameraDir.z | number:'1.2-2' }}</div>
        <div>⚡ CAM SPEED: {{ cameraSpeed | number:'0.0-0' }} u/s</div>
      </div>

      <!-- Simulation date (bottom-right) -->
      <div class="info-panel date-info">
        <div>📅 SIM DATE: {{ simulationDate | date:'yyyy-MM-dd HH:mm:ss' }}</div>
        <div>⏱️ ΔT = {{ dateOffsetDays | number:'1.2-2' }} days</div>
        <div>⏩ SIM SPEED: {{ simSpeed | number:'1.1-1' }}x</div>
      </div>

      <!-- Selection bar -->
      <div class="selection-bar" *ngIf="selectedNames.size > 0">
        ✦ {{ selectedNamesDisplay }}
      </div>

      <!-- Simulation / camera sliders -->
      <div class="sliders-panel">
        <div class="slider-container">
          <div class="slider-label">SIM TIME</div>
          <input type="range" class="vertical" min="0" max="100"
                 [value]="simSpeedSlider"
                 (input)="onSimSpeedSlider($event)"
                 orient="vertical">
          <div class="speed-value">{{ simSpeed }}x</div>
          <div class="preset-buttons">
            <button (click)="setSimSpeed(0.25)">¼</button>
            <button (click)="setSimSpeed(0.5)">½</button>
            <button (click)="setSimSpeed(1)">1</button>
            <button (click)="setSimSpeed(2)">2</button>
            <button (click)="setSimSpeed(4)">4</button>
            <button (click)="setSimSpeed(16)">16</button>
            <button (click)="setSimSpeed(32)">32</button>
            <button (click)="setSimSpeed(64)">64</button>
            <button (click)="setSimSpeed(128)">128</button>
            <button (click)="setSimSpeed(256)">256</button>
            <button (click)="setSimSpeed(512)">512</button>
            <button (click)="setSimSpeed(1024)">1024</button>
          </div>
        </div>

        <div class="slider-container">
          <div class="slider-label">CAM MOVE</div>
          <input type="range" class="vertical" min="0" max="100"
                 [value]="camSpeedSlider"
                 (input)="onCamSpeedSlider($event)"
                 orient="vertical">
          <div class="speed-value">{{ camBaseSpeed | number:'0.0-0' }} u/s</div>
          <div class="preset-buttons">
            <button (click)="setCamSpeed(0.001)">0.001x</button>
            <button (click)="setCamSpeed(0.01)">0.01x</button>
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
        <button (click)="toggleSelectedMoons()">🔘 Toggle Moons of Selected</button>
      </div>

      <!-- Planet / body selector panel -->
      <div class="planet-panel">
        <div class="planet-label">Planets</div>
        <div class="planet-multiselect-hint">Ctrl+click to multi-select</div>
        <div *ngFor="let planet of planets"
             class="planet-card"
             [class.selected]="selectedNames.has(planet.name)"
             [style.border-left-color]="planet.config?.color || '#4488ff'"
             (click)="onPlanetCardClick(planet, $event)">
          <div>
            <div class="planet-name">{{ planet.name }}</div>
            <div class="planet-meta">{{ planet.config?.au | number:'1.2-2' }} AU</div>
          </div>
          <canvas [attr.data-planet]="planet.name"
                  class="indicator-canvas"
                  width="24" height="24"></canvas>
        </div>
      </div>

      <!-- Minimap -->
      <div class="minimap-wrap">
        <div class="minimap-label">Solar System</div>
        <canvas #minimap class="minimap" width="200" height="200"></canvas>
      </div>
    </div>
  `,
})
export class DashboardComponent implements AfterViewInit, OnDestroy {

  private subscriptions = new Subscription();

  /** Reference to the minimap `<canvas>` element. */
  @ViewChild('minimap') minimapRef!: ElementRef<HTMLCanvasElement>;

  /** Expose enum to template. */
  readonly CameraView = CameraView;

  /** Sorted list of planet bodies populated once the scene hierarchy is ready. */
  planets: any[] = [];

  /** Active preset view name (unused by template but kept for extension). */
  activeView: string | null = null;

  // Camera diagnostics
  cameraPos = { x: 0, y: 0, z: 0 };
  cameraDir = { x: 0, y: 0, z: 0 };
  cameraSpeed = 0;

  // Date display
  simulationDate = new Date();
  dateOffsetDays = 0;

  // Speed controls
  simSpeed = 1;
  camBaseSpeed = 3000;
  simSpeedSlider = 50;
  camSpeedSlider = 50;

  /** Mirror of `webGl.selectedNames` for template binding. */
  selectedNames = new Set<string>();

  /** Comma-separated display string for the selection bar. */
  get selectedNamesDisplay(): string {
    return [...this.selectedNames].join(', ');
  }

  private minimapCtx!: CanvasRenderingContext2D;
  private minimapRaf = 0;
  private destroyed = false;
  private triangleIndicators = new Map<string, HTMLCanvasElement>();

  /**
   * @param {ElementRef} elementRef - Host element reference.
   * @param {WebGl}      webGl      - Injected WebGL rendering service.
   */
  constructor(public elementRef: ElementRef, public webGl: WebGl) { }

  // ─── Host listeners ─────────────────────────────────────────────────────────

  /**
   * Delegates global keyboard events to the WebGL service.
   *
   * @param {KeyboardEvent} e - The keyboard event.
   */
  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void { this.webGl.keyDown(e); }

  /**
   * Synchronises renderer dimensions on window resize.
   */
  @HostListener('window:resize')
  onResize(): void {
    const c = this.elementRef.nativeElement.querySelector('#content');
    if (c) this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attaches the WebGL canvas, starts the engine if not already active,
   * and boots all HUD update loops.
   */
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

    // Wire selection-change callback.
    this.webGl.onSelectionChanged = (names) => {
      this.selectedNames = new Set(names);
    };

    this.subscriptions.add(
      this.webGl.simulationTime$.subscribe(time => {
        this.simulationDate = new Date(time);
        this.dateOffsetDays = (time - Date.now()) / 86_400_000;
      })
    );

    // Delay planet list load until the hierarchy is built.
    setTimeout(() => this.loadPlanetList(), 1200);
  }

  /**
   * Cancels the minimap RAF loop on component destruction.
   */
  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.minimapRaf);
    this.subscriptions.unsubscribe();
  }

  // ─── Canvas click handling ──────────────────────────────────────────────────

  /**
   * Handles clicks on the main viewport area.
   * Clicks inside HUD panels enter flight mode; clicks on the raw canvas
   * trigger raycasting body selection.
   *
   * @param {MouseEvent} event - The originating click event.
   */
  onContentClick(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel'
    );
    if (isHud) return;
    if (!this.webGl.controls?.locked) {
      this.webGl.controls?.enterFlight();
    }
  }

  /**
   * Routes `mousedown` events on the canvas to the WebGL raycaster.
   * Ctrl (or Meta on macOS) held during the click enables multiselect.
   *
   * @param {MouseEvent} event - The originating mousedown event.
   */
  onCanvasMouseDown(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel'
    );
    if (isHud) return;
    if (this.webGl.controls?.locked) return; // in flight mode — don't interfere
    const multiselect = event.ctrlKey || event.metaKey;
    this.webGl.handleCanvasClick(event, multiselect);
    this.selectedNames = new Set(this.webGl.selectedNames);
  }

  // ─── Planet panel ───────────────────────────────────────────────────────────

  /**
   * Handles a click on a planet card.
   * Ctrl/Meta held = toggle the body in the multiselect set.
   * Plain click = select only this body and fly to it.
   *
   * @param {any}        planet - Planet body object from `planets` array.
   * @param {MouseEvent} event  - The originating click event.
   */
  onPlanetCardClick(planet: any, event: MouseEvent): void {
    event.stopPropagation();
    const multiselect = event.ctrlKey || event.metaKey;

    if (multiselect) {
      if (this.selectedNames.has(planet.name)) {
        this.selectedNames.delete(planet.name);
        this.webGl.selectedNames.delete(planet.name);
        this.webGl['setHighlight']?.(planet.name, false);
      } else {
        this.selectedNames.add(planet.name);
        this.webGl.selectedNames.add(planet.name);
        this.webGl['setHighlight']?.(planet.name, true);
      }
    } else {
      this.webGl.selectBodies([planet.name], true);
      this.selectedNames = new Set(this.webGl.selectedNames);
    }
  }

  /**
   * Toggles the moon orbit ellipses for all currently selected bodies.
   */
  toggleSelectedMoons(): void {
    for (const name of this.selectedNames) {
      this.webGl.toggleMoonsOfPlanet(name, !this.webGl.showMoonOrbits);
    }
  }

  // ─── Simulation speed ───────────────────────────────────────────────────────

  /**
   * Sets the simulation speed to a discrete preset value and updates the slider.
   *
   * @param {number} speed - Desired simulation multiplier (0.25 – 10 000).
   */
  setSimSpeed(speed: number): void {
    this.simSpeed = Math.min(10_000, Math.max(0.25, speed));
    this.webGl.setSimulationSpeed(this.simSpeed);
    const min = 0.25, max = 10_000;
    const t = Math.log(this.simSpeed / min) / Math.log(max / min);
    this.simSpeedSlider = t * 100;
  }

  /**
   * Handles raw slider input and maps it to an exponential speed value.
   *
   * @param {Event} event - The `input` event from the range element.
   */
  onSimSpeedSlider(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.simSpeedSlider = val;
    const min = 0.25, max = 10_000;
    const speed = min * Math.pow(max / min, val / 100);
    this.setSimSpeed(speed);
  }

  // ─── Camera speed ───────────────────────────────────────────────────────────

  /**
   * Sets the camera movement speed to a preset multiplier relative to the 3000 base.
   *
   * @param {number} multiplier - Fractional multiplier applied to the 3000 base speed.
   */
  setCamSpeed(multiplier: number): void {
    const newBase = Math.min(50_000, Math.max(3, 3000 * multiplier));
    this.webGl.setCameraBaseSpeed(newBase);
    this.camBaseSpeed = newBase;
    const t = Math.log(newBase / 3) / Math.log(50_000 / 3);
    this.camSpeedSlider = t * 100;
  }

  /**
   * Handles raw slider input for the camera speed control.
   *
   * @param {Event} event - The `input` event from the range element.
   */
  onCamSpeedSlider(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.camSpeedSlider = val;
    const speed = 100 * Math.pow(50_000 / 100, val / 100);
    this.setCamSpeed(speed / 3000);
  }

  // ─── Private: planet list loading ───────────────────────────────────────────

  /**
   * Polls until the star hierarchy is available, then populates the planet list
   * sorted by ascending AU and boots triangle-indicator discovery.
   */
  private loadPlanetList(): void {
    if (!this.webGl.star?.satellites?.length) {
      setTimeout(() => this.loadPlanetList(), 600);
      return;
    }
    this.planets = [...this.webGl.star.satellites]
      .filter((b: any) => b.name?.toLowerCase() !== 'sun')
      .sort((a: any, b: any) => (a.config?.au ?? 0) - (b.config?.au ?? 0));
    setTimeout(() => this.initTriangleIndicators(), 100);
  }

  /**
   * Discovers all indicator canvases in the DOM and registers them in
   * `triangleIndicators` keyed by planet name.
   */
  private initTriangleIndicators(): void {
    document.querySelectorAll('.planet-card canvas.indicator-canvas').forEach(el => {
      const canvas = el as HTMLCanvasElement;
      const name = canvas.getAttribute('data-planet');
      if (name) this.triangleIndicators.set(name, canvas);
    });
  }

  /**
   * Redraws all compass-needle triangle indicators with the current phase angles.
   */
  private updateTriangleIndicators(): void {
    for (const [name, canvas] of this.triangleIndicators) {
      this.drawTriangle(canvas, this.webGl.getBodyPhaseAngle(name));
    }
  }

  /**
   * Draws a filled equilateral triangle on the given canvas, rotated to `angleRad`.
   *
   * @param {HTMLCanvasElement} canvas   - Target canvas.
   * @param {number}            angleRad - Rotation angle in radians.
   */
  private drawTriangle(canvas: HTMLCanvasElement, angleRad: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffaa44';
    ctx.beginPath();
    const cx = w / 2, cy = h / 2;
    ctx.moveTo(cx + Math.cos(angleRad) * 10, cy + Math.sin(angleRad) * 10);
    ctx.lineTo(cx + Math.cos(angleRad + 2.0) * 6, cy + Math.sin(angleRad + 2.0) * 6);
    ctx.lineTo(cx + Math.cos(angleRad - 2.0) * 6, cy + Math.sin(angleRad - 2.0) * 6);
    ctx.fill();
  }

  // ─── Private: HUD update loop ────────────────────────────────────────────────

  /**
   * Starts an 80 ms polling interval that updates all camera diagnostics,
   * the simulated date, and the per-planet compass indicators.
   */
  private startInfoUpdate(): void {
    setInterval(() => {
      const info = this.webGl.getCameraInfo();
      this.cameraPos = info.position;
      this.cameraDir = info.direction;
      this.cameraSpeed = info.velocity;
      // this.simulationDate = new Date(this.webGl.simulationTime);
      // this.dateOffsetDays = (this.webGl.simulationTime - Date.now()) / 86_400_000;
      this.updateTriangleIndicators();
    }, 80);
  }

  // ─── Private: minimap ───────────────────────────────────────────────────────

  /**
   * Starts the minimap RAF draw loop.
   */
  private startMiniMapLoop(): void {
    const draw = () => {
      if (this.destroyed) return;
      this.drawMiniMap();
      this.minimapRaf = requestAnimationFrame(draw);
    };
    this.minimapRaf = requestAnimationFrame(draw);
  }

  /**
   * Renders one frame of the top-down orbital minimap, including:
   *  - Faint concentric orbit rings (AU-scaled).
   *  - Colour-coded body dots with name labels.
   *  - A green camera position indicator.
   *
   * @remarks
   * Camera position is clamped to the canvas border so it remains
   * visible even when the camera is outside the visible AU range.
   */
  private drawMiniMap(): void {
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

    // Orbit rings
    for (const body of snap.bodies) {
      if (body.isStar || body.au <= 0) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, body.au * AU_SCENE * scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.stroke();
    }

    // Body dots
    for (const body of snap.bodies) {
      const bx = cx + body.x * scale;
      const by = cy - body.y * scale;
      ctx.beginPath();
      ctx.arc(bx, by, body.isStar ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff';

      // Highlight selected bodies
      if (this.selectedNames.has(body.name)) {
        ctx.shadowColor = '#88ccff';
        ctx.shadowBlur = 6;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      if (!body.isStar && body.au <= OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), bx + 3.5, by - 2);
      }
    }

    // Camera position
    let camX = cx + snap.camera.x * scale;
    let camY = cy - snap.camera.y * scale;
    camX = Math.max(8, Math.min(W - 8, camX));
    camY = Math.max(8, Math.min(H - 8, camY));
    ctx.beginPath();
    ctx.arc(camX, camY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88';
    ctx.fill();
    ctx.strokeStyle = '#00cc66';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#00ff88';
    ctx.font = '7px monospace';
    ctx.fillText('CAM', camX + 4, camY + 3);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
