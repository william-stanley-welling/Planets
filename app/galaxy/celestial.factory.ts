import { CelestialBody, CelestialConfig } from './celestial.model';
import * as THREE from 'three';


export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {

  abstract build(config: T): Promise<U>;

  createLatLongLines(radius: number): THREE.Group {
    const group = new THREE.Group();
    const lineRadius = radius * 1.001;

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x88ff88,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
      depthWrite: false,
    });

    // Latitudes
    for (let lat = -80; lat <= 80; lat += 20) {
      const latRad = lat * Math.PI / 180;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) {
        const lng = i * 2 * Math.PI / 64;
        pts.push(new THREE.Vector3(
          lineRadius * Math.cos(latRad) * Math.cos(lng),
          lineRadius * Math.sin(latRad),
          lineRadius * Math.cos(latRad) * Math.sin(lng)
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(geo, lineMat));
    }

    // Meridians
    for (let lng = 0; lng < 360; lng += 30) {
      const lngRad = lng * Math.PI / 180;
      const pts: THREE.Vector3[] = [];
      for (let i = -16; i <= 16; i++) {
        const lat = i * Math.PI / 16;
        pts.push(new THREE.Vector3(
          lineRadius * Math.cos(lat) * Math.cos(lngRad),
          lineRadius * Math.sin(lat),
          lineRadius * Math.cos(lat) * Math.sin(lngRad)
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(geo, lineMat));
    }

    group.renderOrder = 5;

    group.visible = false;

    return group;
  }

}
