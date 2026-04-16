import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { SIMULATION_CONSTANTS } from './galaxy/celestial.model';
import { CameraView, NavigationMode, WebGl } from './webgl/webgl.service';

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
    .camera-info { bottom: 142px; right: 20px; }
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
      position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
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
      background: rgba(60,110,255,0.30); color: #ffffff;
      box-shadow: inset 0 -2px 0 #6699ff;
    }
    .nav-btn .mode-icon { font-size: 1rem; }

    /* ── sliders ────────────────────────────────────────────────────────────── */
    .sliders-panel {
      position: absolute; top: 60px; left: 20px;
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
    .speed-value { font-size: 0.7rem; color: #ffaa66; }

    /* ── orbit controls ─────────────────────────────────────────────────────── */
    .orbit-controls {
      position: absolute; top: 20px; left: 20px;
      display: flex; align-items: center; gap: 6px; z-index: 200; pointer-events: auto;
    }
    .orbit-controls button {
      background: rgba(0,0,0,0.7); border: 1px solid #6699ff;
      color: #ccddff; border-radius: 4px; padding: 4px 10px;
      cursor: pointer; font-size: 0.72rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .orbit-controls button:hover { background: rgba(60,100,255,0.2); }
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
      position: absolute; top: 60px; right: 20px;
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
    .planet-card.waypoint { border-color: rgba(0,255,200,0.5); background: rgba(0,255,200,0.06); }
    .planet-name { color: #e8eeff; font-size: 0.9rem; font-weight: 600; }
    .planet-meta { color: rgba(255,255,255,0.4); font-size: 0.7rem; margin-top: 2px; }
    .indicator-canvas { width: 24px; height: 24px; margin-left: 8px; flex-shrink: 0; }

    /* ── navigation panel ───────────────────────────────────────────────────── */
    .nav-panel {
      position: absolute; top: 60px; right: 250px; width: 240px;
      background: rgba(0,5,20,0.88);
      border: 1px solid rgba(0,255,200,0.30);
      border-radius: 10px; padding: 12px 14px; z-index: 200; pointer-events: auto;
      font-family: monospace; font-size: 0.72rem; color: #99ffee;
    }
    .nav-panel-title {
      font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(0,255,200,0.7); margin-bottom: 8px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .nav-panel-hint { font-size: 0.6rem; color: rgba(0,200,160,0.5); margin-bottom: 8px; }

    .waypoint-list { max-height: 130px; overflow-y: auto; margin-bottom: 8px; }
    .waypoint-item {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 0; border-bottom: 1px solid rgba(0,200,160,0.1);
      font-size: 0.65rem; color: rgba(180,255,240,0.85);
    }
    .waypoint-item:last-child { border-bottom: none; }
    .waypoint-num { color: rgba(0,200,160,0.6); min-width: 14px; }
    .waypoint-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .waypoint-dur {
      background: rgba(0,0,0,0.4); border: 1px solid rgba(0,200,160,0.3);
      color: #99ffee; width: 38px; font-size: 0.6rem; border-radius: 3px;
      padding: 1px 3px; text-align: center;
    }
    .wp-remove {
      background: none; border: none; color: rgba(255,80,80,0.6);
      cursor: pointer; font-size: 0.7rem; padding: 0 2px; line-height: 1;
    }
    .wp-remove:hover { color: #ff5555; }
    .wp-empty { color: rgba(0,200,160,0.35); font-size: 0.62rem; text-align: center; padding: 6px 0; }

    .nav-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .nav-btn-sm {
      flex: 1; background: rgba(0,255,200,0.10);
      border: 1px solid rgba(0,255,200,0.30);
      color: #66ffdd; border-radius: 5px;
      padding: 4px 6px; font-size: 0.62rem; cursor: pointer;
      transition: background 0.15s;
      display: flex; align-items: center; justify-content: center; gap: 3px;
    }
    .nav-btn-sm:hover { background: rgba(0,255,200,0.20); }
    .nav-btn-sm.active { background: rgba(0,255,200,0.25); border-color: #00ffcc; color: #fff; }
    .nav-btn-sm.engage {
      background: rgba(0,200,120,0.20); border-color: rgba(0,255,160,0.5); color: #00ffaa;
    }
    .nav-btn-sm.engage:hover { background: rgba(0,200,120,0.35); }
    .nav-btn-sm.disengage {
      background: rgba(200,60,60,0.22); border-color: rgba(255,80,80,0.5); color: #ff8888;
    }
    .nav-btn-sm.disengage:hover { background: rgba(200,60,60,0.4); }
    .nav-btn-sm:disabled { opacity: 0.35; cursor: not-allowed; }

    .nav-status {
      margin-top: 6px; font-size: 0.6rem; color: rgba(0,255,200,0.5);
      min-height: 14px; text-align: center;
    }
    .nav-status.active { color: #00ffaa; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.55; } }

    .latency-gauge {
      display: flex; align-items: center; gap: 8px; margin-top: 4px;
    }
    .latency-bar {
      height: 4px; width: 60px; border-radius: 2px;
      transition: width 0.2s, background 0.2s;
    }

    /* ── minimap ─────────────────────────────────────────────────────────────── */
    .minimap-wrap  { position: absolute; bottom: 20px; left: 20px; z-index: 200; }
    .minimap-label { color: rgba(255,255,255,0.35); font-size: 0.6rem; margin-bottom: 3px; text-transform: uppercase; }
    canvas.minimap {
      border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; display: block;
      cursor: crosshair;
    }
    .minimap-hint { color: rgba(0,200,160,0.45); font-size: 0.55rem; margin-top: 2px; }

    /* ── loader overlay ───────────────────────────────────────────── */
    .loader-overlay {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 2, 18, 0.92);
      backdrop-filter: blur(6px);
      z-index: 4000;
      display: flex;
      justify-content: center;
      align-items: center;
      animation: loader-fade-in 0.3s ease;
    }
    @keyframes loader-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    .loader-overlay.fade-out {
      animation: loader-fade-out 0.6s ease forwards;
      pointer-events: none;
    }
    @keyframes loader-fade-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }

    .loader-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2rem;
    }

    /* ── orrery animation ───────── */
    .loader-orrery {
      position: relative;
      width: 140px;
      height: 140px;
    }

    .loader-star-core {
      position: absolute;
      top: 50%; left: 50%;
      width: 14px; height: 14px;
      margin: -7px 0 0 -7px;
      border-radius: 50%;
      background: radial-gradient(circle, #fff8c0 0%, #ffcc44 55%, #ff8800 100%);
      box-shadow:
        0 0 10px 4px rgba(255, 200, 50, 0.7),
        0 0 28px 8px rgba(255, 140, 0, 0.4);
      animation: star-pulse 2.4s ease-in-out infinite;
      z-index: 2;
    }
    @keyframes star-pulse {
      0%, 100% {
        box-shadow:
          0 0 10px 4px rgba(255, 200, 50, 0.7),
          0 0 28px 8px rgba(255, 140, 0, 0.4);
      }
      50% {
        box-shadow:
          0 0 16px 7px rgba(255, 220, 80, 0.95),
          0 0 44px 14px rgba(255, 150, 0, 0.6);
      }
    }

    .orbit-track {
      position: absolute;
      top: 50%; left: 50%;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.07);
      transform: translate(-50%, -50%);
    }

    .orbit-arm {
      position: absolute;
      top: 50%; left: 50%;
      width: 0; height: 0;
      transform-origin: 0 0;
    }

    .orbit-planet {
      position: absolute;
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }

    /* Ring 1 – innermost, fast */
    .orbit-arm-1 { animation: spin-cw 1.4s linear infinite; }
    .orbit-track-1 { width: 52px; height: 52px; }
    .orbit-planet-1 {
      width: 6px; height: 6px;
      top: -26px; left: 0;
      background: #5bc8ff;
      box-shadow: 0 0 5px 2px rgba(91,200,255,0.6);
    }

    /* Ring 2 – mid, medium */
    .orbit-arm-2 { animation: spin-ccw 2.2s linear infinite; }
    .orbit-track-2 { width: 84px; height: 84px; }
    .orbit-planet-2 {
      width: 7px; height: 7px;
      top: -42px; left: 0;
      background: #44ffcc;
      box-shadow: 0 0 6px 2px rgba(68,255,204,0.65);
    }

    /* Ring 3 – outer, slow */
    .orbit-arm-3 { animation: spin-cw 3.6s linear infinite; }
    .orbit-track-3 { width: 120px; height: 120px; }
    .orbit-planet-3 {
      width: 9px; height: 9px;
      top: -60px; left: 0;
      background: #ffaa44;
      box-shadow: 0 0 8px 3px rgba(255,170,68,0.6);
    }

    @keyframes spin-cw  { to { transform: rotate(360deg);  } }
    @keyframes spin-ccw { to { transform: rotate(-360deg); } }

    /* ── loader text ─────────────────────────────────────────────────────────── */
    .loader-label {
      font-family: monospace;
      font-size: 0.65rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(100, 200, 255, 0.5);
      margin-bottom: 0.2rem;
    }

    .loader-stage {
      font-family: monospace;
      font-size: 0.82rem;
      letter-spacing: 0.06em;
      color: #a0d8ff;
      text-align: center;
      min-height: 1.2em;
      animation: text-flicker 3s ease-in-out infinite;
    }
    @keyframes text-flicker {
      0%, 90%, 100% { opacity: 1; }
      95%            { opacity: 0.6; }
    }

    .loader-bar-wrap {
      width: 200px;
      height: 2px;
      background: rgba(255,255,255,0.08);
      border-radius: 2px;
      overflow: hidden;
    }
    .loader-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #1a6aff, #00ffcc, #1a6aff);
      background-size: 200% 100%;
      animation: bar-sweep 1.6s linear infinite;
      border-radius: 2px;
    }
    @keyframes bar-sweep {
      0%   { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
  `],
  template: `
    <!-- ── Futuristic loading overlay ───────────────────────────────────────── -->
    <div class="loader-overlay" *ngIf="isLoading" [class.fade-out]="fadingOut">
      <div class="loader-card">

        <!-- Orrery animation -->
        <div class="loader-orrery">
          <div class="loader-star-core"></div>

          <div class="orbit-track orbit-track-1"></div>
          <div class="orbit-track orbit-track-2"></div>
          <div class="orbit-track orbit-track-3"></div>

          <div class="orbit-arm orbit-arm-1">
            <div class="orbit-planet orbit-planet-1"></div>
          </div>
          <div class="orbit-arm orbit-arm-2">
            <div class="orbit-planet orbit-planet-2"></div>
          </div>
          <div class="orbit-arm orbit-arm-3">
            <div class="orbit-planet orbit-planet-3"></div>
          </div>
        </div>

        <!-- Progress text -->
        <div>
          <div class="loader-label">Initialising Heliosphere</div>
          <div class="loader-stage">{{ loadingStage }}</div>
        </div>

        <!-- Scanning bar -->
        <div class="loader-bar-wrap">
          <div class="loader-bar-fill"></div>
        </div>

      </div>
    </div>

    <div id="content"
         (click)="onContentClick($event)"
         (mousedown)="onCanvasMouseDown($event)">

      <!-- Flight hint -->
      <span class="hud-hint">
        {{ webGl.navRoute.active
            ? '🛸 ROUTE ACTIVE — ESC to disengage · Mouse to look around'
            : webGl.controls?.locked
              ? '🚀 FLIGHT — ESC/Space exit · WASD move · R/F up/down · Shift=10× · Mouse look'
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
        <div>📅 SIM DATE: {{ webGl.simulationDate | date:'yyyy-MM-dd HH:mm:ss' }}</div>
        <div>⏳ ΔT = {{ dateOffsetDays | number:'1.2-2' }} days</div>
        <div>⏩ SIM SPEED: {{ simSpeed | number:'1.1-1' }}×</div>
        <div class="latency-gauge">
          <span>🕒 Latency:</span>
          <span class="latency-value">{{ latencyMs | number:'1.0-0' }} ms</span>
          <div class="latency-bar"
               [style.width.%]="(latencyMs / maxLatencyMs) * 100"
               [style.background]="latencyMs < 100 ? '#4caf50' : (latencyMs < 300 ? '#ff9800' : '#f44336')">
          </div>
        </div>
      </div>

      <!-- Selection bar – hierarchical order -->
      <div class="selection-bar" *ngIf="selectedNames.size > 0">
        ✦ {{ selectionHierarchyDisplay }}
      </div>

      <!-- Navigation mode bar -->
      <div class="nav-mode-bar">
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
                title="Navigation — plan and fly custom routes"
                (click)="setNavMode(NavMode.FASTEST_TRAVEL)">
          <span class="mode-icon">🧭</span> Navigate
        </button>
      </div>

      <!-- Sliders -->
      <div class="sliders-panel">
        <div class="slider-container">
          <div class="slider-label">🕰 SIM TIME</div>
          <input type="range" class="vertical" min="0" max="100" step="0.01"
                 [value]="simSpeedSlider" (input)="onSimSpeedSlider($event)">
          <div class="speed-value">{{ formatSpeed(simSpeed) }}</div>
        </div>
        <div class="slider-container">
          <div class="slider-label">⚡ SPEED</div>
          <input type="range" class="vertical" min="0" max="100"
                 [value]="camSpeedSlider" (input)="onCamSpeedSlider($event)" orient="vertical">
          <div class="speed-value">{{ camBaseSpeed | number:'0.0-0' }} u/s</div>
        </div>
      </div>

      <!-- Orbit toggle controls -->
      <div class="orbit-controls">
        <button (click)="resetSimulation()" title="Reset simulation to current real time">
          🔄 Reset Time
        </button>
        <button [class.active]="webGl.showPlanetOrbits"
                (click)="webGl.toggleShowPlanetOrbits()">
          🌍 Planets
        </button>
        <button [class.active]="webGl.showMoonOrbits"
                (click)="webGl.toggleShowMoonOrbits()">
          🌙 Moons
        </button>
        <button [class.active]="webGl.showCometOrbits"
                (click)="webGl.toggleShowCometOrbits()">
          ☄️ Comets
        </button>
        <button [class.active]="webGl.graphMode"
                (click)="webGl.toggleGraphMode()">
          🔲 Graph
          <span class="status-badge" [class.on]="webGl.graphMode">
            {{ webGl.graphMode ? 'ON' : 'OFF' }}
          </span>
        </button>
        <button [class.active]="webGl.spectroscopyMode"
                (click)="webGl.toggleSpectroscopyMode()">
          📡 Spectroscopy
          <span class="status-badge" [class.on]="webGl.spectroscopyMode">
            {{ webGl.spectroscopyMode ? 'ON' : 'OFF' }}
          </span>
        </button>
        <button [class.active]="webGl.showCoordinateGrids"
                (click)="webGl.toggleShowCoordinateGrids()">
          🌐 Coordinates Grid
          <span class="status-badge" [class.on]="webGl.showCoordinateGrids">
            {{ webGl.showCoordinateGrids ? 'ON' : 'OFF' }}
          </span>
        </button>
        <button [class.active]="webGl.showMagneticFields"
                (click)="webGl.toggleShowMagneticFields()">
          🧲 Fields
          <span class="status-badge" [class.on]="webGl.showMagneticFields">
            {{ webGl.showMagneticFields ? 'ON' : 'OFF' }}
          </span>
        </button>
        <button class="nav-btn-sm"
                [class.active]="webGl.verifyMode"
                (click)="webGl.toggleVerifyMode()">
          🔭 Verify
          <span class="status-badge" [class.on]="webGl.verifyMode">
            {{ webGl.verifyMode ? 'ON' : 'OFF' }}
          </span>
        </button>
        <button (click)="jumpToRandomStar()" title="Travel to a random new star system">
          🚀 Jump
        </button>
        <button (click)="toggleMenu()" title="Toggle menu">
          🟰 Menu
        </button>
      </div>

      <!-- Planet selector panel -->
      <div class="planet-panel">
        <div class="planet-label">🪐 Celestial Bodies</div>
        <div class="planet-multiselect-hint">
          {{ webGl.navMode === NavMode.FASTEST_TRAVEL
              ? '🧭 Click to add waypoint'
              : 'Ctrl+click → multi-select · camera reframes' }}
        </div>
        <div *ngFor="let planet of planets"
             class="planet-card"
             [class.selected]="selectedNames.has(planet.name) && webGl.navMode !== NavMode.FASTEST_TRAVEL"
             [class.waypoint]="isWaypoint(planet.name)"
             [style.border-left-color]="planet.config?.color || '#4488ff'"
             (click)="onPlanetCardClick(planet, $event)">
          <div>
            <div class="planet-name">{{ planet.name }}</div>
            <div class="planet-meta">{{ planet.config?.au | number:'1.2-2' }} AU</div>
          </div>
          <canvas [attr.data-planet]="planet.name" class="indicator-canvas" width="24" height="24"></canvas>
        </div>
      </div>

      <!-- ── Navigation Route Panel (FASTEST_TRAVEL mode) ─────────────────── -->
      <div class="nav-panel" *ngIf="webGl.navMode === NavMode.FASTEST_TRAVEL">

        <div class="nav-panel-title">
          <span>🧭 Navigation Route</span>
          <span style="font-size:0.55rem; opacity:0.5">{{ webGl.navRoute.waypoints.length }} pts</span>
        </div>

        <div class="nav-panel-hint">
          🌍 Click planet panel to add body waypoint<br>
          🗺 Click minimap to add coordinate waypoint
        </div>

        <!-- Waypoint list -->
        <div class="waypoint-list">
          <div *ngIf="webGl.navRoute.waypoints.length === 0" class="wp-empty">
            — no waypoints — add via planet panel or minimap —
          </div>
          <div *ngFor="let wp of webGl.navRoute.waypoints; let i = index" class="waypoint-item">
            <span class="waypoint-num">{{ i + 1 }}.</span>
            <span class="waypoint-label" [title]="wp.label || wp.bodyName || 'Point'">
              {{ wp.type === 'body' ? '🌍' : '📍' }} {{ wp.label || wp.bodyName }}
            </span>
            <input class="waypoint-dur" type="number" min="0" max="3600"
                   [value]="wp.durationSec"
                   (change)="onWpDurationChange(i, $event)"
                   title="Duration at waypoint (seconds)">s
            <button class="wp-remove" (click)="removeWaypoint(i)" title="Remove waypoint">✕</button>
          </div>
        </div>

        <!-- Route actions -->
        <div class="nav-actions">
          <button class="nav-btn-sm" [class.active]="webGl.navRoute.loop"
                  (click)="toggleNavLoop()"
                  title="Loop route — return to start after last waypoint">
            🔁 Circuit
          </button>
          <button class="nav-btn-sm" (click)="clearNavWaypoints()"
                  [disabled]="webGl.navRoute.waypoints.length === 0"
                  title="Clear all waypoints">
            🗑 Clear
          </button>
        </div>

        <div class="nav-actions" style="margin-top:6px">
          <button *ngIf="!webGl.navRoute.active"
                  class="nav-btn-sm engage"
                  [disabled]="webGl.navRoute.waypoints.length === 0"
                  (click)="engageRoute()"
                  title="Engage route — camera flies autonomously">
            🚀 Engage Route
          </button>
          <button *ngIf="webGl.navRoute.active"
                  class="nav-btn-sm disengage"
                  (click)="disengageRoute()"
                  title="Disengage — stop autonomous flight (also ESC)">
            ⏹ Disengage
          </button>
        </div>

        <!-- Status line -->
        <div class="nav-status" [class.active]="webGl.navRoute.active">
          <ng-container *ngIf="webGl.navRoute.active">
            ▶ WP {{ webGl.navRoute.currentIndex + 1 }}/{{ webGl.navRoute.waypoints.length }}
            <ng-container *ngIf="webGl.navRoute.orbitRemaining > 0">
              · 🛸 orbiting {{ webGl.navRoute.orbitRemaining | number:'1.0-0' }}s
            </ng-container>
          </ng-container>
          <ng-container *ngIf="!webGl.navRoute.active && webGl.navRoute.waypoints.length > 0">
            Ready — {{ webGl.navRoute.waypoints.length }} waypoint{{ webGl.navRoute.waypoints.length > 1 ? 's' : '' }}
          </ng-container>
        </div>
      </div>

      <!-- Minimap -->
      <div class="minimap-wrap">
        <div class="minimap-label">🌌 Solar System</div>
        <canvas #minimap class="minimap" width="200" height="200"
                (click)="onMinimapClick($event)"></canvas>
        <div class="minimap-hint" *ngIf="webGl.navMode === NavMode.FASTEST_TRAVEL">
          Click to add coordinate waypoint
        </div>
      </div>
    </div>
  `,
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  private readonly MIN_SPEED = 0.25;
  private readonly MAX_SPEED = 1_000_000_000_000;

  private subscriptions = new Subscription();

  @ViewChild('minimap') minimapRef!: ElementRef<HTMLCanvasElement>;

  readonly CameraView = CameraView;
  readonly NavMode = NavigationMode;

  planets: any[] = [];
  activeView: string | null = null;

  // ── Loader state ──────────────────────────────────────────────────────────
  isLoading = true;
  fadingOut = false;
  loadingStage = 'Connecting to server…';
  // ─────────────────────────────────────────────────────────────────────────

  cameraPos = { x: 0, y: 0, z: 0 };
  cameraDir = { x: 0, y: 0, z: 0 };
  cameraSpeed = 0;

  get simulationDate(): Date { return this.webGl.simulationDate; }
  dateOffsetDays = 0;

  simSpeed = 1;
  camBaseSpeed = 3000;
  simSpeedSlider = 0;
  camSpeedSlider = 50;

  latencyMs = 0;
  maxLatencyMs = 500;

  private speedUpdateTimeout: any;

  selectedNames = new Set<string>();

  get selectionHierarchyDisplay(): string {
    return this.webGl.getSelectionHierarchyLabels?.()?.join('  ·  ')
      || [...this.selectedNames].join(', ');
  }

  private minimapCtx!: CanvasRenderingContext2D;
  private minimapRaf = 0;
  private destroyed = false;
  private triangleIndicators = new Map<string, HTMLCanvasElement>();

  private selectionRectActive = false;
  private selectionStart = { x: 0, y: 0 };
  private rectDiv: HTMLDivElement | null = null;

  readonly wpDefaultDuration = 10;

  private showNavbar: BehaviorSubject<boolean>;

  constructor(
    public elementRef: ElementRef,
    public webGl: WebGl,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {
    this.showNavbar = new BehaviorSubject<boolean>(false);
  }

  toggleMenu(): void {
    this.showNavbar.next(!this.showNavbar.getValue());
  }

  listenToShowNavbar(): Observable<boolean> {
    return this.showNavbar
      .asObservable();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void { this.webGl.keyDown(e); }

  @HostListener('contextmenu', ['$event'])
  onContextMenu(e: Event): void { e.preventDefault(); }

  @HostListener('window:resize')
  onResize(): void {
    const c = this.elementRef.nativeElement.querySelector('#content');
    if (c) this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  @HostListener('wheel', ['$event'])
  onMouseWheel(event: WheelEvent): void {
    if (this.webGl.controls?.locked) {
      event.preventDefault();
      const direction = Math.sign(event.deltaY) * -1;
      this.handleSpeedScroll(direction);
    }
  }

  jumpToRandomStar(): void {
    this.isLoading = true;
    this.fadingOut = false;
    this.loadingStage = 'Preparing jump…';
    this.cdr.markForCheck();

    this.webGl.jumpToRandomStar();
  }

  private handleSpeedScroll(direction: number): void {
    const step = 2.0;
    const nextVal = Math.min(100, Math.max(0, this.camSpeedSlider + (direction * step)));

    if (nextVal !== this.camSpeedSlider) {
      this.camSpeedSlider = nextVal;

      const multiplier = (100 * Math.pow(50000 / 100, nextVal / 100)) / 3000;

      const newBase = Math.min(50000, Math.max(3, 3000 * multiplier));
      this.webGl.setCameraBaseSpeed(newBase);
      this.camBaseSpeed = newBase;
    }
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

    this.webGl.onSelectionChanged = (names) => { this.selectedNames = new Set(names); };

    this.subscriptions.add(
      this.webGl.simulationTime$.subscribe(time => {
        this.dateOffsetDays = (time - Date.now()) / 86_400_000;
      }),
    );

    this.subscriptions.add(
      this.webGl.loadingStage$.subscribe(stage => {
        this.zone.run(() => {
          this.loadingStage = stage;
          this.cdr.markForCheck();
        });
      }),
    );

    this.subscriptions.add(
      this.webGl.ready$.subscribe(() => {
        this.zone.run(() => {
          this.populatePlanetList();

          Promise.resolve().then(() => {
            this.initTriangleIndicators();
            this.fadingOut = true;
            setTimeout(() => {
              this.isLoading = false;
              this.fadingOut = false;
              this.cdr.markForCheck();
            }, 620);
            this.cdr.markForCheck();
          });
        });
      }),
    );
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.minimapRaf);
    this.subscriptions.unsubscribe();
  }

  onContentClick(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel, .nav-mode-bar, .nav-panel'
    );
    if (isHud) return;
    if (!this.webGl.controls?.locked) this.webGl.controls?.enterFlight();
  }

  onCanvasMouseDown(event: MouseEvent): void {
    const isHud = (event.target as HTMLElement).closest(
      '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel, .nav-mode-bar, .nav-panel'
    );
    if (isHud) return;

    if (event.button === 2) {
      event.preventDefault();
      const rect = this.webGl.getRenderer().domElement.getBoundingClientRect();
      this.selectionStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.selectionRectActive = true;
      this.createRectDiv();
      window.addEventListener('mousemove', this.onSelectionMouseMove);
      window.addEventListener('mouseup', this.onSelectionMouseUp);
      return;
    }

    if (this.webGl.controls?.locked) return;
    const multiselect = event.ctrlKey || event.metaKey;
    this.webGl.handleCanvasClick(event, multiselect);
    this.selectedNames = new Set(this.webGl.selectedNames);
  }

  private onSelectionMouseMove = (e: MouseEvent): void => {
    if (!this.selectionRectActive) return;
    const rect = this.webGl.getRenderer().domElement.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;
    const left = Math.min(this.selectionStart.x, currentX);
    const top = Math.min(this.selectionStart.y, currentY);
    if (this.rectDiv) {
      this.rectDiv.style.left = left + 'px';
      this.rectDiv.style.top = top + 'px';
      this.rectDiv.style.width = Math.abs(currentX - this.selectionStart.x) + 'px';
      this.rectDiv.style.height = Math.abs(currentY - this.selectionStart.y) + 'px';
      this.rectDiv.style.display = 'block';
    }
  };

  private onSelectionMouseUp = (e: MouseEvent): void => {
    if (!this.selectionRectActive) return;
    e.preventDefault();
    const rect = this.webGl.getRenderer().domElement.getBoundingClientRect();
    const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.webGl.selectInRect(
      { x: this.selectionStart.x, y: this.selectionStart.y },
      { x: end.x, y: end.y },
      e.ctrlKey,
    );
    this.selectedNames = new Set(this.webGl.selectedNames);
    this.selectionRectActive = false;
    if (this.rectDiv) this.rectDiv.style.display = 'none';
    window.removeEventListener('mousemove', this.onSelectionMouseMove);
    window.removeEventListener('mouseup', this.onSelectionMouseUp);
  };

  private createRectDiv(): void {
    if (this.rectDiv) return;
    this.rectDiv = document.createElement('div');
    this.rectDiv.style.position = 'absolute';
    this.rectDiv.style.border = '1px dashed #00ffcc';
    this.rectDiv.style.backgroundColor = 'rgba(0,255,200,0.08)';
    this.rectDiv.style.pointerEvents = 'none';
    this.rectDiv.style.display = 'none';
    this.rectDiv.style.zIndex = '300';
    this.elementRef.nativeElement.querySelector('#content').appendChild(this.rectDiv);
  }

  onMinimapClick(event: MouseEvent): void {
    if (this.webGl.navMode !== NavigationMode.FASTEST_TRAVEL) return;
    event.stopPropagation();
    const canvas = this.minimapRef.nativeElement;
    const r = canvas.getBoundingClientRect();
    const px = event.clientX - r.left;
    const py = event.clientY - r.top;
    const W = 200, H = 200, cx = W / 2, cy = H / 2;
    const AU_SCENE = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const OUTER_AU = 30.5;
    const scale = (W * 0.45) / (OUTER_AU * AU_SCENE);
    const worldX = (px - cx) / scale;
    const worldY = -(py - cy) / scale;
    this.webGl.addNavWaypointCoordinate(worldX, worldY, this.wpDefaultDuration);
  }

  setNavMode(mode: NavigationMode): void {
    this.webGl.setNavigationMode(mode);
  }

  onPlanetCardClick(planet: any, event: MouseEvent): void {
    event.stopPropagation();

    if (this.webGl.navMode === NavigationMode.FASTEST_TRAVEL) {
      this.webGl.addNavWaypointBody(planet.name, this.wpDefaultDuration);
      return;
    }

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
      this.webGl.onSelectionChanged?.(new Set(this.selectedNames));
      this.webGl.navigateToSelection();
    } else {
      this.webGl.selectBodies([planet.name], true);
      this.selectedNames = new Set(this.webGl.selectedNames);
    }
  }

  isWaypoint(name: string): boolean {
    return this.webGl.navRoute.waypoints.some(w => w.type === 'body' && w.bodyName === name);
  }

  removeWaypoint(index: number): void { this.webGl.removeNavWaypoint(index); }
  clearNavWaypoints(): void { this.webGl.clearNavWaypoints(); }
  toggleNavLoop(): void { this.webGl.setNavRouteLoop(!this.webGl.navRoute.loop); }
  engageRoute(): void { this.webGl.engageNavRoute(); }
  disengageRoute(): void { this.webGl.disengageNavRoute(); }

  onWpDurationChange(index: number, event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!isNaN(val) && val >= 0) this.webGl.updateNavWaypointDuration(index, val);
  }

  setSimSpeed(speed: number): void {
    const clamped = Math.min(this.MAX_SPEED, Math.max(this.MIN_SPEED, speed));
    this.simSpeed = clamped;
    this.simSpeedSlider = Math.log(clamped / this.MIN_SPEED) / Math.log(this.MAX_SPEED / this.MIN_SPEED) * 100;
    this.sendSpeed(clamped);
  }

  onSimSpeedSlider(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.simSpeedSlider = val;
    const raw = this.MIN_SPEED * Math.pow(this.MAX_SPEED / this.MIN_SPEED, val / 100);
    const snapped = this.snapSpeed(raw);
    this.simSpeed = snapped;
    this.sendSpeed(snapped);
  }

  private snapSpeed(value: number): number {
    if (value < 1) {
      if (value < 0.375) return 0.25;
      if (value < 0.75) return 0.5;
      return 1;
    }
    return Math.pow(10, Math.round(Math.log10(value)));
  }

  private sendSpeed(speed: number): void {
    clearTimeout(this.speedUpdateTimeout);
    this.speedUpdateTimeout = setTimeout(() => { this.webGl.setSimulationSpeed(speed); }, 50);
  }

  formatSpeed(speed: number): string {
    if (speed < 1) return speed.toFixed(2) + '×';
    if (speed < 1000) return speed.toFixed(0) + '×';
    if (speed < 1_000_000) return (speed / 1000).toFixed(0) + 'K×';
    if (speed < 1_000_000_000) return (speed / 1_000_000).toFixed(0) + 'M×';
    return (speed / 1_000_000_000).toFixed(0) + 'B×';
  }

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

  resetSimulation(): void {
    this.webGl.resetSimulation();
    this.setSimSpeed(1);
    this.simSpeedSlider = 0;
    this.camSpeedSlider = 50;
    this.setCamSpeed(1);
    this.dateOffsetDays = 0;
  }

  private populatePlanetList(): void {
    if (!this.webGl.star?.satellites?.length) return;
    this.planets = [this.webGl.star, ...this.webGl.star.satellites]
      .sort((a: any, b: any) => (a.config?.au ?? 0) - (b.config?.au ?? 0));
  }

  private initTriangleIndicators(): void {
    this.triangleIndicators.clear();
    this.elementRef.nativeElement
      .querySelectorAll('.planet-card canvas.indicator-canvas')
      .forEach((el: Element) => {
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
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = this.webGl.navMode === NavigationMode.FASTEST_TRAVEL ? '#00ffcc' : '#ffaa44';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angleRad) * 10, cy + Math.sin(angleRad) * 10);
    ctx.lineTo(cx + Math.cos(angleRad + 2.0) * 6, cy + Math.sin(angleRad + 2.0) * 6);
    ctx.lineTo(cx + Math.cos(angleRad - 2.0) * 6, cy + Math.sin(angleRad - 2.0) * 6);
    ctx.fill();
  }

  private startInfoUpdate(): void {
    setInterval(() => {
      const info = this.webGl.getCameraInfo();
      this.latencyMs = Math.abs(Date.now() - this.webGl.simulationTime);
      this.cameraPos = info.position;
      this.cameraDir = info.direction;
      this.cameraSpeed = info.velocity;
      this.updateTriangleIndicators();
    }, 80);
  }

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
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.stroke();
    }

    if (this.webGl.navMode === NavigationMode.FASTEST_TRAVEL && this.webGl.navRoute.waypoints.length > 0) {
      this.drawNavPathOnMinimap(ctx, cx, cy, scale);
    }

    for (const body of snap.bodies) {
      const bx = cx + body.x * scale;
      const by = cy - body.y * scale;
      ctx.beginPath();
      ctx.arc(bx, by, body.isStar ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff';
      if (this.selectedNames.has(body.name)) { ctx.shadowColor = '#88ccff'; ctx.shadowBlur = 8; }
      if (this.isWaypoint(body.name)) { ctx.shadowColor = '#00ffcc'; ctx.shadowBlur = 10; }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (!body.isStar && body.au <= OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), bx + 3.5, by - 2);
      }
    }

    const camX = Math.max(8, Math.min(W - 8, cx + snap.camera.x * scale));
    const camY = Math.max(8, Math.min(H - 8, cy - snap.camera.y * scale));
    const camAngle = this.webGl.getCameraAzimuth();
    ctx.save();
    ctx.translate(camX, camY);
    ctx.rotate(camAngle);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-4, 5);
    ctx.lineTo(4, 5);
    ctx.fillStyle = this.webGl.navRoute.active ? '#00ffaa' : '#00ff88';
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#00ff88';
    ctx.font = '7px monospace';
    ctx.fillText('CAM', camX + 8, camY + 4);
  }

  private drawNavPathOnMinimap(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number,
  ): void {
    const wps = this.webGl.navRoute.waypoints;
    const snap = this.webGl.getSystemSnapshot();
    const camX = cx + snap.camera.x * scale;
    const camY = cy - snap.camera.y * scale;

    const points: { x: number; y: number }[] = [{ x: camX, y: camY }];

    for (const wp of wps) {
      if (wp.type === 'body' && wp.bodyName) {
        const body = snap.bodies.find(b => b.name === wp.bodyName);
        if (body) points.push({ x: cx + body.x * scale, y: cy - body.y * scale });
      } else if (wp.type === 'coordinate' && wp.position) {
        points.push({ x: cx + wp.position.x * scale, y: cy - wp.position.y * scale });
      }
    }

    if (this.webGl.navRoute.loop && points.length > 2) points.push(points[1]);

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(0,255,200,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (points.length > 0) {
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 1; i < points.length; i++) {
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = i - 1 === this.webGl.navRoute.currentIndex && this.webGl.navRoute.active
        ? '#00ffaa' : 'rgba(0,255,200,0.6)';
      ctx.fill();
      ctx.fillStyle = 'rgba(0,255,200,0.8)';
      ctx.font = '6px monospace';
      ctx.fillText(String(i), points[i].x + 4, points[i].y - 2);
    }
    ctx.restore();
  }
}
