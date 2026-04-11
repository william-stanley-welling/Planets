/**
 * @fileoverview Root dashboard component for the heliocentric simulation.
 *
 * Hosts the Three.js canvas, all HUD panels, and orchestrates:
 *  - Navigation mode radio bar (Discovery / Cinematic / Fastest Travel).
 *  - Planet list with single/multi-select (Ctrl+click) and fly-to navigation.
 *  - Ctrl+multiselect automatically reframes the camera to contain all bodies
 *    including their moons.
 *  - 3-D raycasting selection forwarded from canvas clicks.
 *  - Simulation-time and camera-speed sliders with preset buttons.
 *  - Orbit-line toggle controls with active-state styling.
 *  - "Moons of Selected" toggle with persistent ON/OFF status badge.
 *  - Fastest-Travel vessel HUD (fuel bar + waypoint queue stub).
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
import { CameraView, NavigationMode, SystemSnapshot, WebGl } from './webgl/webgl.service';
import { SIMULATION_CONSTANTS } from './galaxy/celestial.model';
import { Subscription } from 'rxjs';

@Component({
  selector: 'dashboard',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    /* ── base ──────────────────────────────────────────────────────────────── */
    #content { position: relative; width: 100%; height: 100vh; overflow: hidden; }

    .hud-hint {
      position: absolute; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.7); color: #ccc;
      padding: 0.5rem 1.2rem; border-radius: 6px;
      font-size: 0.85rem; pointer-events: none; z-index: 100; white-space: nowrap;
    }

    .info-panel {
      position: absolute; background: rgba(0,0,0,0.70);
      backdrop-filter: blur(4px); border-radius: 8px;
      padding: 8px 12px; font-family: monospace; font-size: 0.75rem;
      color: #ccddff; border: 1px solid rgba(255,255,255,0.2);
      z-index: 200; pointer-events: none;
    }
    .camera-info { top: 20px; left: 20px; }
    .date-info   { bottom: 20px; right: 20px; text-align: right; }

    /* ── selection bar ──────────────────────────────────────────────────────── */
    .selection-bar {
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,20,0.85); border: 1px solid rgba(80,140,255,0.5);
      border-radius: 6px; padding: 4px 14px; z-index: 210;
      color: #99ccff; font-family: monospace; font-size: 0.75rem;
      pointer-events: none; white-space: nowrap;
    }

    /* ── navigation mode bar ────────────────────────────────────────────────── */
    .nav-mode-bar {
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      margin-top: 28px; /* push below selection bar when visible */
      display: flex; gap: 0; z-index: 200; pointer-events: auto;
      background: rgba(0,0,0,0.75); border: 1px solid rgba(100,140,255,0.35);
      border-radius: 8px; overflow: hidden;
    }
    .nav-btn {
      background: transparent; border: none; border-right: 1px solid rgba(100,140,255,0.2);
      color: rgba(180,200,255,0.6); padding: 6px 16px;
      font-size: 0.72rem; cursor: pointer; letter-spacing: 0.04em;
      transition: background 0.15s, color 0.15s;
      display: flex; align-items: center; gap: 6px;
    }
    .nav-btn:last-child { border-right: none; }
    .nav-btn:hover { background: rgba(80,120,255,0.15); color: #ccddff; }
    .nav-btn.active {
      background: rgba(60,110,255,0.30);
      color: #ffffff;
      box-shadow: inset 0 -2px 0 #6699ff;
    }
    .nav-btn .mode-icon { font-size: 1rem; }

    /* ── sliders ────────────────────────────────────────────────────────────── */
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
    .preset-buttons { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
    .preset-buttons button {
      background: #223; border: none; color: #ccf;
      border-radius: 3px; padding: 2px 6px; font-size: 0.6rem; cursor: pointer;
    }
    .speed-value { font-size: 0.7rem; color: #ffaa66; }

    /* ── orbit controls ─────────────────────────────────────────────────────── */
    .orbit-controls {
      position: absolute; top: 60px; left: 20px;
      display: flex; align-items: center; gap: 6px; z-index: 200; pointer-events: auto;
    }
    .orbit-controls button {
      background: rgba(0,0,0,0.7); border: 1px solid #6699ff;
      color: #ccddff; border-radius: 4px; padding: 4px 10px;
      cursor: pointer; font-size: 0.7rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .orbit-controls button.active { background: rgba(60,110,255,0.28); border-color: #88aaff; color: #fff; }
    .status-badge {
      display: inline-block; margin-left: 5px; padding: 1px 5px;
      border-radius: 3px; font-size: 0.6rem; font-weight: 700;
      background: rgba(80,80,80,0.5); color: #aaa; vertical-align: middle;
      transition: background 0.2s, color 0.2s;
    }
    .status-badge.on { background: rgba(50,200,130,0.35); color: #44ffcc; }

    /* ── planet panel ───────────────────────────────────────────────────────── */
    .planet-panel {
      position: absolute; top: 100px; right: 20px;
      width: 220px; max-height: 70vh;
      background: rgba(0,0,0,0.82); border: 1px solid rgba(255,255,255,0.22);
      border-radius: 10px; overflow-y: auto; padding: 10px 8px; z-index: 200;
    }
    .planet-label          { color: rgba(255,255,255,0.45); font-size: 0.65rem; padding: 0 6px 4px; text-transform: uppercase; }
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

    /* ── fastest-travel vessel HUD ──────────────────────────────────────────── */
    .vessel-hud {
      position: absolute; bottom: 70px; right: 20px; width: 220px;
      background: rgba(0,0,0,0.78); border: 1px solid rgba(255,160,60,0.35);
      border-radius: 8px; padding: 10px 12px; z-index: 200; pointer-events: auto;
      font-family: monospace; font-size: 0.72rem; color: #ffcc88;
    }
    .vessel-title { font-size: 0.65rem; text-transform: uppercase; color: rgba(255,180,80,0.6); margin-bottom: 6px; }
    .fuel-bar-wrap { background: rgba(255,255,255,0.1); border-radius: 3px; height: 6px; margin: 4px 0 8px; overflow: hidden; }
    .fuel-bar      { height: 100%; border-radius: 3px; background: linear-gradient(90deg,#ff6020,#ffaa40); transition: width 0.3s; }
    .waypoints     { max-height: 60px; overflow-y: auto; font-size: 0.65rem; color: rgba(255,200,120,0.7); }
    .waypoint-item { padding: 1px 0; }
    .vessel-actions { display: flex; gap: 6px; margin-top: 8px; }
    .vessel-actions button {
      flex: 1; background: rgba(255,120,40,0.18); border: 1px solid rgba(255,120,40,0.4);
      color: #ffbb66; border-radius: 4px; padding: 3px 6px; font-size: 0.62rem; cursor: pointer;
    }
    .vessel-stub-notice { font-size: 0.6rem; color: rgba(255,150,60,0.5); margin-top: 6px; }

    /* ── minimap ─────────────────────────────────────────────────────────────── */
    .minimap-wrap  { position: absolute; bottom: 60px; left: 16px; z-index: 200; }
    .minimap-label { color: rgba(255,255,255,0.35); font-size: 0.6rem; margin-bottom: 3px; text-transform: uppercase; }
    canvas.minimap { border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; display: block; }
  `],
  template: `
    <div id="content"
         (click)="onContentClick($event)"
         (mousedown)="onCanvasMouseDown($event)">

      <!-- Flight hint -->
      <span class="hud-hint">
        {{ webGl.controls?.locked
            ? 'FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift = 10× · Mouse look'
            : 'Click viewport or Space to enter flight mode' }}
      </span>

      <!-- Camera diagnostics -->
      <div class="info-panel camera-info">
        <div>📍 POS: {{ cameraPos.x | number:'1.0-0' }}, {{ cameraPos.y | number:'1.0-0' }}, {{ cameraPos.z | number:'1.0-0' }}</div>
        <div>🔆 DIR: {{ cameraDir.x | number:'1.2-2' }}, {{ cameraDir.y | number:'1.2-2' }}, {{ cameraDir.z | number:'1.2-2' }}</div>
        <div>⚡ SPD: {{ cameraSpeed | number:'0.0-0' }} u/s</div>
      </div>

      <!-- Sim date -->
      <div class="info-panel date-info">
        <div>📅 SIM DATE: {{ simulationDate | date:'yyyy-MM-dd HH:mm:ss' }}</div>
        <div>⏱️ ΔT = {{ dateOffsetDays | number:'1.2-2' }} days</div>
        <div>⏩ SIM SPEED: {{ simSpeed | number:'1.1-1' }}x</div>
      </div>

      <!-- Selection bar -->
      <div class="selection-bar" *ngIf="selectedNames.size > 0">
        ✦ {{ selectedNamesDisplay }}
      </div>

      <!-- ── Navigation mode bar ─────────────────────────────────────────────
           Sits just below the selection bar; transforms to avoid overlap.
           Each button is a radio-style toggle that calls setNavigationMode.
      ─────────────────────────────────────────────────────────────────────── -->
      <div class="nav-mode-bar" [style.top]="selectedNames.size > 0 ? '52px' : '20px'">
        <button class="nav-btn"
                [class.active]="webGl.navMode === NavMode.DISCOVERY"
                title="Top-down discovery — see all orbits"
                (click)="setNavMode(NavMode.DISCOVERY)">
          <span class="mode-icon">🔭</span> Discovery
        </button>
        <button class="nav-btn"
                [class.active]="webGl.navMode === NavMode.CINEMATIC"
                title="Cinematic — geostationary orbital follow"
                (click)="setNavMode(NavMode.CINEMATIC)">
          <span class="mode-icon">🎬</span> Cinematic
        </button>
        <button class="nav-btn"
                [class.active]="webGl.navMode === NavMode.FASTEST_TRAVEL"
                title="Fastest Travel — propulsion vessel (experimental)"
                (click)="setNavMode(NavMode.FASTEST_TRAVEL)">
          <span class="mode-icon">🚀</span> Travel
        </button>
      </div>

      <!-- Sliders -->
      <div class="sliders-panel">
        
        <div class="slider-container">
          <div class="slider-label">SIM TIME</div>

          <input
            type="range"
            class="vertical"
            min="0"
            max="100"
            step="0.1"
            [value]="simSpeedSlider"
            (input)="onSimSpeedSlider($event)"
          >

          <div class="speed-value">
            {{ formatSpeed(simSpeed) }}
          </div>

          <div class="preset-buttons">
            <button (click)="setSimSpeed(0.25)">¼×</button>
            <button (click)="setSimSpeed(0.5)">½×</button>
            <button (click)="setSimSpeed(1)">1×</button>
            <button (click)="setSimSpeed(10)">10×</button>
            <button (click)="setSimSpeed(100)">100×</button>
            <button (click)="setSimSpeed(1000)">1K×</button>
            <button (click)="setSimSpeed(1000000)">1M×</button>
            <button (click)="setSimSpeed(1000000000)">1B×</button>
          </div>
        </div>

        <div class="slider-container">
          <div class="slider-label">CAM MOVE</div>
          <input type="range" class="vertical" min="0" max="100"
                 [value]="camSpeedSlider" (input)="onCamSpeedSlider($event)" orient="vertical">
          <div class="speed-value">{{ camBaseSpeed | number:'0.0-0' }} u/s</div>
          <div class="preset-buttons">
            <button (click)="setCamSpeed(0.01)">0.01x</button>
            <button (click)="setCamSpeed(0.1)">0.1x</button>
            <button (click)="setCamSpeed(0.5)">0.5x</button>
            <button (click)="setCamSpeed(1)">1x</button>
            <button (click)="setCamSpeed(2)">2x</button>
            <button (click)="setCamSpeed(4)">4x</button>
          </div>
        </div>
      </div>

      <!-- ── Orbit toggle controls ──────────────────────────────────────────── -->
      <div class="orbit-controls">
        <button [class.active]="webGl.showPlanetOrbits"
                (click)="webGl.togglePlanetOrbits(!webGl.showPlanetOrbits)">
          🌍 Planets
        </button>
        <button [class.active]="webGl.showMoonOrbits"
                (click)="webGl.toggleMoonOrbits(!webGl.showMoonOrbits)">
          🌙 Moons
        </button>
        <button [class.active]="webGl.showMoonsOfSelected"
                (click)="onToggleMoonsOfSelected()">
          🔘 Moons of Sel.
          <span class="status-badge" [class.on]="webGl.showMoonsOfSelected">
            {{ webGl.showMoonsOfSelected ? 'ON' : 'OFF' }}
          </span>
        </button>
      </div>

      <!-- Planet selector panel -->
      <div class="planet-panel">
        <div class="planet-label">Planets</div>
        <div class="planet-multiselect-hint">Ctrl+click → multi-select · camera reframes</div>
        <div *ngFor="let planet of planets"
             class="planet-card"
             [class.selected]="selectedNames.has(planet.name)"
             [style.border-left-color]="planet.config?.color || '#4488ff'"
             (click)="onPlanetCardClick(planet, $event)">
          <div>
            <div class="planet-name">{{ planet.name }}</div>
            <div class="planet-meta">{{ planet.config?.au | number:'1.2-2' }} AU</div>
          </div>
          <canvas [attr.data-planet]="planet.name" class="indicator-canvas" width="24" height="24"></canvas>
        </div>
      </div>

      <!-- ── Fastest-Travel vessel HUD ──────────────────────────────────────
           Shown only in FASTEST_TRAVEL mode.  All controls are stubs —
           the UI surface is ready for the propulsion engine to be wired in.
      ─────────────────────────────────────────────────────────────────────── -->
      <div class="vessel-hud" *ngIf="webGl.navMode === NavMode.FASTEST_TRAVEL">
        <div class="vessel-title">⚙ Propulsion Vessel</div>
        <div>Fuel: {{ webGl.vesselState.fuel | number:'1.0-0' }} / {{ webGl.vesselState.fuelCapacity }}</div>
        <div class="fuel-bar-wrap">
          <div class="fuel-bar" [style.width.%]="(webGl.vesselState.fuel / webGl.vesselState.fuelCapacity) * 100"></div>
        </div>
        <div>Δv Budget: {{ webGl.vesselState.deltaVBudget | number:'1.0-0' }}</div>
        <div style="margin-top:6px; font-size:0.65rem; color:rgba(255,200,120,0.6)">Waypoints:</div>
        <div class="waypoints">
          <div *ngFor="let wp of webGl.vesselState.waypoints; let i = index" class="waypoint-item">
            {{ i + 1 }}. {{ wp }}
          </div>
          <div *ngIf="webGl.vesselState.waypoints.length === 0" style="color:rgba(255,180,80,0.4)">
            — click planet to queue —
          </div>
        </div>
        <div class="vessel-actions">
          <button (click)="webGl.clearWaypoints()">Clear</button>
          <button [disabled]="webGl.vesselState.waypoints.length === 0"
                  title="Route planning not yet implemented"
                  style="opacity:0.55">Launch</button>
        </div>
        <div class="vessel-stub-notice">⚠ Propulsion physics stub — route planning TBD</div>
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

  // --- ADD THESE CONSTANTS ---
  private readonly MIN_SPEED = 0.25;
  private readonly MAX_SPEED = 1_000_000_000;

  private subscriptions = new Subscription();

  @ViewChild('minimap') minimapRef!: ElementRef<HTMLCanvasElement>;

  /** Expose enums to template. */
  readonly CameraView = CameraView;
  readonly NavMode = NavigationMode;

  planets: any[] = [];
  activeView: string | null = null;

  // Camera diagnostics
  cameraPos = { x: 0, y: 0, z: 0 };
  cameraDir = { x: 0, y: 0, z: 0 };
  cameraSpeed = 0;

  // Simulation date
  simulationDate = new Date();
  dateOffsetDays = 0;

  // Speed controls
  simSpeed = 1;
  camBaseSpeed = 3000;
  simSpeedSlider = 0;
  camSpeedSlider = 50;

  private speedUpdateTimeout: any;

  /** Mirror of `webGl.selectedNames` for template bindings. */
  selectedNames = new Set<string>();

  get selectedNamesDisplay(): string { return [...this.selectedNames].join(', '); }

  private minimapCtx!: CanvasRenderingContext2D;
  private minimapRaf = 0;
  private destroyed = false;
  private triangleIndicators = new Map<string, HTMLCanvasElement>();

  constructor(public elementRef: ElementRef, public webGl: WebGl) { }

  // ─── Host listeners ─────────────────────────────────────────────────────────

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void { this.webGl.keyDown(e); }

  @HostListener('window:resize')
  onResize(): void {
    const c = this.elementRef.nativeElement.querySelector('#content');
    if (c) this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

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

    this.webGl.onSelectionChanged = (names) => { this.selectedNames = new Set(names); };

    this.subscriptions.add(
      this.webGl.simulationTime$.subscribe(time => {
        this.simulationDate = new Date(time);
        this.dateOffsetDays = (time - Date.now()) / 86_400_000;
      }),
    );

    setTimeout(() => this.loadPlanetList(), 1200);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.minimapRaf);
    this.subscriptions.unsubscribe();
  }

  // ─── Canvas click handling ──────────────────────────────────────────────────

  onContentClick(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel, .nav-mode-bar, .vessel-hud'
    );
    if (isHud) return;
    if (!this.webGl.controls?.locked) this.webGl.controls?.enterFlight();
  }

  onCanvasMouseDown(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel, .nav-mode-bar, .vessel-hud'
    );
    if (isHud) return;
    if (this.webGl.controls?.locked) return;
    const multiselect = event.ctrlKey || event.metaKey;
    this.webGl.handleCanvasClick(event, multiselect);
    this.selectedNames = new Set(this.webGl.selectedNames);
  }

  // ─── Navigation mode ─────────────────────────────────────────────────────────

  /**
   * Delegates to `webGl.setNavigationMode`, which repositions the camera and
   * persists the choice to `localStorage`.
   *
   * @param {NavigationMode} mode - Target mode.
   */
  setNavMode(mode: NavigationMode): void {
    this.webGl.setNavigationMode(mode);
  }

  // ─── Planet panel ───────────────────────────────────────────────────────────

  onPlanetCardClick(planet: any, event: MouseEvent): void {
    event.stopPropagation();
    const multiselect = event.ctrlKey || event.metaKey;

    if (multiselect) {
      if (this.selectedNames.has(planet.name)) {
        this.selectedNames.delete(planet.name);
        this.webGl.selectedNames.delete(planet.name);
        this.webGl.setHighlight(planet.name, false);
      } else {
        this.selectedNames.add(planet.name);
        this.webGl.selectedNames.add(planet.name);
        this.webGl.setHighlight(planet.name, true);
      }
      // Notify service (refreshes moon highlights) then reframe camera.
      this.webGl.onSelectionChanged?.(new Set(this.selectedNames));
      this.webGl.navigateToSelection();
    } else {
      // Single select — fully delegates; navigateToPlanet includes moon framing.
      this.webGl.selectBodies([planet.name], true);
      this.selectedNames = new Set(this.webGl.selectedNames);
    }
  }

  // ─── Orbit / moon toggles ────────────────────────────────────────────────────

  onToggleMoonsOfSelected(): void {
    this.webGl.toggleShowMoonsOfSelected();
  }

  // ─── Simulation speed ───────────────────────────────────────────────────────

  // --- SET SPEED ---
  setSimSpeed(speed: number): void {
    const clamped = Math.min(this.MAX_SPEED, Math.max(this.MIN_SPEED, speed));

    this.simSpeed = clamped;

    // slider position (log scale)
    this.simSpeedSlider =
      Math.log(clamped / this.MIN_SPEED) /
      Math.log(this.MAX_SPEED / this.MIN_SPEED) * 100;

    this.sendSpeed(clamped);
  }

  // --- SLIDER INPUT ---
  onSimSpeedSlider(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.simSpeedSlider = val;

    const raw =
      this.MIN_SPEED *
      Math.pow(this.MAX_SPEED / this.MIN_SPEED, val / 100);

    const snapped = this.snapSpeed(raw);

    this.simSpeed = snapped;

    this.sendSpeed(snapped);
  }

  // --- SNAP TO NICE VALUES ---
  private snapSpeed(value: number): number {
    if (value < 1) {
      if (value < 0.375) return 0.25;
      if (value < 0.75) return 0.5;
      return 1;
    }

    const log = Math.log10(value);
    return Math.pow(10, Math.round(log));
  }

  // --- DEBOUNCED SEND ---
  private sendSpeed(speed: number): void {
    clearTimeout(this.speedUpdateTimeout);

    this.speedUpdateTimeout = setTimeout(() => {
      this.webGl.setSimulationSpeed(speed);
    }, 50);
  }

  // --- PRETTY LABEL ---
  formatSpeed(speed: number): string {
    if (speed < 1) return speed.toFixed(2) + 'x';
    if (speed < 1000) return speed.toFixed(0) + 'x';
    if (speed < 1_000_000) return (speed / 1000).toFixed(0) + 'Kx';
    if (speed < 1_000_000_000) return (speed / 1_000_000).toFixed(0) + 'Mx';
    return (speed / 1_000_000_000).toFixed(0) + 'Bx';
  }

  // ─── Camera speed ───────────────────────────────────────────────────────────

  setCamSpeed(multiplier: number): void {
    const newBase = Math.min(50_000, Math.max(3, 3000 * multiplier));
    this.webGl.setCameraBaseSpeed(newBase);
    this.camBaseSpeed = newBase;
    this.camSpeedSlider = Math.log(newBase / 3) / Math.log(50_000 / 3) * 100;
  }

  onCamSpeedSlider(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.camSpeedSlider = val;
    this.setCamSpeed(100 * Math.pow(50_000 / 100, val / 100) / 3000);
  }

  // ─── Private: planet list loading ───────────────────────────────────────────

  private loadPlanetList(): void {
    if (!this.webGl.star?.satellites?.length) { setTimeout(() => this.loadPlanetList(), 600); return; }
    this.planets = [...this.webGl.star.satellites]
      .filter((b: any) => b.name?.toLowerCase() !== 'sun')
      .sort((a: any, b: any) => (a.config?.au ?? 0) - (b.config?.au ?? 0));
    setTimeout(() => this.initTriangleIndicators(), 100);
  }

  private initTriangleIndicators(): void {
    document.querySelectorAll('.planet-card canvas.indicator-canvas').forEach(el => {
      const canvas = el as HTMLCanvasElement;
      const name = canvas.getAttribute('data-planet');
      if (name) this.triangleIndicators.set(name, canvas);
    });
  }

  private updateTriangleIndicators(): void {
    for (const [name, canvas] of this.triangleIndicators) {
      this.drawTriangle(canvas, this.webGl.getBodyPhaseAngle(name));
    }
  }

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

  private startInfoUpdate(): void {
    setInterval(() => {
      const info = this.webGl.getCameraInfo();
      this.cameraPos = info.position;
      this.cameraDir = info.direction;
      this.cameraSpeed = info.velocity;
      this.updateTriangleIndicators();
    }, 80);
  }

  // ─── Private: minimap ───────────────────────────────────────────────────────

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
      ctx.beginPath();
      ctx.arc(cx, cy, body.au * AU_SCENE * scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.stroke();
    }

    for (const body of snap.bodies) {
      const bx = cx + body.x * scale;
      const by = cy - body.y * scale;
      ctx.beginPath();
      ctx.arc(bx, by, body.isStar ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff';
      if (this.selectedNames.has(body.name)) { ctx.shadowColor = '#88ccff'; ctx.shadowBlur = 8; }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (!body.isStar && body.au <= OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), bx + 3.5, by - 2);
      }
    }

    let camX = Math.max(8, Math.min(W - 8, cx + snap.camera.x * scale));
    let camY = Math.max(8, Math.min(H - 8, cy - snap.camera.y * scale));
    ctx.beginPath();
    ctx.arc(camX, camY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88';
    ctx.fill();
    ctx.strokeStyle = '#00cc66'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#00ff88'; ctx.font = '7px monospace';
    ctx.fillText('CAM', camX + 4, camY + 3);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
