import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { Galaxy, GalaxyConfig } from './galaxy.model';

@Injectable({ providedIn: 'root' })
export class GalaxyFactory {
  build(config: GalaxyConfig = {}): Galaxy {
    const {
      seed = 42,
      arms = 4,
      starsCount = 200_000,
      radius = 20,
      coreSize = 3.0,
      armSpread = 0.25,
      sunDistance = 10.0
    } = config;

    const SCALE = 5000;
    const rng = this.mulberry32(seed);
    const positions: number[] = [];
    const colors: number[] = [];
    const starVecs: THREE.Vector3[] = [];

    const armAngleOffset = (i: number) => (i / arms) * Math.PI * 2;
    const pitch = 0.22;
    const minRadius = coreSize;

    for (let i = 0; i < starsCount; i++) {
      const armIdx = i % arms;
      const armOffset = armAngleOffset(armIdx);

      let r: number;
      if (rng() < 0.25) {
        r = Math.pow(rng(), 1.5) * coreSize;
      } else {
        const scaleLength = 2.8;
        r = minRadius + (-Math.log(1 - rng() * 0.999) * scaleLength);
        if (r > radius) r = minRadius + rng() * (radius - minRadius);
      }

      const a = minRadius;
      const b = pitch;
      const logTerm = Math.log(r / a) / b;
      const spread = (rng() - 0.5) * armSpread * (r / radius) * 1.8;
      const theta = logTerm + armOffset + spread;

      const warp = Math.sin(r * 0.6) * 0.3 * SCALE;
      const h = (rng() - 0.5) * 0.2 * SCALE * (r / radius) + warp;

      const x = Math.cos(theta) * r * SCALE;
      const z = Math.sin(theta) * r * SCALE;
      const y = h;

      // Sun is at offset from center
      const sunOffsetX = sunDistance * SCALE;
      const finalX = x - sunOffsetX;

      positions.push(finalX, y, z);
      starVecs.push(new THREE.Vector3(finalX, y, z));

      const temp = 3200 + rng() * 6800;
      const color = this.temperatureToColor(temp, rng);
      colors.push(color.r, color.g, color.b);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.9,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const points = new THREE.Points(geometry, material);
    return new Galaxy(config, points, starVecs);
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
