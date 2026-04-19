import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  NgZone,
  inject,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ─── Configuration Types ──────────────────────────────────────────────────────

export interface SourceConfig {
  count: number;
  radius: number;
  wavelength: number;
  globalPhase: number;
  arrangement: 'circle' | 'mobius' | 'spiral';
  amplitudes: number[];
  phases: number[];
}

export interface DiamondConfig {
  refractiveIndex: number;
  ablationThreshold: number;
  exposureTime: number;
}

export interface ManifoldConfig {
  type: 'flat' | 'mobius' | 'hexagonal';
  symmetryFolds: number;
  vibrationFrequency: number;
  vibrationAmplitude: number;
  rotationSpeed: number;
}

export interface VisualConfig {
  showIntensityPlane: boolean;
  showRayTraces: boolean;
  showFieldLines: boolean;
  showDiamondVoxels: boolean;
  showManifold: boolean;
  rayMaxBounces: number;
}

export interface SimStats {
  fps: number;
  peakIntensity: number;
  etchedVoxels: number;
  activeRays: number;
}

// ─── Simulation Engine ────────────────────────────────────────────────────────

class DiamondWaveguideEngine {
  private scene: THREE.Scene;
  private voxelGridSize = 40;
  private worldExtent = 10;

  // Scene objects
  private manifoldMesh: THREE.Mesh | null = null;
  private sourceMeshes: THREE.Mesh[] = [];
  private sourceRings: THREE.Mesh[] = [];
  private sourcePointLights: THREE.PointLight[] = [];
  private rayLines: THREE.Line[] = [];
  private fieldLines: THREE.Line[] = [];
  private groundPlane: THREE.Mesh | null = null;
  private focalSphere: THREE.Mesh | null = null;
  private focalLight: THREE.PointLight | null = null;
  private diamondInstancedMesh: THREE.InstancedMesh | null = null;
  private manifoldVertexBase: Float32Array | null = null;

  // Fields
  private intensityField2D: Float32Array | null = null;
  private diamondVoxels: Float32Array;
  private groundCanvas: HTMLCanvasElement;
  private groundTexture: THREE.CanvasTexture | null = null;

