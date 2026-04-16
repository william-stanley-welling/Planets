import * as THREE from 'three';
import { SIMULATION_CONSTANTS } from '../../galaxy/celestial.model';

export class Grid {
  private readonly GRID_RES = 32;
  private readonly GRID_HALF = Math.floor(this.GRID_RES / 2);
  private readonly GRID_STEP = 3 * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

  private gridPoints: THREE.Vector3[];
  private gridLines: THREE.LineSegments;

  constructor(private scene: THREE.Scene) {
    this.generateGridPoints();
    this.buildGridLines();
  }

  toggle(): void {
    if (this.gridLines) {
      this.gridLines.visible = !this.gridLines.visible;
    }
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
      for (let z = -half; z <= half; z += step) {
        positions.push(-half, y, z, half, y, z);
      }
    }
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        positions.push(x, -half, z, x, half, z);
      }
    }
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
      opacity: 0.09,
      linewidth: 1,
    });

    this.gridLines = new THREE.LineSegments(geometry, material);

    this.scene.add(this.gridLines);

    this.gridLines.visible = false;
  }
}
