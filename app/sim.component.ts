import { Component, ElementRef, AfterViewInit, OnDestroy, ViewChild, NgZone, inject } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Full standalone Angular component that renders the exact Structured Interference Manifold
 * from your videos + all requested features (fixed rays, vibrating/rotating Möbius manifolds,
 * binary ray grid, substrate memory, recursive nesting, silicon-nitride look, etc.).
 *
 * Updated per your request: exampleGrid now uses true/false booleans.
 *
 * Just drop this single file into your Angular 17+ project (standalone).
 * Run: npm install three @types/three
 * Then add <app-interference-manifold></app-interference-manifold> anywhere.
 */

export interface ManifoldConfig {
  symmetryFolds: number;
  recursiveDescent: number;
  shapeType: 'hexagonal' | 'mobius' | 'spiral';
  vibrationFrequency: number;
  vibrationAmplitude: number;
  rotationSpeed: number;
  uniformDisplacement: number;
  scale: number;
  siliconNitrideColor: number;
  intensityMapResolution: number;
}

export interface RaySource {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  active: boolean;
  intensity: number;
}

export class StructuredInterferenceManifold {
  private scene: THREE.Scene;
  private config: ManifoldConfig;
  private cube!: THREE.Mesh;
  private substrate!: THREE.Mesh;
  private substrateMaterial!: THREE.MeshPhongMaterial;
  private mesh2D!: THREE.Group;
  private mesh3D!: THREE.Mesh;
  private orbitingParticle!: THREE.Mesh;
  private raySources: RaySource[] = [];
  private activeRayLines: THREE.Line[] = [];
  private rayMaxBounces = 4;
  private interferenceCache = new Map<string, THREE.CanvasTexture>();
  private children: StructuredInterferenceManifold[] = [];
  public gridPosition = new THREE.Vector3();

  constructor(scene: THREE.Scene, config: ManifoldConfig, parentPosition = new THREE.Vector3()) {
    this.scene = scene;
    this.config = { ...config };
    this.gridPosition.copy(parentPosition);
    this.initCube();
    this.initSubstrate();
    this.init2DBlueprint();
    this.init3DManifold();
    this.initRaySourceGrid();
    if (this.config.recursiveDescent > 0) this.createNestedChildren();
    const offset = this.config.uniformDisplacement * 2;
    this.mesh2D.position.set(this.gridPosition.x, this.gridPosition.y - 3.5, this.gridPosition.z);
    this.mesh3D.position.set(this.gridPosition.x + offset, this.gridPosition.y, this.gridPosition.z);
  }

  private initCube(): void {
    const geometry = new THREE.BoxGeometry(12, 12, 12);
    const material = new THREE.MeshPhongMaterial({ color: 0x222222, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false });
    this.cube = new THREE.Mesh(geometry, material);
    this.scene.add(this.cube);
  }

  private initSubstrate(): void {
    const geo = new THREE.PlaneGeometry(9, 9);
    this.substrateMaterial = new THREE.MeshPhongMaterial({
      color: this.config.siliconNitrideColor,
      shininess: 80,
      specular: 0x333333,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    this.substrate = new THREE.Mesh(geo, this.substrateMaterial);
    this.substrate.rotation.x = -Math.PI / 2;
    this.substrate.position.set(this.gridPosition.x, this.gridPosition.y - 4.8, this.gridPosition.z);
    this.scene.add(this.substrate);
    const light = new THREE.PointLight(0xffffff, 1.2, 20);
    light.position.set(this.gridPosition.x, this.gridPosition.y - 3, this.gridPosition.z);
    this.scene.add(light);
  }

  private init2DBlueprint(): void {
    this.mesh2D = new THREE.Group();
    const hexPoints: THREE.Vector3[] = [];
    const radius = 4;
    for (let i = 0; i <= this.config.symmetryFolds; i++) {
      const a = (i * Math.PI * 2) / this.config.symmetryFolds;
      hexPoints.push(new THREE.Vector3(Math.cos(a) * radius, 0.01, Math.sin(a) * radius));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(hexPoints);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 4 });
    this.mesh2D.add(new THREE.Line(lineGeo, lineMat));

    if (this.config.shapeType === 'hexagonal' || this.config.shapeType === 'mobius') {
      const triMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide });
      for (let i = 0; i < 3; i++) {
        const triPoints = [
          new THREE.Vector3(0, 0.02, 0),
          new THREE.Vector3(Math.cos((i * Math.PI * 2) / 3 + Math.PI / 6) * 2.2, 0.02, Math.sin((i * Math.PI * 2) / 3 + Math.PI / 6) * 2.2),
          new THREE.Vector3(Math.cos((i * Math.PI * 2) / 3 - Math.PI / 6) * 2.2, 0.02, Math.sin((i * Math.PI * 2) / 3 - Math.PI / 6) * 2.2),
        ];
        const triGeo = new THREE.BufferGeometry().setFromPoints(triPoints);
        this.mesh2D.add(new THREE.Mesh(triGeo, triMat));
      }
    }

