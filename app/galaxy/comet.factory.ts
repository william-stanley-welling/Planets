import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, VISUAL_SCALE } from './celestial.model';
import { Comet } from './comet.model';

@Injectable({ providedIn: 'root' })
export class CometFactory extends CelestialFactory<CometConfig, Comet> {
  constructor(private textureService: AssetTextureService) { super(); }

  async build(config: CometConfig): Promise<Comet> {
    const comet = new Comet(config);

    // Simple visible nucleus (bright glowing ball)
    const visualRadius = Math.max(4.0, (config.diameter || 0.00006) * VISUAL_SCALE * 800);

    const material = new THREE.MeshPhongMaterial({
      color: config.color || 0xd4c9a8,
      emissive: new THREE.Color(0xffeecc),
      emissiveIntensity: 1.2,
      shininess: 10,
    });

    comet.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius, 24, 24),
      material
    );
    comet.mesh.castShadow = true;
    comet.mesh.receiveShadow = true;
    comet.mesh.name = config.name || 'Comet';

    // Add to orbital group
    comet.orbitalGroup.add(comet.mesh);

    // comet.factory.ts – inside build()
    const tailPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)]; // placeholder
    const tailGeo = new THREE.BufferGeometry().setFromPoints(tailPoints);
    const tailMat = new THREE.LineBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.7 });
    const tailLine = new THREE.Line(tailGeo, tailMat);
    comet.tail = tailLine;
    comet.orbitalGroup.add(tailLine);

    comet.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * 1.3, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x44ffcc, transparent: true, opacity: 0.7, side: THREE.BackSide })
    );
    comet.highlight.visible = false;
    comet.orbitalGroup.add(comet.highlight);

    return comet;
  }
}