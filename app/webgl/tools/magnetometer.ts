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

  private readonly GRID_RES = 15;
  private readonly GRID_HALF = Math.floor(this.GRID_RES / 2);
  private readonly GRID_STEP = 4 * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
  private readonly MAX_ARROW_LEN = 6.0;

  private gridPoints: THREE.Vector3[] = [];

  constructor(
    private scene: THREE.Scene,
    private star: Star,
  ) {
    this.buildGridLines();
    this.buildVectorArrows();
    this.generateGridPoints();
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

    // X-lines
    for (let y = -half; y <= half; y += step) {
      for (let z = -half; z <= half; z += step) {
        positions.push(-half, y, z, half, y, z);
      }
    }
    // Y-lines
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        positions.push(x, -half, z, x, half, z);
      }
    }
    // Z-lines
    for (let x = -half; x <= half; x += step) {
      for (let y = -half; y <= half; y += step) {
        positions.push(x, y, -half, x, y, half);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.12,
      linewidth: 1,
    });

    this.gridLines = new THREE.LineSegments(geometry, material);
    this.scene.add(this.gridLines);
    this.gridLines.visible = false;
  }

  private buildVectorArrows(): void {
    // Cylinder (body) + slight taper for "cylinder-with-cone" vector look
    const geometry = new THREE.CylinderGeometry(0.08, 0.035, 1, 8, 1, false);
    geometry.rotateX(Math.PI / 2); // align along +Z axis

    const vertexShader = `
      #include <common>

      varying vec3 vColor;

      void main() {
        vec4 worldPos = instanceMatrix * vec4(position, 1.0);
        vColor = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * worldPos;
      }
    `;

    const fragmentShader = `
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor, 0.88);
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.vectorArrows = new THREE.InstancedMesh(geometry, material, this.gridPoints.length);
    this.vectorArrows.frustumCulled = true;

    const colors = new Float32Array(this.gridPoints.length * 3);
    this.colorAttribute = new THREE.InstancedBufferAttribute(colors, 3);
    this.vectorArrows.instanceColor = this.colorAttribute;

    this.scene.add(this.vectorArrows);
    this.vectorArrows.visible = false;
  }

  toggle(): void {
    this.active = !this.active;
    if (this.gridLines) this.gridLines.visible = this.active;
    if (this.vectorArrows) this.vectorArrows.visible = this.active;
  }

  update(): void {
    if (!this.active || !this.vectorArrows || !this.star || this.gridPoints.length === 0) return;

    const dummy = new THREE.Object3D();
    const colors = this.colorAttribute.array as Float32Array;
    let idx = 0;

    for (const p of this.gridPoints) {
      const V = this.computeVectorAt(p);
      const mag = V.length();

      let dir = new THREE.Vector3(0, 0, 1);
      let arrowLen = 0.8;

      if (mag > 0.001) {
        dir = V.clone().normalize();
        arrowLen = Math.min(this.MAX_ARROW_LEN, 0.8 + mag * 1.8);
      }

      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

      dummy.position.copy(p);
      dummy.quaternion.copy(q);
      dummy.scale.set(1, 1, arrowLen);
      dummy.updateMatrix();

      this.vectorArrows!.setMatrixAt(idx, dummy.matrix);

      // Spacetime radiation color (hue shifts with field strength + slight galactic drift tint)
      const intensity = Math.min(1, mag / 25);
      const hue = 0.52 + intensity * 0.28; // cyan → turquoise → yellow
      const c = new THREE.Color().setHSL(hue, 0.95, 0.65);
      colors[idx * 3] = c.r;
      colors[idx * 3 + 1] = c.g;
      colors[idx * 3 + 2] = c.b;

      idx++;
    }

    this.vectorArrows!.instanceMatrix.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  private computeVectorAt(p: THREE.Vector3): THREE.Vector3 {
    const V = new THREE.Vector3();

    // 1. Sun-centered expanding radiation (1/r²)
    const sunPos = new THREE.Vector3(0, 0, 0);
    let toP = p.clone().sub(sunPos);
    let distSun = toP.length();
    if (distSun > 0.01) {
      const radial = toP.normalize();
      const strength = 12 / (distSun + 8);
      V.addScaledVector(radial, strength);
    }

    // 2. Planetary perturbations + spiral twist (heliocentric motion of the whole system)
    if (this.star.satellites) {
      for (const planet of this.star.satellites) {
        const group = (planet as any).orbitalGroup as THREE.Group | undefined;
        if (!group) continue;

        const bPos = new THREE.Vector3();
        group.getWorldPosition(bPos);

        let toPFromB = p.clone().sub(bPos);
        let d = toPFromB.length();
        if (d < 0.5 || d > 120) continue;

        const inf = 4 / (d * d + 12);
        const radialB = toPFromB.normalize();

        V.addScaledVector(radialB, inf * 0.6);

        // Tangential spiral component (simulates galactic motion of the star system)
        const tangential = new THREE.Vector3(-radialB.z, radialB.y * 0.2, radialB.x).normalize();
        V.addScaledVector(tangential, inf * 0.45);
      }
    }

    // 3. Global galaxy-drift vector (entire star system moving through the galaxy)
    V.add(new THREE.Vector3(0.6, 0.3, -0.4));

    return V;
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
