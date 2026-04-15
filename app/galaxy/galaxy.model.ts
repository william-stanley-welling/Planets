import * as THREE from 'three';

export interface GalaxyConfig {
  seed?: number;
  arms?: number;
  starsCount?: number;
  radius?: number;
  spiralTightness?: number;
  armSpread?: number;
  coreSize?: number;
}

export class Galaxy {
  config: GalaxyConfig;
  points: THREE.Points;
  stars: THREE.Vector3[] = []; // positions for raycasting

  constructor(config: GalaxyConfig, points: THREE.Points, stars: THREE.Vector3[]) {
    this.config = config;
    this.points = points;
    this.stars = stars;
  }
}