  // Stats
  public peakIntensity = 0;
  public etchedVoxels = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.diamondVoxels = new Float32Array(this.voxelGridSize ** 3);
    this.groundCanvas = document.createElement('canvas');
    this.groundCanvas.width = 512;
    this.groundCanvas.height = 512;
    this.initLighting();
    this.initGroundPlane();
    this.initFocalSphere();
    this.initDiamondVoxelMesh();
  }

  // ── Scene Initialization ────────────────────────────────────────────────────

  private initLighting(): void {
    const ambient = new THREE.AmbientLight(0x020a18, 3);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0x6699ff, 1.0);
    key.position.set(12, 18, 8);
    key.castShadow = true;
    this.scene.add(key);

    const fill = new THREE.PointLight(0x001144, 2, 40);
    fill.position.set(-10, 6, -10);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0x004488, 0.4);
    rim.position.set(-5, -5, 10);
    this.scene.add(rim);
  }

  private initGroundPlane(): void {
    const ctx = this.groundCanvas.getContext('2d')!;
    const s = 512;
    ctx.fillStyle = '#010c1a';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i <= 16; i++) {
      ctx.strokeStyle = 'rgba(0,180,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(i * s / 16, 0); ctx.lineTo(i * s / 16, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s / 16); ctx.lineTo(s, i * s / 16); ctx.stroke();
    }

    this.groundTexture = new THREE.CanvasTexture(this.groundCanvas);
    const geo = new THREE.PlaneGeometry(20, 20);
    const mat = new THREE.MeshPhongMaterial({
      map: this.groundTexture,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
    });
    this.groundPlane = new THREE.Mesh(geo, mat);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.position.y = -5.2;
    this.scene.add(this.groundPlane);
  }

  private initFocalSphere(): void {
    const geo = new THREE.SphereGeometry(0.22, 32, 32);
    const mat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x00d4ff,
      emissiveIntensity: 4,
      transparent: true,
      opacity: 0.9,
    });
    this.focalSphere = new THREE.Mesh(geo, mat);
    this.focalSphere.position.set(0, 0, 0);
    this.scene.add(this.focalSphere);

    this.focalLight = new THREE.PointLight(0x00d4ff, 3, 10);
    this.focalSphere.add(this.focalLight);
  }

  private initDiamondVoxelMesh(): void {
    const n = this.voxelGridSize;
    const voxelSize = (this.worldExtent * 2) / n;
    const geo = new THREE.BoxGeometry(voxelSize * 0.85, voxelSize * 0.85, voxelSize * 0.85);
    const mat = new THREE.MeshPhongMaterial({
      color: 0x88aaff,
      emissive: 0x002266,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.7,
      shininess: 200,
    });
    this.diamondInstancedMesh = new THREE.InstancedMesh(geo, mat, n ** 3);
    this.diamondInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.diamondInstancedMesh.count = 0;
    this.diamondInstancedMesh.castShadow = false;
    this.scene.add(this.diamondInstancedMesh);
  }

  // ── Source Positions ────────────────────────────────────────────────────────

  getSourcePositions(cfg: SourceConfig): THREE.Vector3[] {
    const { count: n, radius: R, arrangement } = cfg;
    const positions: THREE.Vector3[] = [];

    if (arrangement === 'circle') {
      for (let k = 0; k < n; k++) {
        const theta = (2 * Math.PI * k) / n;
        positions.push(new THREE.Vector3(R * Math.cos(theta), 0, R * Math.sin(theta)));
      }
    } else if (arrangement === 'mobius') {
      for (let k = 0; k < n; k++) {
        const u = (k / n) * 2 * Math.PI;
        const w = 0.8 * Math.sin((k / n) * Math.PI * 2);
        const x = (R + w * Math.cos(u / 2)) * Math.cos(u);
        const y = w * Math.sin(u / 2);
        const z = (R + w * Math.cos(u / 2)) * Math.sin(u);
        positions.push(new THREE.Vector3(x, y, z));
      }
    } else {
      // Archimedean spiral
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const theta = t * 4 * Math.PI;
        const r = R * (0.35 + 0.65 * t);
        const y = (t - 0.5) * R * 0.7;
        positions.push(new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)));
      }
    }
    return positions;
  }

  // ── Source Geometry Rebuild ─────────────────────────────────────────────────

  rebuildSources(cfg: SourceConfig): void {
    this.sourceMeshes.forEach(m => this.scene.remove(m));
    this.sourceRings.forEach(m => this.scene.remove(m));
    this.sourcePointLights.forEach(l => this.scene.remove(l));
    this.sourceMeshes = [];
    this.sourceRings = [];
    this.sourcePointLights = [];

    const positions = this.getSourcePositions(cfg);
    const sphereGeo = new THREE.SphereGeometry(0.18, 20, 20);
    const ringGeo = new THREE.TorusGeometry(0.36, 0.04, 8, 40);

    positions.forEach((pos, i) => {
      const hue = (i / Math.max(cfg.count, 1)) * 0.25 + 0.53; // cyan to blue
      const color = new THREE.Color().setHSL(hue, 1, 0.75);
      const emissiveColor = new THREE.Color().setHSL(hue, 1, 0.5);

      const mat = new THREE.MeshPhongMaterial({ color, emissive: emissiveColor, emissiveIntensity: 2.5, shininess: 200 });
      const sphere = new THREE.Mesh(sphereGeo, mat);
      sphere.position.copy(pos);
      this.scene.add(sphere);
      this.sourceMeshes.push(sphere);

      const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      this.scene.add(ring);
      this.sourceRings.push(ring);

      const light = new THREE.PointLight(color, 1.2, 6);
      light.position.copy(pos);
      this.scene.add(light);
      this.sourcePointLights.push(light);
    });
  }

  // ── Manifold Geometry Rebuild ───────────────────────────────────────────────

  rebuildManifold(mCfg: ManifoldConfig, sCfg: SourceConfig): void {
    if (this.manifoldMesh) {
      this.scene.remove(this.manifoldMesh);
      this.manifoldMesh.geometry.dispose();
    }
    this.manifoldVertexBase = null;

    let geo: THREE.BufferGeometry;
    if (mCfg.type === 'mobius') {
      geo = this.buildMobiusGeo(sCfg.radius * 0.75);
    } else if (mCfg.type === 'hexagonal') {
      geo = this.buildHexGeo(mCfg.symmetryFolds, sCfg.radius * 0.8);
    } else {
      geo = new THREE.PlaneGeometry(sCfg.radius * 1.5, sCfg.radius * 1.5, 90, 90);
      // Rotate flat plane to stand upright
      geo.rotateX(-Math.PI / 2);
    }

    // Snapshot base positions for wave animation
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;
    this.manifoldVertexBase = new Float32Array(posAttr.array);

    const mat = new THREE.MeshPhongMaterial({
      color: 0x6699cc,
      emissive: 0x001133,
      emissiveIntensity: 0.6,
      shininess: 180,
      specular: 0x99ccff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      vertexColors: true,
    });
    this.manifoldMesh = new THREE.Mesh(geo, mat);
    this.manifoldMesh.castShadow = true;
    this.manifoldMesh.receiveShadow = true;
    this.scene.add(this.manifoldMesh);
  }

  private buildMobiusGeo(radius: number): THREE.BufferGeometry {
    const segU = 200, segV = 48, width = 1.6;
    const verts: number[] = [], colors: number[] = [], indices: number[] = [];

    for (let u = 0; u <= segU; u++) {
      const theta = (u / segU) * Math.PI * 2;
      for (let v = 0; v <= segV; v++) {
        const w = (v / segV - 0.5) * width;
        const x = (radius + w * Math.cos(theta / 2)) * Math.cos(theta);
        const y = w * Math.sin(theta / 2);
        const z = (radius + w * Math.cos(theta / 2)) * Math.sin(theta);
        verts.push(x, y, z);
        const t = (Math.sin(theta * 3 + w * 4) * 0.5 + 0.5);
        colors.push(0.1 + t * 0.3, 0.3 + t * 0.5, 0.7 + t * 0.3);
      }
    }
    for (let u = 0; u < segU; u++) {
      for (let v = 0; v < segV; v++) {
        const i0 = u * (segV + 1) + v;
        indices.push(i0, i0 + 1, i0 + segV + 1, i0 + 1, i0 + segV + 2, i0 + segV + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  private buildHexGeo(folds: number, radius: number): THREE.BufferGeometry {
    const rings = 50, radSegs = Math.max(folds, 3) * 10;
    const verts: number[] = [], colors: number[] = [], indices: number[] = [];

    for (let r = 0; r <= rings; r++) {
      const rf = r / rings;
      for (let s = 0; s <= radSegs; s++) {
        const sf = s / radSegs;
        const theta = sf * Math.PI * 2;
        const rr = rf * radius;
        const x = rr * Math.cos(theta);
        const y = Math.sin(rf * folds * Math.PI) * 0.25;
        const z = rr * Math.sin(theta);
        verts.push(x, y, z);
        const t = Math.abs(Math.sin(rf * folds * Math.PI));
        colors.push(0.05 + t * 0.35, 0.2 + t * 0.5, 0.6 + t * 0.4);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < radSegs; s++) {
        const i0 = r * (radSegs + 1) + s;
        indices.push(i0, i0 + 1, i0 + radSegs + 1, i0 + 1, i0 + radSegs + 2, i0 + radSegs + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // ── Intensity Field Computation ─────────────────────────────────────────────

  computeIntensityField(sCfg: SourceConfig, dCfg: DiamondConfig): void {
    const res = 80;
    const half = 9;
    const k = (2 * Math.PI * dCfg.refractiveIndex) / sCfg.wavelength;
    const srcPos = this.getSourcePositions(sCfg);

    this.intensityField2D = new Float32Array(res * res);
    let maxI = 0;

    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const x = -half + (ix / (res - 1)) * half * 2;
        const z = -half + (iy / (res - 1)) * half * 2;
        let re = 0, im = 0;
        for (let s = 0; s < srcPos.length; s++) {
          const dx = x - srcPos[s].x, dz = z - srcPos[s].z;
          const dist = Math.sqrt(dx * dx + dz * dz) + 0.01;
          const phi = k * dist + (sCfg.phases[s] ?? 0) + sCfg.globalPhase;
          const amp = (sCfg.amplitudes[s] ?? 1.0) / dist;
          re += amp * Math.cos(phi);
          im += amp * Math.sin(phi);
        }
        const I = re * re + im * im;
        this.intensityField2D[iy * res + ix] = I;
        if (I > maxI) maxI = I;
      }
    }

    this.peakIntensity = maxI;
    this.drawIntensityTexture(res, maxI);
    this.updateEtching(sCfg, dCfg, res, maxI);
  }

  private drawIntensityTexture(res: number, maxI: number): void {
    if (!this.intensityField2D || !this.groundTexture) return;
    const ctx = this.groundCanvas.getContext('2d')!;
    const s = 512;
    const cellW = s / res;

    // Clear with dark grid background
    ctx.fillStyle = '#010c1a';
    ctx.fillRect(0, 0, s, s);

    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const t = Math.min(this.intensityField2D[iy * res + ix] / (maxI * 0.8), 1.0);
        let r, g, b;
        if (t < 0.25) { const f = t / 0.25; r = 0; g = 0; b = Math.round(f * 200); }
        else if (t < 0.5) { const f = (t - 0.25) / 0.25; r = 0; g = Math.round(f * 200); b = 200; }
        else if (t < 0.75) { const f = (t - 0.5) / 0.25; r = Math.round(f * 255); g = 200; b = Math.round(200 * (1 - f)); }
        else { const f = (t - 0.75) / 0.25; r = 255; g = Math.round(200 * (1 - f * 0.5)); b = 0; }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(ix * cellW, iy * cellW, cellW + 0.5, cellW + 0.5);
      }
    }

    // Grid overlay
    ctx.strokeStyle = 'rgba(0,200,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 16; i++) {
      ctx.beginPath(); ctx.moveTo(i * s / 16, 0); ctx.lineTo(i * s / 16, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s / 16); ctx.lineTo(s, i * s / 16); ctx.stroke();
    }

    this.groundTexture.needsUpdate = true;
  }

  private updateEtching(sCfg: SourceConfig, dCfg: DiamondConfig, res: number, maxI: number): void {
    if (!this.intensityField2D || dCfg.exposureTime === 0) return;
    const n = this.voxelGridSize;
    const voxelW = (this.worldExtent * 2) / n;
    let count = 0;
    const dummy = new THREE.Object3D();

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = -this.worldExtent + ix * voxelW;
        const wz = -this.worldExtent + iz * voxelW;
        const fieldX = Math.floor(((wx + 9) / 18) * res);
        const fieldZ = Math.floor(((wz + 9) / 18) * res);
        if (fieldX < 0 || fieldX >= res || fieldZ < 0 || fieldZ >= res) continue;
        const I = this.intensityField2D[fieldZ * res + fieldX];
        const voxIdx = iz * n * n + 5 * n + ix; // middle Y layer
        if (I > dCfg.ablationThreshold) {
          this.diamondVoxels[voxIdx] = Math.min(this.diamondVoxels[voxIdx] + I * 0.008 * dCfg.exposureTime, 1.0);
        }
        if (this.diamondVoxels[voxIdx] > 0.05) count++;
      }
    }
    this.etchedVoxels = count;

    // Rebuild instanced mesh
    if (!this.diamondInstancedMesh) return;
    let instanceIdx = 0;
    const color = new THREE.Color();

    for (let iz = 0; iz < n; iz++) {
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          const vIdx = iz * n * n + iy * n + ix;
          if (this.diamondVoxels[vIdx] > 0.05) {
            dummy.position.set(
              -this.worldExtent + ix * voxelW + voxelW / 2,
              -this.worldExtent + iy * voxelW + voxelW / 2,
              -this.worldExtent + iz * voxelW + voxelW / 2
            );
            dummy.updateMatrix();
            this.diamondInstancedMesh.setMatrixAt(instanceIdx, dummy.matrix);
            color.setHSL(0.6 + this.diamondVoxels[vIdx] * 0.15, 0.8, 0.55);
            this.diamondInstancedMesh.setColorAt(instanceIdx, color);
            instanceIdx++;
          }
        }
      }
    }
    this.diamondInstancedMesh.count = instanceIdx;
    this.diamondInstancedMesh.instanceMatrix.needsUpdate = true;
    if (this.diamondInstancedMesh.instanceColor) {
      this.diamondInstancedMesh.instanceColor.needsUpdate = true;
    }
  }

  resetEtching(): void {
    this.diamondVoxels = new Float32Array(this.voxelGridSize ** 3);
    this.etchedVoxels = 0;
    if (this.diamondInstancedMesh) this.diamondInstancedMesh.count = 0;
  }

  // ── Ray Traces ─────────────────────────────────────────────────────────────

  rebuildRayTraces(cfg: SourceConfig, mCfg: ManifoldConfig, vCfg: VisualConfig): void {
    this.rayLines.forEach(l => this.scene.remove(l));
    this.rayLines = [];
    if (!vCfg.showRayTraces || !this.manifoldMesh) return;

    const positions = this.getSourcePositions(cfg);
    const center = new THREE.Vector3(0, 0, 0);

    positions.forEach((srcPos, i) => {
      const hue = (i / Math.max(cfg.count, 1)) * 0.25 + 0.53;
      const color = new THREE.Color().setHSL(hue, 1, 0.75);

      let pos = srcPos.clone();
      let dir = center.clone().sub(pos).normalize();
      const pts: THREE.Vector3[] = [pos.clone()];

      for (let bounce = 0; bounce < vCfg.rayMaxBounces; bounce++) {
        const raycaster = new THREE.Raycaster(pos.clone().add(dir.clone().multiplyScalar(0.05)), dir.clone(), 0.05, 30);
        const hits = this.manifoldMesh ? raycaster.intersectObject(this.manifoldMesh, false) : [];

        if (hits.length > 0) {
          const hit = hits[0];
          pts.push(hit.point.clone());
          if (hit.face) {
            const norm = hit.face.normal.clone().applyQuaternion(this.manifoldMesh!.quaternion).normalize();
            dir = dir.clone().sub(norm.multiplyScalar(2 * dir.dot(norm))).normalize();
          }
          pos = hit.point.clone().add(dir.clone().multiplyScalar(0.08));
        } else {
          pts.push(pos.clone().add(dir.clone().multiplyScalar(14)));
          break;
        }
      }

      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, linewidth: 2 });
      const line = new THREE.Line(geo, mat);
      this.scene.add(line);
      this.rayLines.push(line);
    });
  }

  // ── Field Lines ─────────────────────────────────────────────────────────────

  rebuildFieldLines(cfg: SourceConfig, vCfg: VisualConfig): void {
    this.fieldLines.forEach(l => this.scene.remove(l));
    this.fieldLines = [];
    if (!vCfg.showFieldLines) return;

    const positions = this.getSourcePositions(cfg);
    const center = new THREE.Vector3(0, 0, 0);

    positions.forEach(pos => {
      const pts = [pos.clone(), center.clone()];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({ color: 0xffaa33, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.45 });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.scene.add(line);
      this.fieldLines.push(line);
    });
  }

  // ── Visibility Toggles ──────────────────────────────────────────────────────

  setIntensityPlaneVisible(v: boolean): void {
    if (this.groundPlane) this.groundPlane.visible = v;
  }

  setDiamondVoxelsVisible(v: boolean): void {
    if (this.diamondInstancedMesh) this.diamondInstancedMesh.visible = v;
  }

  setManifoldVisible(v: boolean): void {
    if (this.manifoldMesh) this.manifoldMesh.visible = v;
  }

  // ── Per-Frame Animation ─────────────────────────────────────────────────────

  update(time: number, mCfg: ManifoldConfig, sCfg: SourceConfig): void {
    // Animate manifold vertices
    if (this.manifoldMesh && this.manifoldVertexBase) {
      const posAttr = this.manifoldMesh.geometry.attributes['position'] as THREE.BufferAttribute;
      const colorAttr = this.manifoldMesh.geometry.attributes['color'] as THREE.BufferAttribute | undefined;
      const base = this.manifoldVertexBase;

      for (let i = 0; i < posAttr.count; i++) {
        const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        const wave = Math.sin(time * mCfg.vibrationFrequency + bx * 3.5 + bz * 3.5) * mCfg.vibrationAmplitude;

        // For Möbius, displace along normal; for flat, displace Y
        if (mCfg.type === 'mobius') {
          const nx = by === 0 ? 0 : by / Math.sqrt(bx * bx + by * by + bz * bz);
          posAttr.setXYZ(i, bx + nx * wave * 0.3, by + wave * 0.6, bz);
        } else {
          posAttr.setY(i, by + wave);
        }

        if (colorAttr) {
          const intensity = (wave + mCfg.vibrationAmplitude) / (mCfg.vibrationAmplitude * 2 + 0.001);
          colorAttr.setXYZ(i, 0.05 + intensity * 0.4, 0.2 + intensity * 0.5, 0.6 + intensity * 0.4);
        }
      }
      posAttr.needsUpdate = true;
      if (colorAttr) colorAttr.needsUpdate = true;
      this.manifoldMesh.geometry.computeVertexNormals();
      this.manifoldMesh.rotation.y = time * mCfg.rotationSpeed;
    }

    // Animate sources: pulse scale, ring rotation
    const srcPos = this.getSourcePositions(sCfg);
    this.sourceMeshes.forEach((m, i) => {
      const pulse = 1 + 0.18 * Math.sin(time * 3.5 + i * 0.8);
      m.scale.setScalar(pulse);
      if (srcPos[i]) m.position.copy(srcPos[i]);
    });
    this.sourceRings.forEach((r, i) => {
      r.rotation.x = time * 1.2 + i * 0.5;
      r.rotation.z = time * 0.7 + i * 0.3;
      if (srcPos[i]) r.position.copy(srcPos[i]);
    });
    this.sourcePointLights.forEach((l, i) => {
      l.intensity = 1.0 + 0.6 * Math.sin(time * 3.5 + i * 0.8);
      if (srcPos[i]) l.position.copy(srcPos[i]);
    });

    // Animate focal sphere
    if (this.focalSphere && this.focalLight) {
      const fScale = 1 + 0.3 * Math.sin(time * 4.2);
      this.focalSphere.scale.setScalar(fScale);
      this.focalLight.intensity = 2.5 + 1.5 * Math.sin(time * 4.2);
    }
  }

  dispose(): void {
    this.sourceMeshes.forEach(m => this.scene.remove(m));
    this.sourceRings.forEach(m => this.scene.remove(m));
    this.sourcePointLights.forEach(l => this.scene.remove(l));
    this.rayLines.forEach(l => this.scene.remove(l));
    this.fieldLines.forEach(l => this.scene.remove(l));
    if (this.manifoldMesh) this.scene.remove(this.manifoldMesh);
    if (this.groundPlane) this.scene.remove(this.groundPlane);
    if (this.focalSphere) this.scene.remove(this.focalSphere);
    if (this.diamondInstancedMesh) this.scene.remove(this.diamondInstancedMesh);
  }
}

