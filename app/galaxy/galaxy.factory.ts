import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { Galaxy, GalaxyConfig } from './galaxy.model';

@Injectable({ providedIn: 'root' })
export class GalaxyFactory {
  build(config: GalaxyConfig = {}): Galaxy {
    const {
      seed = 12345,
      arms = 4,
      starsCount = 10_000,
      radius = 500000,
      spiralTightness = 7.0,
      armSpread = 0.25,
      coreSize = 13000
    } = config;

    const rng = this.mulberry32(seed);
    const positions: number[] = [];
    const colors: number[] = [];

    for (let i = 0; i < starsCount; i++) {
      // Spiral arm generation
      const armIndex = i % arms;
      const armAngleOffset = (armIndex / arms) * Math.PI * 2;

      // Radial distribution: more stars in core and arms
      let r: number;
      if (rng() < 0.3) {
        // Core stars
        r = Math.pow(rng(), 1.5) * coreSize;
      } else {
        // Arm stars
        r = coreSize + Math.pow(rng(), 1.8) * (radius - coreSize);
      }

      // Spiral angle
      const spiralAngle = r * spiralTightness + armAngleOffset;
      const randomAngleOffset = (rng() - 0.5) * armSpread * (r / radius);
      const angle = spiralAngle + randomAngleOffset;

      // Height (thin disk with some warp)
      const h = (rng() - 0.5) * 200 * Math.sin(r * 0.01);

      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const y = h;

      positions.push(x, y, z);

      // Color based on temperature / type
      const temp = 3000 + rng() * 7000;
      const color = this.temperatureToColor(temp, rng);
      colors.push(color.r, color.g, color.b);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const points = new THREE.Points(geometry, material);

    // Store star positions for raycasting (simplified – we may use a spatial index)
    const starsVec: THREE.Vector3[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      starsVec.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
    }

    return new Galaxy(config, points, starsVec);
  }

  private mulberry32(a: number): () => number {
    return function () {
      a |= 0; a = a + 0x6d2b79f5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  private temperatureToColor(kelvin: number, rng: () => number): THREE.Color {
    // Simplified blackbody color
    const t = kelvin / 1000;
    let r, g, b;
    if (t <= 6.6) {
      r = 1.0;
      g = Math.max(0, Math.min(1, 0.5 * (t - 2.0)));
      b = Math.max(0, Math.min(1, 0.5 * (t - 4.0)));
    } else {
      r = Math.max(0, 1.0 - 0.5 * (t - 6.6));
      g = Math.max(0, 1.0 - 0.3 * (t - 6.6));
      b = 1.0;
    }
    // Add slight random variation
    return new THREE.Color(
      r * (0.8 + 0.4 * rng()),
      g * (0.8 + 0.4 * rng()),
      b * (0.8 + 0.4 * rng())
    );
  }
}
