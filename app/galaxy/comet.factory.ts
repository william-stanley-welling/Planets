import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, SIMULATION_CONSTANTS } from './celestial.model';
import { Comet } from './comet.model';

@Injectable({ providedIn: 'root' })
export class CometFactory extends CelestialFactory<CometConfig, Comet> {
  constructor(private textureService: AssetTextureService) { super(); }

  async build(config: CometConfig): Promise<Comet> {
    const comet = new Comet(config);

    let visualRadius = (config.diameter || 1) * SIMULATION_CONSTANTS.VISUAL_SCALE / 2;

    if ((config.diameter || 1) < .25) {
      visualRadius = .25;
    }

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
    comet.orbitalGroup.add(comet.mesh);


    comet.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * 1.3, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x44ffcc, transparent: true, opacity: 0.7, side: THREE.BackSide })
    );
    comet.highlight.visible = false;
    comet.orbitalGroup.add(comet.highlight);

    const particleCount = 1800;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
      size: visualRadius * 1.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    comet.tailParticles = new THREE.Points(geo, mat);
    comet.orbitalGroup.add(comet.tailParticles);

    comet.previousPositions = [];

    const latLong = this.createLatLongLines(visualRadius);
    comet.mesh.add(latLong);
    comet.latLongGroup = latLong;

    if ((config as any).magneticField) {

    }

    return comet;
  }
}