// ─── Angular Component ────────────────────────────────────────────────────────

@Component({
  selector: 'app-claude-sim',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sim-root">
      <!-- Three.js Canvas -->
      <div #canvas class="canvas-host"></div>

      <!-- HUD: Top Bar -->
      <div class="hud-bar">
        <span class="logo">◈ CLAUDE–SIM</span>
        <span class="subtitle">Diamond Waveguide Interference Manifold</span>
        <div class="stats-cluster">
          <span class="stat"><em>FPS</em>{{ stats.fps }}</span>
          <span class="stat"><em>PEAK I</em>{{ stats.peakIntensity | number:'1.1-1' }}</span>
          <span class="stat"><em>VOXELS</em>{{ stats.etchedVoxels }}</span>
          <span class="stat"><em>RAYS</em>{{ sourceCfg.count }}</span>
        </div>
      </div>

      <!-- Control Panel -->
      <div class="panel" [class.collapsed]="panelCollapsed">
        <button class="panel-toggle" (click)="panelCollapsed = !panelCollapsed">
          {{ panelCollapsed ? '▶ CONTROLS' : '◀ HIDE' }}
        </button>

        <div class="panel-content" *ngIf="!panelCollapsed">

          <!-- ── SOURCES ── -->
          <div class="section">
            <div class="section-title">⬡ SOURCES</div>

            <div class="row">
              <label>Count <em>n</em></label>
              <input type="range" min="2" max="18" step="1" [(ngModel)]="sourceCfg.count"
                     (ngModelChange)="onSourceCountChange()">
              <span class="val">{{ sourceCfg.count }}</span>
            </div>

            <div class="row">
              <label>Radius</label>
              <input type="range" min="1" max="8" step="0.1" [(ngModel)]="sourceCfg.radius"
                     (ngModelChange)="onGeometryChange()">
              <span class="val">{{ sourceCfg.radius | number:'1.1-1' }}</span>
            </div>

            <div class="row">
              <label>Wavelength λ</label>
              <input type="range" min="0.1" max="2.0" step="0.05" [(ngModel)]="sourceCfg.wavelength"
                     (ngModelChange)="onFieldChange()">
              <span class="val">{{ sourceCfg.wavelength | number:'1.2-2' }}</span>
            </div>

            <div class="row">
              <label>Global Phase</label>
              <input type="range" min="0" max="6.28" step="0.05" [(ngModel)]="sourceCfg.globalPhase"
                     (ngModelChange)="onFieldChange()">
              <span class="val">{{ sourceCfg.globalPhase | number:'1.2-2' }}</span>
            </div>

            <div class="row">
              <label>Arrangement</label>
              <select [(ngModel)]="sourceCfg.arrangement" (ngModelChange)="onGeometryChange()">
                <option value="circle">Circle</option>
                <option value="mobius">Möbius</option>
                <option value="spiral">Spiral</option>
              </select>
            </div>
          </div>

          <!-- ── MANIFOLD ── -->
          <div class="section">
            <div class="section-title">◎ MANIFOLD</div>

            <div class="row">
              <label>Type</label>
              <select [(ngModel)]="manifoldCfg.type" (ngModelChange)="onManifoldRebuild()">
                <option value="flat">Flat Plane</option>
                <option value="mobius">Möbius Strip</option>
                <option value="hexagonal">Hexagonal</option>
              </select>
            </div>

            <div class="row" *ngIf="manifoldCfg.type === 'hexagonal'">
              <label>Sym. Folds</label>
              <input type="range" min="2" max="12" step="1" [(ngModel)]="manifoldCfg.symmetryFolds"
                     (ngModelChange)="onManifoldRebuild()">
              <span class="val">{{ manifoldCfg.symmetryFolds }}</span>
            </div>

            <div class="row">
              <label>Vibr. Freq.</label>
              <input type="range" min="0.5" max="20" step="0.5" [(ngModel)]="manifoldCfg.vibrationFrequency">
              <span class="val">{{ manifoldCfg.vibrationFrequency | number:'1.1-1' }}</span>
            </div>

            <div class="row">
              <label>Vibr. Amp.</label>
              <input type="range" min="0" max="1.2" step="0.02" [(ngModel)]="manifoldCfg.vibrationAmplitude">
              <span class="val">{{ manifoldCfg.vibrationAmplitude | number:'1.2-2' }}</span>
            </div>

            <div class="row">
              <label>Rotation ω</label>
              <input type="range" min="-3" max="3" step="0.05" [(ngModel)]="manifoldCfg.rotationSpeed">
              <span class="val">{{ manifoldCfg.rotationSpeed | number:'1.2-2' }}</span>
            </div>
          </div>

          <!-- ── DIAMOND ── -->
          <div class="section">
            <div class="section-title">◇ DIAMOND</div>

            <div class="row">
              <label>Ref. Index n<sub>d</sub></label>
              <input type="range" min="1.0" max="3.5" step="0.02" [(ngModel)]="diamondCfg.refractiveIndex"
                     (ngModelChange)="onFieldChange()">
              <span class="val">{{ diamondCfg.refractiveIndex | number:'1.2-2' }}</span>
            </div>

            <div class="row">
              <label>Ablation Θ</label>
              <input type="range" min="0.1" max="8.0" step="0.1" [(ngModel)]="diamondCfg.ablationThreshold"
                     (ngModelChange)="onFieldChange()">
              <span class="val">{{ diamondCfg.ablationThreshold | number:'1.1-1' }}</span>
            </div>

            <div class="row">
              <label>Exposure τ</label>
              <input type="range" min="0" max="30" step="0.5" [(ngModel)]="diamondCfg.exposureTime"
                     (ngModelChange)="onFieldChange()">
              <span class="val">{{ diamondCfg.exposureTime | number:'1.1-1' }}</span>
            </div>

            <button class="btn-reset" (click)="resetEtching()">↺ RESET ETCHING</button>
          </div>

          <!-- ── VISUAL ── -->
          <div class="section">
            <div class="section-title">◉ VISUAL</div>

            <div class="toggle-row" (click)="toggleLayer('intensity')">
              <span class="toggle-dot" [class.on]="visualCfg.showIntensityPlane"></span>
              Intensity Plane
            </div>
            <div class="toggle-row" (click)="toggleLayer('rays')">
              <span class="toggle-dot" [class.on]="visualCfg.showRayTraces"></span>
              Ray Traces
            </div>
            <div class="toggle-row" (click)="toggleLayer('field')">
              <span class="toggle-dot" [class.on]="visualCfg.showFieldLines"></span>
              Field Lines
            </div>
            <div class="toggle-row" (click)="toggleLayer('diamond')">
              <span class="toggle-dot" [class.on]="visualCfg.showDiamondVoxels"></span>
              Diamond Voxels
            </div>
            <div class="toggle-row" (click)="toggleLayer('manifold')">
              <span class="toggle-dot" [class.on]="visualCfg.showManifold"></span>
              Manifold Mesh
            </div>

            <div class="row" *ngIf="visualCfg.showRayTraces">
              <label>Bounces</label>
              <input type="range" min="1" max="8" step="1" [(ngModel)]="visualCfg.rayMaxBounces"
                     (ngModelChange)="onRayRebuild()">
              <span class="val">{{ visualCfg.rayMaxBounces }}</span>
            </div>
          </div>

        </div><!-- /panel-content -->
      </div><!-- /panel -->

      <!-- Bottom: phase auto-sweep -->
      <div class="bottom-bar">
        <label class="sweep-label">
          <input type="checkbox" [(ngModel)]="phaseSweep"> AUTO PHASE SWEEP
        </label>
        <label class="sweep-label">
          <input type="checkbox" [(ngModel)]="autoRebuildRays"> LIVE RAY REBUILD
        </label>
        <span class="credit">Structured Interference Manifold · Diamond Waveguide Framework</span>
      </div>
    </div>
  `,
  styles: [`
    @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700&display=swap');

    :host { display: block; width: 100%; height: 100vh; }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    .sim-root {
      position: relative;
      width: 100%;
      height: 100vh;
      background: #010812;
      overflow: hidden;
      font-family: 'Share Tech Mono', monospace;
    }

    .canvas-host {
      position: absolute;
      inset: 0;
    }

    /* ── HUD Bar ─────────────────────────────────────────────────── */
    .hud-bar {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 48px;
      background: linear-gradient(180deg, rgba(0,10,30,0.96) 0%, rgba(0,10,30,0.6) 100%);
      border-bottom: 1px solid rgba(0,180,255,0.25);
      display: flex;
      align-items: center;
      padding: 0 18px;
      gap: 20px;
      backdrop-filter: blur(6px);
      z-index: 10;
    }

    .logo {
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 15px;
      color: #00d4ff;
      letter-spacing: 0.08em;
      text-shadow: 0 0 12px rgba(0,212,255,0.7);
    }

    .subtitle {
      font-size: 10px;
      color: rgba(0,180,255,0.55);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      flex: 1;
    }

    .stats-cluster {
      display: flex;
      gap: 18px;
    }

    .stat {
      font-size: 11px;
      color: rgba(0,212,255,0.8);
      letter-spacing: 0.06em;
    }

    .stat em {
      display: block;
      font-style: normal;
      font-size: 8px;
      color: rgba(0,180,255,0.45);
      letter-spacing: 0.14em;
      margin-bottom: 1px;
    }

    /* ── Control Panel ───────────────────────────────────────────── */
    .panel {
      position: absolute;
      top: 58px; right: 0;
      width: 280px;
      max-height: calc(100vh - 80px);
      display: flex;
      flex-direction: column;
      z-index: 10;
    }

    .panel.collapsed {
      width: auto;
    }

    .panel-toggle {
      align-self: flex-end;
      background: rgba(0,12,28,0.88);
      border: 1px solid rgba(0,180,255,0.28);
      border-right: none;
      color: rgba(0,212,255,0.8);
      font-family: 'Share Tech Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      padding: 7px 14px;
      cursor: pointer;
      border-radius: 4px 0 0 4px;
      transition: background 0.2s, color 0.2s;
    }

    .panel-toggle:hover {
      background: rgba(0,40,80,0.9);
      color: #00d4ff;
    }

    .panel-content {
      background: rgba(0,8,22,0.9);
      border: 1px solid rgba(0,180,255,0.2);
      border-right: none;
      border-top: none;
      border-radius: 0 0 0 8px;
      overflow-y: auto;
      flex: 1;
      padding: 0 0 12px;
      backdrop-filter: blur(8px);
    }

    .panel-content::-webkit-scrollbar { width: 4px; }
    .panel-content::-webkit-scrollbar-track { background: transparent; }
    .panel-content::-webkit-scrollbar-thumb { background: rgba(0,180,255,0.3); border-radius: 2px; }

    .section {
      padding: 14px 16px 10px;
      border-bottom: 1px solid rgba(0,180,255,0.1);
    }

    .section:last-child { border-bottom: none; }

    .section-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 9px;
      font-weight: 700;
      color: rgba(0,212,255,0.5);
      letter-spacing: 0.2em;
      margin-bottom: 12px;
    }

    .row {
      display: grid;
      grid-template-columns: 100px 1fr 40px;
      align-items: center;
      gap: 8px;
      margin-bottom: 9px;
    }

    .row label {
      font-size: 10px;
      color: rgba(0,200,255,0.65);
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    .row select {
      grid-column: 2 / 4;
      background: rgba(0,20,45,0.85);
      border: 1px solid rgba(0,180,255,0.25);
      color: rgba(0,212,255,0.9);
      font-family: 'Share Tech Mono', monospace;
      font-size: 11px;
      padding: 3px 6px;
      border-radius: 3px;
      cursor: pointer;
      outline: none;
    }

    .val {
      font-size: 11px;
      color: #00d4ff;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      background: rgba(0,180,255,0.15);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
      width: 100%;
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px; height: 12px;
      background: #00d4ff;
      border-radius: 50%;
      box-shadow: 0 0 6px rgba(0,212,255,0.8);
      cursor: pointer;
    }

    input[type="range"]::-moz-range-thumb {
      width: 12px; height: 12px;
      background: #00d4ff;
      border: none;
      border-radius: 50%;
      box-shadow: 0 0 6px rgba(0,212,255,0.8);
      cursor: pointer;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: rgba(0,200,255,0.65);
      cursor: pointer;
      padding: 5px 0;
      letter-spacing: 0.06em;
      transition: color 0.2s;
      user-select: none;
    }

    .toggle-row:hover { color: rgba(0,220,255,0.9); }

    .toggle-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: rgba(0,180,255,0.2);
      border: 1px solid rgba(0,180,255,0.4);
      transition: all 0.2s;
      flex-shrink: 0;
    }

    .toggle-dot.on {
      background: #00d4ff;
      box-shadow: 0 0 8px rgba(0,212,255,0.9);
      border-color: #00d4ff;
    }

    .btn-reset {
      margin-top: 8px;
      width: 100%;
      background: rgba(255,80,0,0.08);
      border: 1px solid rgba(255,100,0,0.3);
      color: rgba(255,140,0,0.8);
      font-family: 'Share Tech Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      padding: 7px;
      cursor: pointer;
      border-radius: 3px;
      transition: all 0.2s;
    }

    .btn-reset:hover {
      background: rgba(255,100,0,0.15);
      color: #ff8c00;
    }

    /* ── Bottom Bar ──────────────────────────────────────────────── */
    .bottom-bar {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 36px;
      background: linear-gradient(0deg, rgba(0,8,24,0.95) 0%, rgba(0,8,24,0.6) 100%);
      border-top: 1px solid rgba(0,180,255,0.18);
      display: flex;
      align-items: center;
      padding: 0 18px;
      gap: 24px;
      backdrop-filter: blur(4px);
      z-index: 10;
    }

    .sweep-label {
      font-size: 9px;
      color: rgba(0,200,255,0.6);
      letter-spacing: 0.12em;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 7px;
      user-select: none;
    }

    .sweep-label input[type="checkbox"] {
      accent-color: #00d4ff;
      cursor: pointer;
    }

    .credit {
      margin-left: auto;
      font-size: 9px;
      color: rgba(0,150,220,0.3);
      letter-spacing: 0.1em;
    }
  `],
})
export class ClaudeSIMComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLDivElement>;

  private ngZone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  // Three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private engine!: DiamondWaveguideEngine;
  private rafId = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fpsTimer = 0;

  // State
  panelCollapsed = false;
  phaseSweep = false;
  autoRebuildRays = false;

  sourceCfg: SourceConfig = {
    count: 6,
    radius: 4.5,
    wavelength: 0.62,
    globalPhase: 0,
    arrangement: 'circle',
    amplitudes: new Array(18).fill(1.0),
    phases: new Array(18).fill(0),
  };

  manifoldCfg: ManifoldConfig = {
    type: 'mobius',
    symmetryFolds: 6,
    vibrationFrequency: 8,
    vibrationAmplitude: 0.28,
    rotationSpeed: 0.4,
  };

  diamondCfg: DiamondConfig = {
    refractiveIndex: 2.42,
    ablationThreshold: 1.8,
    exposureTime: 0,
  };

  visualCfg: VisualConfig = {
    showIntensityPlane: true,
    showRayTraces: true,
    showFieldLines: false,
    showDiamondVoxels: true,
    showManifold: true,
    rayMaxBounces: 3,
  };

  stats: SimStats = { fps: 0, peakIntensity: 0, etchedVoxels: 0, activeRays: 0 };

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    this.initThreeJS();
    this.engine = new DiamondWaveguideEngine(this.scene);
    this.engine.rebuildSources(this.sourceCfg);
    this.engine.rebuildManifold(this.manifoldCfg, this.sourceCfg);
    this.engine.computeIntensityField(this.sourceCfg, this.diamondCfg);
    this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
    this.engine.rebuildFieldLines(this.sourceCfg, this.visualCfg);
    this.applyVisibility();
    this.startLoop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.engine.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    const host = this.canvasRef?.nativeElement;
    if (host && this.renderer?.domElement?.parentNode === host) {
      host.removeChild(this.renderer.domElement);
    }
    window.removeEventListener('resize', this.onResize);
  }

  // ── Three.js Setup ──────────────────────────────────────────────────────────

  private initThreeJS(): void {
    const host = this.canvasRef.nativeElement;
    const w = host.clientWidth, h = host.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x010812);
    this.scene.fog = new THREE.FogExp2(0x010812, 0.022);

    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 200);
    this.camera.position.set(0, 9, 20);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 60;
    this.controls.target.set(0, 0, 0);

    // Axes helper (subtle)
    const axes = new THREE.AxesHelper(3);
    (axes.material as THREE.LineBasicMaterial).opacity = 0.25;
    (axes.material as THREE.LineBasicMaterial).transparent = true;
    this.scene.add(axes);

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    const host = this.canvasRef?.nativeElement;
    if (!host) return;
    const w = host.clientWidth, h = host.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  // ── Animation Loop ──────────────────────────────────────────────────────────

  private startLoop(): void {
    this.ngZone.runOutsideAngular(() => {
      const loop = (now: number) => {
        this.rafId = requestAnimationFrame(loop);
        const delta = Math.min((now - this.lastTime) / 1000, 0.1);
        this.lastTime = now;
        const time = now / 1000;

        // Phase sweep
        if (this.phaseSweep) {
          this.sourceCfg.globalPhase = (this.sourceCfg.globalPhase + delta * 1.2) % (Math.PI * 2);
          this.engine.computeIntensityField(this.sourceCfg, this.diamondCfg);
          if (this.autoRebuildRays) {
            this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
          }
        }

        this.engine.update(time, this.manifoldCfg, this.sourceCfg);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);

        // FPS & stats
        this.frameCount++;
        this.fpsTimer += delta;
        if (this.fpsTimer >= 0.5) {
          this.stats.fps = Math.round(this.frameCount / this.fpsTimer);
          this.stats.peakIntensity = this.engine.peakIntensity;
          this.stats.etchedVoxels = this.engine.etchedVoxels;
          this.frameCount = 0;
          this.fpsTimer = 0;
          this.ngZone.run(() => this.cdr.markForCheck());
        }
      };

      this.lastTime = performance.now();
      loop(this.lastTime);
    });
  }

  // ── Change Handlers ─────────────────────────────────────────────────────────

  onSourceCountChange(): void {
    // Ensure amplitude/phase arrays are correct length
    while (this.sourceCfg.amplitudes.length < this.sourceCfg.count) this.sourceCfg.amplitudes.push(1.0);
    while (this.sourceCfg.phases.length < this.sourceCfg.count) this.sourceCfg.phases.push(0);
    this.engine.rebuildSources(this.sourceCfg);
    this.engine.computeIntensityField(this.sourceCfg, this.diamondCfg);
    this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
    this.engine.rebuildFieldLines(this.sourceCfg, this.visualCfg);
  }

  onGeometryChange(): void {
    this.engine.rebuildSources(this.sourceCfg);
    this.engine.rebuildManifold(this.manifoldCfg, this.sourceCfg);
    this.engine.computeIntensityField(this.sourceCfg, this.diamondCfg);
    this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
    this.engine.rebuildFieldLines(this.sourceCfg, this.visualCfg);
    this.applyVisibility();
  }

  onFieldChange(): void {
    this.engine.computeIntensityField(this.sourceCfg, this.diamondCfg);
  }

  onManifoldRebuild(): void {
    this.engine.rebuildManifold(this.manifoldCfg, this.sourceCfg);
    this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
    this.applyVisibility();
  }

  onRayRebuild(): void {
    this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
  }

  toggleLayer(layer: string): void {
    switch (layer) {
      case 'intensity':
        this.visualCfg.showIntensityPlane = !this.visualCfg.showIntensityPlane;
        this.engine.setIntensityPlaneVisible(this.visualCfg.showIntensityPlane);
        break;
      case 'rays':
        this.visualCfg.showRayTraces = !this.visualCfg.showRayTraces;
        this.engine.rebuildRayTraces(this.sourceCfg, this.manifoldCfg, this.visualCfg);
        break;
      case 'field':
        this.visualCfg.showFieldLines = !this.visualCfg.showFieldLines;
        this.engine.rebuildFieldLines(this.sourceCfg, this.visualCfg);
        break;
      case 'diamond':
        this.visualCfg.showDiamondVoxels = !this.visualCfg.showDiamondVoxels;
        this.engine.setDiamondVoxelsVisible(this.visualCfg.showDiamondVoxels);
        break;
      case 'manifold':
        this.visualCfg.showManifold = !this.visualCfg.showManifold;
        this.engine.setManifoldVisible(this.visualCfg.showManifold);
        break;
    }
    this.cdr.markForCheck();
  }

  resetEtching(): void {
    this.engine.resetEtching();
    this.stats.etchedVoxels = 0;
    this.cdr.markForCheck();
  }

  private applyVisibility(): void {
    this.engine.setIntensityPlaneVisible(this.visualCfg.showIntensityPlane);
    this.engine.setDiamondVoxelsVisible(this.visualCfg.showDiamondVoxels);
    this.engine.setManifoldVisible(this.visualCfg.showManifold);
  }
}