    const centerGeo = new THREE.SphereGeometry(0.12, 32, 32);
    const centerMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const center = new THREE.Mesh(centerGeo, centerMat);
    center.position.set(0, 0.05, 0);
    this.mesh2D.add(center);

    const particleGeo = new THREE.SphereGeometry(0.08, 32, 32);
    const particleMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    this.orbitingParticle = new THREE.Mesh(particleGeo, particleMat);
    this.mesh2D.add(this.orbitingParticle);

    this.scene.add(this.mesh2D);
  }

  private init3DManifold(): void {
    let geometry: THREE.BufferGeometry;
    if (this.config.shapeType === 'mobius') {
      geometry = this.createMobiusGeometry();
    } else if (this.config.shapeType === 'spiral') {
      geometry = new THREE.PlaneGeometry(7, 7, 96, 96);
    } else {
      geometry = new THREE.PlaneGeometry(7, 7, 128, 128);
    }
    const material = new THREE.MeshPhongMaterial({
      color: this.config.siliconNitrideColor,
      shininess: 120,
      specular: 0x888888,
      side: THREE.DoubleSide,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
    });
    this.mesh3D = new THREE.Mesh(geometry, material);
    this.mesh3D.castShadow = true;
    this.mesh3D.receiveShadow = true;
    this.scene.add(this.mesh3D);
  }

  private createMobiusGeometry(): THREE.BufferGeometry {
    const segmentsU = 128, segmentsV = 32, radius = 2.8, width = 1.2;
    const vertices: number[] = [], indices: number[] = [], colors: number[] = [];
    for (let u = 0; u <= segmentsU; u++) {
      const theta = (u / segmentsU) * Math.PI * 2;
      for (let v = 0; v <= segmentsV; v++) {
        const w = (v / segmentsV - 0.5) * width;
        const x = (radius + w * Math.cos(theta / 2)) * Math.cos(theta);
        const y = w * Math.sin(theta / 2);
        const z = (radius + w * Math.cos(theta / 2)) * Math.sin(theta);
        vertices.push(x, y, z);
        const intensity = Math.sin(theta * 3 + w * 5) * 0.5 + 0.5;
        colors.push(1, intensity * 0.6 + 0.4, intensity * 0.8);
      }
    }
    for (let u = 0; u < segmentsU; u++) {
      for (let v = 0; v < segmentsV; v++) {
        const i0 = u * (segmentsV + 1) + v;
        const i1 = i0 + 1;
        const i2 = (u + 1) * (segmentsV + 1) + v;
        const i3 = i2 + 1;
        indices.push(i0, i1, i2, i1, i3, i2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  private initRaySourceGrid(): void {
    const gridSize = 5, spacing = 1.8;
    this.raySources = [];
    for (let x = 0; x < gridSize; x++) {
      for (let y = 0; y < gridSize; y++) {
        const pos = new THREE.Vector3(
          this.gridPosition.x + (x - gridSize / 2) * spacing,
          this.gridPosition.y - 4.5,
          this.gridPosition.z + (y - gridSize / 2) * spacing
        );
        this.raySources.push({ position: pos, direction: new THREE.Vector3(0, 1, 0).normalize(), active: false, intensity: 1 });
      }
    }
  }

  public setInputGrid(grid: boolean[][]): void {
    let idx = 0;
    for (let x = 0; x < grid.length; x++) {
      for (let y = 0; y < grid[x].length; y++) {
        this.raySources[idx].active = grid[x][y];
        this.raySources[idx].intensity = grid[x][y] ? 1 : 0;
        idx++;
      }
    }
    this.storeInterferencePattern();
  }

  private getInputHash(): string {
    return this.raySources.map(r => (r.active ? '1' : '0')).join('');
  }

  private storeInterferencePattern(): void {
    const hash = this.getInputHash();
    if (this.interferenceCache.has(hash)) {
      this.substrateMaterial.map = this.interferenceCache.get(hash)!;
      this.substrateMaterial.needsUpdate = true;
      return;
    }
    const res = this.config.intensityMapResolution;
    const canvas = document.createElement('canvas');
    canvas.width = res; canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#112233'; ctx.fillRect(0, 0, res, res);
    const activeCount = this.raySources.filter(r => r.active).length;
    ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 3;
    for (let i = 1; i <= activeCount; i++) {
      ctx.beginPath();
      ctx.arc(res / 2, res / 2, (res / 2) * (i / (activeCount + 1)), 0, Math.PI * 2);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    this.interferenceCache.set(hash, texture);
    this.substrateMaterial.map = texture;
    this.substrateMaterial.needsUpdate = true;
  }

  private createNestedChildren(): void {
    const childConfig = { ...this.config };
    childConfig.scale *= 0.4;
    childConfig.recursiveDescent--;
    childConfig.uniformDisplacement = 0;
    for (let i = 0; i < this.config.symmetryFolds; i++) {
      const angle = (i * Math.PI * 2) / this.config.symmetryFolds;
      const childPos = new THREE.Vector3(Math.cos(angle) * 1.8, 0.5, Math.sin(angle) * 1.8);
      const child = new StructuredInterferenceManifold(this.scene, childConfig, childPos);
      this.children.push(child);
    }
  }

  public update(time: number, delta: number): void {
    const orbitR = 2.8;
    const orbitSpeed = this.config.symmetryFolds * 1.2;
    this.orbitingParticle.position.x = Math.cos(time * orbitSpeed) * orbitR;
    this.orbitingParticle.position.z = Math.sin(time * orbitSpeed) * orbitR;

    this.mesh3D.rotation.y = time * this.config.rotationSpeed;

    const posAttr = this.mesh3D.geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = this.mesh3D.geometry.attributes.color as THREE.BufferAttribute | undefined;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const wave = Math.sin(time * this.config.vibrationFrequency + x * 4 + z * 4) * this.config.vibrationAmplitude;
      posAttr.setY(i, wave);
      if (colorAttr) {
        const intensity = (wave + this.config.vibrationAmplitude) / (this.config.vibrationAmplitude * 2);
        colorAttr.setXYZ(i, 1, intensity * 0.7, intensity * 0.3);
      }
    }
    posAttr.needsUpdate = true;
    if (colorAttr) colorAttr.needsUpdate = true;
    this.mesh3D.geometry.computeVertexNormals();

    this.activeRayLines.forEach(line => this.scene.remove(line));
    this.activeRayLines = [];
    for (const source of this.raySources) {
      if (!source.active) continue;
      let pos = source.position.clone();
      let dir = source.direction.clone().normalize();
      const points: THREE.Vector3[] = [pos.clone()];
      for (let bounce = 0; bounce < this.rayMaxBounces; bounce++) {
        const raycaster = new THREE.Raycaster(pos, dir, 0.01, 20);
        const intersects = raycaster.intersectObject(this.mesh3D, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          points.push(hit.point);
          const normal = hit.face!.normal.clone().applyQuaternion(this.mesh3D.quaternion);
          dir = dir.sub(normal.multiplyScalar(2 * dir.dot(normal))).normalize();
          pos = hit.point.clone().add(dir.clone().multiplyScalar(0.02));
        } else {
          points.push(pos.clone().add(dir.clone().multiplyScalar(12)));
          break;
        }
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 5, transparent: true, opacity: source.intensity * 0.9 });
      const line = new THREE.Line(lineGeo, lineMat);
      this.scene.add(line);
      this.activeRayLines.push(line);
    }

    this.children.forEach(child => child.update(time, delta));
    const spread = this.config.uniformDisplacement * 3;
    this.mesh3D.position.x = this.gridPosition.x + spread * Math.sin(time * 0.3);
  }

  public setGridPosition(x: number, z: number): void {
    this.gridPosition.set(x, 0, z);
    this.mesh2D.position.set(x, -3.5, z);
    this.mesh3D.position.set(x, 0, z);
    this.substrate.position.set(x, -4.8, z);
  }

  public dispose(): void {
    this.scene.remove(this.cube, this.substrate, this.mesh2D, this.mesh3D);
    this.activeRayLines.forEach(l => this.scene.remove(l));
    this.children.forEach(c => c.dispose());
  }
}

@Component({
  selector: 'app-sim',
  standalone: true,
  template: `
    <div #container style="width: 100%; height: 100vh; background: #000; overflow: hidden;"></div>
  `,
  styles: [`:host { display: block; width: 100%; height: 100vh; }`]
})
export class SIMComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private manifold!: StructuredInterferenceManifold;
  private animationFrameId = 0;
  private lastTime = 0;

  private readonly ngZone = inject(NgZone);

  ngAfterViewInit(): void {
    this.initThree();
    this.createManifold();
    this.startAnimation();
  }

  private initThree(): void {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 8, 18);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.containerRef.nativeElement.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private createManifold(): void {
    const masterConfig: ManifoldConfig = {
      symmetryFolds: 6,
      recursiveDescent: 2,
      shapeType: 'mobius',
      vibrationFrequency: 8,
      vibrationAmplitude: 0.35,
      rotationSpeed: 0.8,
      uniformDisplacement: 0.6,
      scale: 1,
      siliconNitrideColor: 0xaaaaaa,
      intensityMapResolution: 512,
    };

    this.manifold = new StructuredInterferenceManifold(this.scene, masterConfig);

    // Example binary input grid (true/false = ON/OFF laser sources)
    const exampleGrid: boolean[][] = [
      [true, false, true, false, true],
      [false, true, false, true, false],
      [true, true, false, false, true],
      [false, false, true, true, false],
      [true, false, false, true, true],
    ];
    this.manifold.setInputGrid(exampleGrid);
  }

  private startAnimation(): void {
    this.ngZone.runOutsideAngular(() => {
      const animate = (now: number) => {
        this.animationFrameId = requestAnimationFrame(animate);
        const delta = (now - this.lastTime) / 1000;
        this.lastTime = now;

        if (this.manifold) this.manifold.update(now / 1000, delta);
        if (this.controls) this.controls.update();
        if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
      };
      this.lastTime = performance.now();
      animate(this.lastTime);
    });
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.manifold) this.manifold.dispose();
    if (this.controls) this.controls.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.containerRef.nativeElement.removeChild(this.renderer.domElement);
    }
  }
}
