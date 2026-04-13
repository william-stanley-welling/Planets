import * as THREE from 'three';
import { SIMULATION_CONSTANTS } from '../../galaxy/celestial.model';
import { Star } from '../../galaxy/star.model';

export interface IMagnetometer {
  readonly active: boolean;
  toggle(): void;
  update(): void;
  dispose(): void;
}

export class Magnetometer implements IMagnetometer {
  active = false;

  private gridLines: THREE.LineSegments | null = null;
  private vectorArrows: THREE.InstancedMesh | null = null;
  private colorAttribute!: THREE.InstancedBufferAttribute;

  private readonly GRID_RES = 18;
  private readonly GRID_HALF = Math.floor(this.GRID_RES / 2);
  private readonly GRID_STEP = 3 * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
  private readonly MAX_ARROW_LEN = 9.5;

  private gridPoints: THREE.Vector3[] = [];

  private readonly dummy = new THREE.Object3D();

  constructor(
    private scene: THREE.Scene,
    private star: Star,
  ) {
    this.generateGridPoints();
    this.buildGridLines();
    this.buildVectorArrows();
  }

  private generateGridPoints(): void {
    this.gridPoints = [];
    const step = this.GRID_STEP;
    const half = this.GRID_HALF * step;

    for (let x = -half; x <= half; x += step) {
      for (let y = -half; y <= half; y += step) {
        for (let z = -half; z <= half; z += step) {
          this.gridPoints.push(new THREE.Vector3(x, y, z));
        }
      }
    }
  }

  private buildGridLines(): void {
    const positions: number[] = [];
    const step = this.GRID_STEP;
    const half = this.GRID_HALF * step;

    for (let y = -half; y <= half; y += step) {
      for (let z = -half; z <= half; z += step) positions.push(-half, y, z, half, y, z);
    }
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) positions.push(x, -half, z, x, half, z);
    }
    for (let x = -half; x <= half; x += step) {
      for (let y = -half; y <= half; y += step) positions.push(x, y, -half, x, y, half);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.09,
      linewidth: 1,
    });

    this.gridLines = new THREE.LineSegments(geometry, material);
    this.scene.add(this.gridLines);
    this.gridLines.visible = false;
  }

  private buildVectorArrows(): void {
    const geometry = new THREE.CylinderGeometry(0.12, 0.02, 1.0, 8, 1, false);
    geometry.rotateX(Math.PI / 2);

    const vertexShader = `
      varying vec3 vColor;

      void main() {
        vec4 worldPos = instanceMatrix * vec4(position, 1.0);
        vColor = instanceColor.rgb;
        gl_Position = projectionMatrix * modelViewMatrix * worldPos;
      }
    `;

    const fragmentShader = `
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor, 0.92);
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.vectorArrows = new THREE.InstancedMesh(geometry, material, this.gridPoints.length);
    this.vectorArrows.frustumCulled = false;

    this.vectorArrows.setColorAt(0, new THREE.Color());
    this.colorAttribute = this.vectorArrows.instanceColor!;

    this.scene.add(this.vectorArrows);
    this.vectorArrows.visible = false;
  }

  toggle(): void {
    console.log(this);
    this.active = !this.active;
    if (this.gridLines) this.gridLines.visible = this.active;
    if (this.vectorArrows) this.vectorArrows.visible = this.active;

    if (this.active) this.update();
  }

  update(): void {
    if (!this.active || !this.vectorArrows || !this.star || this.gridPoints.length === 0) return;

    const colors = this.colorAttribute.array as Float32Array;
    const allBodies = this.getAllCelestialBodies();
    let idx = 0;

    for (const p of this.gridPoints) {
      const { V, heatFactor } = this.computeVectorAndHeatAt(p, allBodies);

      const mag = V.length();
      let dir = new THREE.Vector3(0, 0, 1);
      let arrowLen = 1.2;

      if (mag > 0.001) {
        dir = V.clone().normalize();
        arrowLen = Math.min(this.MAX_ARROW_LEN, 1.2 + mag * 2.4);
      }

      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

      this.dummy.position.copy(p);
      this.dummy.quaternion.copy(q);
      this.dummy.scale.set(1, 1, arrowLen);
      this.dummy.updateMatrix();

      this.vectorArrows!.setMatrixAt(idx, this.dummy.matrix);

      const intensity = Math.min(1.0, mag / 35);
      const finalHeat = Math.max(intensity, heatFactor);
      const hue = 0.48 + finalHeat * 0.38;
      const saturation = 0.9 + finalHeat * 0.1;
      const lightness = 0.55 + finalHeat * 0.35;
      const c = new THREE.Color().setHSL(hue, saturation, lightness);

      colors[idx * 3] = c.r;
      colors[idx * 3 + 1] = c.g;
      colors[idx * 3 + 2] = c.b;

      idx++;
    }

    this.vectorArrows!.instanceMatrix.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  private getAllCelestialBodies(): any[] {
    const bodies: any[] = [];

    if (!this.star) {
      return bodies;
    }

    bodies.push(this.star);
    for (const planet of this.star.satellites) {
      bodies.push(planet);
      for (const moon of planet.satellites || []) bodies.push(moon);
    }

    return bodies;
  }

  private computeVectorAndHeatAt(p: THREE.Vector3, bodies: any[]): { V: THREE.Vector3; heatFactor: number } {
    const V = new THREE.Vector3();
    let heatFactor = 0;

    // 1. Sun-centered expanding radiation (very strong)
    const distSun = p.length();
    if (distSun > 0.01) {
      const radial = p.clone().normalize();
      V.addScaledVector(radial, 95 / (distSun + 12));
    }

    for (const body of bodies) {
      const bPos = new THREE.Vector3();
      const group = body.orbitalGroup || body.group;
      if (group) group.getWorldPosition(bPos);

      const toP = p.clone().sub(bPos);
      const d = toP.length();
      if (d < 0.8) continue;

      // Heat intensity near vortexes
      heatFactor = Math.max(heatFactor, Math.max(0, 1 - d / 65));

      // 2. Repulsion → carves visible tunnels around orbits
      const repelStrength = 48 / (d * d + 9);
      V.addScaledVector(toP.normalize(), repelStrength);

      // 3. Strong radial + tangential vortex swirl (EM-field feel)
      const radial = toP.normalize();
      const strength = 38 / (d + 14);
      V.addScaledVector(radial, strength * 1.1);

      // Tangential component (creates swirling tunnels along orbital paths)
      const tang = new THREE.Vector3(-radial.z, radial.y * 0.3, radial.x).normalize();
      V.addScaledVector(tang, strength * 1.65);
    }

    // 4. Global galactic drift
    V.add(new THREE.Vector3(3.2, 1.4, -2.1));

    return { V, heatFactor };
  }

  dispose(): void {
    if (this.gridLines) {
      this.scene.remove(this.gridLines);
      this.gridLines.geometry.dispose();
      (this.gridLines.material as THREE.Material).dispose();
    }
    if (this.vectorArrows) {
      this.scene.remove(this.vectorArrows);
      this.vectorArrows.geometry.dispose();
      (this.vectorArrows.material as THREE.Material).dispose();
    }
    this.gridPoints = [];
  }
}
