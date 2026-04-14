import * as THREE from 'three';
import { OrbitingBody } from './celestial.model';

export class Comet extends OrbitingBody {
  tail?: THREE.LineSegments | THREE.Points;
  tailLength = 0.5;  // configurable
  previousPositions: THREE.Vector3[] = [];
  maxTrailPoints = 30;

  updateTail() {
    if (!this.tail) return;
    const currentPos = this.orbitalGroup.position.clone();
    this.previousPositions.unshift(currentPos);
    if (this.previousPositions.length > this.maxTrailPoints) this.previousPositions.pop();

    const points = this.previousPositions.map(p => p.clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    (this.tail as THREE.LineSegments).geometry.dispose();
    (this.tail as THREE.LineSegments).geometry = geometry;
  }
}

export { PlanetConfig, SIMULATION_CONSTANTS } from './celestial.model';
