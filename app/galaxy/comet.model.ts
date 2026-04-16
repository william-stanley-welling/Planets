import * as THREE from 'three';
import { OrbitingBody, SIMULATION_CONSTANTS } from './celestial.model';

export class Comet extends OrbitingBody {
  tailParticles: THREE.Points | null = null;
  previousPositions: THREE.Vector3[] = [];
  maxTrailPoints = 250;

  constructor(config: any) {
    super(config);
  }

  updateTail(sunPos: THREE.Vector3): void {
    if (!this.tailParticles) return;

    const headPos = this.orbitalGroup.position.clone();
    this.previousPositions.unshift(headPos.clone());
    if (this.previousPositions.length > this.maxTrailPoints) this.previousPositions.pop();

    const distAU = headPos.distanceTo(sunPos) / SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const targetLength = Math.max(80, 280 * (distAU / 12)); // longer when far out
    const density = Math.max(0.3, Math.min(1, distAU / 15)); // thinner near sun

    const posAttr = this.tailParticles.geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = this.tailParticles.geometry.attributes.color as THREE.BufferAttribute;
    const sizeAttr = this.tailParticles.geometry.attributes.size as THREE.BufferAttribute;

    let idx = 0;
    const active = Math.floor(Math.min(this.previousPositions.length, targetLength));

    for (let i = 0; i < active; i++) {
      const p = this.previousPositions[i];
      const dirToNext = i < active - 1
        ? this.previousPositions[i + 1].clone().sub(p).normalize()
        : new THREE.Vector3(0, 0, 1);

      const perp = new THREE.Vector3().crossVectors(dirToNext, new THREE.Vector3(0, 1, 0)).normalize();
      if (perp.lengthSq() < 0.01) perp.set(1, 0, 0);

      const spread = (i / active) * 12 * density; // widens into cone shape
      const offset = perp.multiplyScalar(Math.sin(i * 0.3) * spread + (Math.random() - 0.5) * 2);

      posAttr.setXYZ(idx, p.x + offset.x, p.y + offset.y, p.z + offset.z);

      const fade = (1 - i / active) * density;
      colorAttr.setXYZ(idx, 0.7 * fade, 0.85 * fade, 1 * fade);
      sizeAttr.setX(idx, 0.6 + Math.random() * 1.8 * (1 - i / active));

      idx++;
    }

    // hide unused particles
    for (let i = idx; i < posAttr.count; i++) {
      sizeAttr.setX(i, 0);
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }
}
