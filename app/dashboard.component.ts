import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy } from '@angular/core';
import { WebGl } from './webgl/webgl.service';
import * as THREE from 'three';

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

    .hud-hint {
      position: absolute;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      color: #fff;
      padding: 0.6rem 1.4rem;
      border-radius: 6px;
      font-size: 0.95rem;
      pointer-events: none;
      z-index: 100;
    }

    .planet-panel {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 240px;
      max-height: 80vh;
      background: rgba(0, 0, 0, 0.85);
      border: 2px solid rgba(255, 255, 255, 0.85);
      border-radius: 12px;
      overflow-y: auto;
      padding: 12px;
      z-index: 2000;
      scrollbar-width: thin;
    }

    .planet-card {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.4);
      border-radius: 8px;
      margin-bottom: 10px;
      padding: 12px 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
    }

    .planet-card:hover {
      background: rgba(255,255,255,0.18);
      border-color: white;
      transform: translateX(6px);
    }

    .planet-name {
      color: white;
      font-weight: 600;
      font-size: 1.1rem;
    }
  `],
  template: `
    <div id="content" (click)="onContentClick($event)">
      <span class="hud-hint">
        {{ webGl.controls?.locked
            ? 'FLIGHT MODE ACTIVE — ESC or Space to exit • WASD move • R/F up/down • Mouse to look'
            : 'Click anywhere in the 3D view or press Space to enter flight mode' }}
      </span>

      <!-- Planet Panel -->
      <div class="planet-panel">
        <div *ngFor="let planet of planets" 
             class="planet-card" 
             (click)="goToPlanet(planet, $event)">
          <div class="planet-name">{{ planet.name }}</div>
        </div>
      </div>
    </div>
  `
})
export class DashboardComponent implements AfterViewInit, OnDestroy {

  planets: any[] = [];

  constructor(
    public elementRef: ElementRef,
    public webGl: WebGl
  ) { }

  onContentClick(event: MouseEvent) {
    // Only trigger flight mode if click is NOT on the planet panel
    if ((event.target as HTMLElement).closest('.planet-panel')) {
      return;
    }

    if (!this.webGl.controls?.locked) {
      this.webGl.controls?.enterFlight();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    this.webGl.keyDown(event);
  }

  @HostListener('window:resize')
  onResize() {
    const container = this.elementRef.nativeElement.querySelector('#content');
    if (container) this.webGl.resize(container.clientHeight, container.clientWidth);
  }

  ngAfterViewInit() {
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

    setTimeout(() => this.loadPlanets(), 800);
  }

  private loadPlanets() {
    if (!this.webGl.star?.satellites) return;

    this.planets = this.webGl.star.satellites
      .filter((b: any) => b.name && b.name.toLowerCase() !== 'sun')
      .sort((a: any, b: any) => (a.config?.au || 0) - (b.config?.au || 0));
  }

  goToPlanet(planet: any, event: MouseEvent) {
    event.stopPropagation();   // ← This is critical

    if (!planet || !this.webGl.star || !this.webGl.camera) {
      console.warn('Cannot go to planet - system not ready');
      return;
    }

    // Force hierarchy update
    this.webGl.star.updateHierarchy(this.webGl.clock.elapsedTime * 1000);

    const targetGroup = (planet as any).orbitalGroup || planet.group;
    const planetPos = new THREE.Vector3();
    targetGroup.getWorldPosition(planetPos);

    console.log(`Going to planet: ${planet.name} at position`, planetPos);

    if (planetPos.length() < 100) {
      const au = planet.config?.au || 1.0;
      planetPos.set(au * 1496, 500, au * 900);
    }

    const offset = new THREE.Vector3(700, 650, 1250);
    const targetCamPos = planetPos.clone().add(offset);

    this.webGl.moveCameraTo(targetCamPos, 1500);

    setTimeout(() => {
      if (this.webGl.camera) {
        const lookTarget = planetPos.clone().multiplyScalar(0.3);
        this.webGl.camera.lookAt(lookTarget);
      }
    }, 950);
  }

  ngOnDestroy() {}
}
