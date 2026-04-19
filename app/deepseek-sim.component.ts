import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  NgZone,
  inject,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as dat from 'dat.gui';

// ----------------------------------------------------------------------
// Types for the simulation
// ----------------------------------------------------------------------
interface SourceConfig {
  count: number;
  radius: number;
  wavelength: number;
  phaseOffset: number;
  amplitudes: number[];
  phases: number[];
  shape: 'circle' | 'mobius';
}

interface DiamondConfig {
  refractiveIndex: number;
  ablationThreshold: number;
  voxelResolution: number;
  voxelSize: number;
}

interface SimulationState {
  sources: SourceConfig;
  diamond: DiamondConfig;
  exposureTime: number;
  showIntensity: boolean;
  showTemperature: boolean;
  showVibration: boolean;
  showEtchedDiamond: boolean;
}

// ----------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------
@Component({
  selector: 'app-seepseek-sim',
  standalone: true,
  template: `
    <div #container style="width: 100%; height: 100vh; background: #000; overflow: hidden;"></div>
  `,
  styles: [`:host { display: block; width: 100%; height: 100vh; }`],
})
export class DeepSeekSIMComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animationFrameId = 0;
  private lastTime = 0;
  private readonly ngZone = inject(NgZone);

  // Simulation state
  private state: SimulationState;
  private diamondVoxels: Float32Array;          // refractive index delta
  private intensityField: Float32Array | null = null;
  private temperatureField: Float32Array | null = null;
  private vibrationField: Float32Array | null = null;

  // Three.js visual elements
  private intensityPlane!: THREE.Mesh;
  private diamondVolume!: THREE.Object3D;
  private sourceSpheres: THREE.Mesh[] = [];
  private fieldLines: THREE.Line[] = [];

  private gui!: dat.GUI;
  private gridSize: number;
  private voxelCount: number;

  constructor() {
    this.state = {
      sources: {
        count: 6,
        radius: 3.0,
        wavelength: 0.5,
        phaseOffset: 0,
        amplitudes: new Array(6).fill(1.0),
        phases: new Array(6).fill(0),
        shape: 'circle',
      },
      diamond: {
        refractiveIndex: 2.42,
        ablationThreshold: 2.5,
        voxelResolution: 48,
        voxelSize: 0.15,
      },
      exposureTime: 0,
      showIntensity: true,
      showTemperature: false,
      showVibration: false,
      showEtchedDiamond: true,
    };

    this.gridSize = this.state.diamond.voxelResolution;
    this.voxelCount = this.gridSize ** 3;
    this.diamondVoxels = new Float32Array(this.voxelCount);
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.initGUI();
    this.createVisualElements();
    this.recomputeFields();
    this.updateVisualisation();
    this.startAnimation();
  }

  // --------------------------------------------------------------------
  // Three.js setup
  // --------------------------------------------------------------------
  private initThree(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(8, 6, 12);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.containerRef.nativeElement.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const ambient = new THREE.AmbientLight(0x404060);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    this.scene.add(dirLight);
    const fillLight = new THREE.PointLight(0x446688, 0.5);
    fillLight.position.set(-5, 3, 5);
    this.scene.add(fillLight);

    this.scene.add(new THREE.AxesHelper(5));
    this.scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x444444));

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // --------------------------------------------------------------------
  // GUI controls
  // --------------------------------------------------------------------
  private initGUI(): void {
    this.gui = new dat.GUI();

    const srcFolder = this.gui.addFolder('Sources');
    srcFolder.add(this.state.sources, 'count', 2, 16, 1).name('n').onChange(() => this.reconfigureSources());
    srcFolder.add(this.state.sources, 'radius', 0.5, 8).name('Radius').onChange(() => this.recomputeFields());
    srcFolder.add(this.state.sources, 'wavelength', 0.1, 2.0).name('λ').onChange(() => this.recomputeFields());
    srcFolder.add(this.state.sources, 'phaseOffset', 0, 2 * Math.PI).name('Global phase').onChange(() => this.recomputeFields());
    srcFolder.add(this.state.sources, 'shape', ['circle', 'mobius']).name('Arrangement').onChange(() => this.reconfigureSources());
    srcFolder.open();

    const diamondFolder = this.gui.addFolder('Diamond');
    diamondFolder.add(this.state.diamond, 'refractiveIndex', 1.0, 3.5).name('n_d').onChange(() => this.recomputeFields());
    diamondFolder.add(this.state.diamond, 'ablationThreshold', 0.5, 10.0).name('Threshold').onChange(() => this.updateEtching());
    diamondFolder.add(this.state, 'exposureTime', 0, 20).name('Exposure').onChange(() => this.updateEtching());
    diamondFolder.open();

    const visFolder = this.gui.addFolder('Visualisation');
    visFolder.add(this.state, 'showIntensity').name('Intensity plane').onChange(() => this.updateVisualisation());
    visFolder.add(this.state, 'showTemperature').name('Temperature').onChange(() => this.updateVisualisation());
    visFolder.add(this.state, 'showVibration').name('Vibration').onChange(() => this.updateVisualisation());
    visFolder.add(this.state, 'showEtchedDiamond').name('Diamond voxels').onChange(() => this.updateVisualisation());
    visFolder.open();

    this.gui.add({ recompute: () => this.recomputeFields() }, 'recompute').name('Force Recompute');
    this.gui.add({ resetEtching: () => this.resetEtching() }, 'resetEtching').name('Reset Etching');
  }

  private reconfigureSources(): void {
    const n = this.state.sources.count;
    const oldAmps = this.state.sources.amplitudes;
    const oldPhases = this.state.sources.phases;
    this.state.sources.amplitudes = Array.from({ length: n }, (_, i) => oldAmps[i] ?? 1.0);
    this.state.sources.phases = Array.from({ length: n }, (_, i) => oldPhases[i] ?? 0.0);
    this.recomputeFields();
  }

  // --------------------------------------------------------------------
  // Visual elements creation
  // --------------------------------------------------------------------
  private createVisualElements(): void {
    const planeGeo = new THREE.PlaneGeometry(8, 8);
    const planeMat = new THREE.MeshPhongMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
      vertexColors: true,
    });
    this.intensityPlane = new THREE.Mesh(planeGeo, planeMat);
    this.intensityPlane.rotation.x = -Math.PI / 2;
    this.intensityPlane.position.y = -0.01;
    this.scene.add(this.intensityPlane);

    this.diamondVolume = new THREE.Group();
    this.scene.add(this.diamondVolume);

    this.updateSourceMarkers();
  }

  private updateSourceMarkers(): void {
    this.sourceSpheres.forEach(s => this.scene.remove(s));
    this.sourceSpheres = [];

    const positions = this.getSourcePositions();
    const sphereGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: new THREE.Color(0x442200) });
    positions.forEach(pos => {
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.copy(pos);
      this.scene.add(sphere);
      this.sourceSpheres.push(sphere);
    });
  }

  private getSourcePositions(): THREE.Vector3[] {
    const cfg = this.state.sources;
    const n = cfg.count;
    const R = cfg.radius;
    const positions: THREE.Vector3[] = [];

    if (cfg.shape === 'circle') {
      for (let k = 0; k < n; k++) {
        const theta = (2 * Math.PI * k) / n;
        positions.push(new THREE.Vector3(R * Math.cos(theta), 0, R * Math.sin(theta)));
      }
    } else {
      // Möbius strip placement (simplified)
      for (let k = 0; k < n; k++) {
        const u = (k / n) * 2 * Math.PI;
        const v = 0;
        const x = (R + v * Math.cos(u / 2)) * Math.cos(u);
        const y = v * Math.sin(u / 2);
        const z = (R + v * Math.cos(u / 2)) * Math.sin(u);
        positions.push(new THREE.Vector3(x, y, z));
      }
    }
    return positions;
  }

  // --------------------------------------------------------------------
  // Physics computation
  // --------------------------------------------------------------------
  private recomputeFields(): void {
    this.computeIntensityField();
    this.computeTemperatureField();
    this.computeVibrationField();
    this.updateEtching();
    this.updateVisualisation();
    this.updateSourceMarkers();
  }

  private computeIntensityField(): void {
    const res = this.gridSize;
    const voxelSize = this.state.diamond.voxelSize;
    const half = (res * voxelSize) / 2;
    const lambda = this.state.sources.wavelength;
    const k0 = (2 * Math.PI) / lambda;
    const n_d = this.state.diamond.refractiveIndex;
    const k = k0 * n_d;

    const sourcePositions = this.getSourcePositions();
    const amps = this.state.sources.amplitudes;
    const phases = this.state.sources.phases;
    const globalPhase = this.state.sources.phaseOffset;

    this.intensityField = new Float32Array(this.voxelCount);
    let index = 0;

    for (let iz = 0; iz < res; iz++) {
      const z = -half + iz * voxelSize;
      for (let iy = 0; iy < res; iy++) {
        const y = -half + iy * voxelSize;
        for (let ix = 0; ix < res; ix++) {
          const x = -half + ix * voxelSize;
          const point = new THREE.Vector3(x, y, z);

          let real = 0, imag = 0;
          for (let s = 0; s < sourcePositions.length; s++) {
            const src = sourcePositions[s];
            const dist = point.distanceTo(src);
            const phase = k * dist + phases[s] + globalPhase;
            const amp = amps[s] / (dist + 0.01);
            real += amp * Math.cos(phase);
            imag += amp * Math.sin(phase);
          }
          this.intensityField![index++] = real * real + imag * imag;
        }
      }
    }
  }

  private computeTemperatureField(): void {
    if (!this.intensityField) return;
    this.temperatureField = new Float32Array(this.voxelCount);
    const maxIntensity = Math.max(...this.intensityField);
    for (let i = 0; i < this.voxelCount; i++) {
      this.temperatureField[i] = Math.min(this.intensityField[i] / maxIntensity, 1.0);
    }
  }

  private computeVibrationField(): void {
    if (!this.intensityField) return;
    this.vibrationField = new Float32Array(this.voxelCount);
    const res = this.gridSize;
    const step = this.state.diamond.voxelSize;
    for (let iz = 1; iz < res - 1; iz++) {
      for (let iy = 1; iy < res - 1; iy++) {
        for (let ix = 1; ix < res - 1; ix++) {
          const idx = ix + iy * res + iz * res * res;
          const dx = this.intensityField![idx + 1] - this.intensityField![idx - 1];
          const dy = this.intensityField![idx + res] - this.intensityField![idx - res];
          const dz = this.intensityField![idx + res * res] - this.intensityField![idx - res * res];
          this.vibrationField[idx] = Math.sqrt(dx * dx + dy * dy + dz * dz) / (2 * step);
        }
      }
    }
    const maxVib = Math.max(...this.vibrationField);
    if (maxVib > 0) {
      for (let i = 0; i < this.voxelCount; i++) this.vibrationField[i] /= maxVib;
    }
  }

  private updateEtching(): void {
    if (!this.intensityField) return;
    const threshold = this.state.diamond.ablationThreshold;
    const exposure = this.state.exposureTime;
    for (let i = 0; i < this.voxelCount; i++) {
      const intensity = this.intensityField[i];
      if (intensity > threshold) {
        this.diamondVoxels[i] = Math.min(this.diamondVoxels[i] + intensity * 0.01 * exposure, 0.8);
      }
    }
  }

  private resetEtching(): void {
    this.diamondVoxels = new Float32Array(this.voxelCount);
    this.updateEtching();
    this.updateVisualisation();
  }

  // --------------------------------------------------------------------
  // Visualisation update
  // --------------------------------------------------------------------
  private updateVisualisation(): void {
    this.updateIntensityPlane();
    this.updateDiamondVolume();
    this.updateFieldLines();
  }

  private updateIntensityPlane(): void {
    if (!this.intensityField) return;
    this.intensityPlane.visible = this.state.showIntensity;

    const res = this.gridSize;
    const planeRes = 128;
    const planeGeo = new THREE.PlaneGeometry(8, 8, planeRes - 1, planeRes - 1);
    const posAttr = planeGeo.attributes.position as THREE.BufferAttribute;
    const colorAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 3), 3);

    const centerZ = Math.floor(res / 2);
    const step = 8 / planeRes;

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const ix = Math.floor(((x + 4) / 8) * res);
      const iy = Math.floor(((y + 4) / 8) * res);
      let idx = ix + iy * res + centerZ * res * res;
      idx = Math.min(idx, this.voxelCount - 1);
      const I = this.intensityField![idx];
      const t = Math.min(I / 5.0, 1.0);

      let r, g, b;
      if (t < 0.33) {
        const s = t / 0.33;
        r = 0; g = s; b = 1;
      } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        r = s; g = 1; b = 1 - s;
      } else {
        const s = (t - 0.66) / 0.34;
        r = 1; g = 1 - s; b = 0;
      }
      colorAttr.setXYZ(i, r, g, b);
    }
    planeGeo.setAttribute('color', colorAttr);
    this.intensityPlane.geometry.dispose();
    this.intensityPlane.geometry = planeGeo;
  }

  private updateDiamondVolume(): void {
    while (this.diamondVolume.children.length) {
      this.diamondVolume.remove(this.diamondVolume.children[0]);
    }
    if (!this.state.showEtchedDiamond) {
      this.diamondVolume.visible = false;
      return;
    }
    this.diamondVolume.visible = true;

    const res = this.gridSize;
    const voxelSize = this.state.diamond.voxelSize;
    const offset = (res * voxelSize) / 2;

    const cubeGeo = new THREE.BoxGeometry(voxelSize * 0.9, voxelSize * 0.9, voxelSize * 0.9);
    const baseMat = new THREE.MeshPhongMaterial({ color: 0x88aaff, transparent: true });

    let index = 0;
    for (let iz = 0; iz < res; iz++) {
      for (let iy = 0; iy < res; iy++) {
        for (let ix = 0; ix < res; ix++) {
          const delta = this.diamondVoxels[index];
          if (delta > 0.01) {
            const material = baseMat.clone();
            material.opacity = delta * 0.9;
            material.color.setHSL(0.6 + delta * 0.2, 0.8, 0.5);
            const cube = new THREE.Mesh(cubeGeo, material);
            cube.position.set(
              ix * voxelSize - offset,
              iy * voxelSize - offset,
              iz * voxelSize - offset
            );
            this.diamondVolume.add(cube);
          }
          index++;
        }
      }
    }
  }

  private updateFieldLines(): void {
    this.fieldLines.forEach(l => this.scene.remove(l));
    this.fieldLines = [];

    const srcPos = this.getSourcePositions();
    const center = new THREE.Vector3(0, 0, 0);
    srcPos.forEach(pos => {
      const points = [pos.clone(), center.clone()];
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color: 0xffaa00 });
      const line = new THREE.Line(geo, mat);
      this.scene.add(line);
      this.fieldLines.push(line);
    });
  }

  // --------------------------------------------------------------------
  // Animation loop
  // --------------------------------------------------------------------
  private startAnimation(): void {
    this.ngZone.runOutsideAngular(() => {
      const animate = (now: number) => {
        this.animationFrameId = requestAnimationFrame(animate);
        const delta = (now - this.lastTime) / 1000;
        this.lastTime = now;

        // Optional: uncomment to animate global phase
        // this.state.sources.phaseOffset += delta * 0.5;
        // this.recomputeFields();

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      };
      this.lastTime = performance.now();
      animate(this.lastTime);
    });
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.controls.dispose();
    this.renderer.dispose();
    this.gui.destroy();
  }
}
