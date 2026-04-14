import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, SIMULATION_CONSTANTS, VISUAL_SCALE } from './celestial.model';
import { Comet } from './comet.model';

@Injectable({ providedIn: 'root' })
export class CometFactory extends CelestialFactory<CometConfig, Comet> {
  constructor(private textureService: AssetTextureService) { super(); }

  async build(config: CometConfig): Promise<Comet> {
    const textures = await this.textureService.loadMultipleTextures([config.map || '']);
    const comet = new Comet(config);

    // Boost comet size dramatically for visibility
    const COMET_VISUAL_BOOST = 2000; // adjust as needed
    const visualRadius = Math.max(
      3.0, // minimum size in scene units
      (config.diameter / 2) * VISUAL_SCALE * COMET_VISUAL_BOOST
    );

    // Nucleus mesh
    const material = new THREE.MeshStandardMaterial({
      color: config.color || 0xcccccc,
      map: textures[0]?.image ? textures[0] : undefined,
      roughness: 0.8,
      emissive: new THREE.Color(0x444444),
    });
    comet.mesh = new THREE.Mesh(new THREE.SphereGeometry(visualRadius, 16, 16), material);
    comet.mesh.castShadow = true;
    comet.mesh.receiveShadow = true;

    // Coma (glow) – scale relative to nucleus
    const comaSize = config.comaSize || 4;
    const comaMat = new THREE.MeshPhongMaterial({
      color: 0xaaccff,
      transparent: true,
      opacity: 0.25,
      emissive: new THREE.Color(0x88aaff),
    });
    comet.comaMesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * comaSize, 24, 24),
      comaMat
    );

    // Tail – keep proportional to nucleus size
    const tailLength = (config.tailLength || 0.5) * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const tailGeom = new THREE.ConeGeometry(visualRadius * 0.6, tailLength, 8);
    const tailMat = new THREE.MeshPhongMaterial({
      color: config.tailColor || 0xccddff,
      transparent: true,
      opacity: 0.35,
      emissive: new THREE.Color(0xaaccff),
      side: THREE.DoubleSide,
    });
    comet.tailMesh = new THREE.Mesh(tailGeom, tailMat);
    comet.tailMesh.position.y = -tailLength / 2;

    // Add to orbital group
    comet.orbitalGroup.add(comet.mesh);
    comet.orbitalGroup.add(comet.comaMesh);
    comet.orbitalGroup.add(comet.tailMesh);

    // Magnetic field if configured
    if ((config as any).magneticField) {
      comet.createMagneticFieldVisualization();
    }

    return comet;
  }
}