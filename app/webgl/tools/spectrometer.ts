import { Star } from 'app/galaxy/star.model';
import * as THREE from 'three';

export class Spectrometer {
  private spectroscopyLine: THREE.LineSegments;

  constructor(private scene: THREE.Scene) {
    this.buildSpectroscopyLines();
  }

  toggle(): void {
    if (this.spectroscopyLine) {
      this.spectroscopyLine.visible = !this.spectroscopyLine.visible;
    }
  }

  update(star: Star): void {
    if (!star) return;

    const lines: THREE.Vector3[] = [];

    const sunPos = new THREE.Vector3(0, 0, 0);

    for (const planet of star.satellites) {
      const pwp = this.getWorldPos(planet);
      lines.push(sunPos.clone(), pwp);
      for (const moon of planet.satellites) {
        const mwp = this.getWorldPos(moon);
        lines.push(pwp, mwp);
        lines.push(sunPos.clone(), mwp);
      }
    }

    const positions = new Float32Array(lines.length * 3);
    let i = 0;
    for (const p of lines) {
      positions[i++] = p.x;
      positions[i++] = p.y;
      positions[i++] = p.z;
    }

    this.spectroscopyLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
  }

  private buildSpectroscopyLines(): void {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.45,
      linewidth: 2.5,
    });
    this.spectroscopyLine = new THREE.LineSegments(geometry, material);
    this.scene.add(this.spectroscopyLine);

    this.spectroscopyLine.visible = false;
  }

  private getWorldPos(body: any): THREE.Vector3 {
    const pos = new THREE.Vector3();
    const group = body.orbitalGroup ?? body.group;
    if (group) group.getWorldPosition(pos);
    return pos;
  }

}
