import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { VISUAL_SCALE } from './celestial.model';
import { Planet, PlanetConfig } from './planet.model';

@Injectable({ providedIn: 'root' })
export class PlanetFactory extends CelestialFactory<PlanetConfig, Planet> {
  constructor(private textureService: AssetTextureService) {
    super();
  }

  async build(config: PlanetConfig): Promise<Planet> {
    const texturePaths = [
      config.map || '',
      config.bumpMap || '',
      config.specMap || '',
      config.cloudMap || '',
      config.alphaMap || '',
    ];
    const textures = await this.textureService.loadMultipleTextures(texturePaths);
    const planet = new Planet(config);
    const baseColor = config.color ? new THREE.Color(config.color) : new THREE.Color(0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      bumpScale: 0.25,
      specular: new THREE.Color(0x555555),
      shininess: 10,
      emissive: textures[0]?.image ? new THREE.Color(0x000000) : baseColor.clone().multiplyScalar(0.3),
      emissiveIntensity: 0.8,
      ...(textures[0]?.image && { map: textures[0] }),
      ...(textures[1]?.image && { bumpMap: textures[1] }),
      ...(textures[2]?.image && { specularMap: textures[2] }),
    });

    const visualDiameter = config.diameter * VISUAL_SCALE;
    planet.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualDiameter, config.widthSegments || 64, config.heightSegments || 64),
      material
    );
    planet.mesh.castShadow = true;
    planet.mesh.receiveShadow = true;
    planet.mesh.name = config.name || 'Planet';

    planet.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualDiameter * 1.22, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0x44aaff,
        transparent: true,
        opacity: 0.65,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    planet.highlight.visible = false;

    if (config.cloudMap && textures[3]?.image) {
      planet.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(config.diameter + (config.atmosphere || 0), 64, 64),
        new THREE.MeshPhongMaterial({
          map: textures[3],
          alphaMap: textures[4]?.image ? textures[4] : undefined,
          side: THREE.DoubleSide,
          opacity: 0.85,
          transparent: true,
          depthWrite: false,
        }),
      );
      planet.clouds.name = `${config.name || 'Planet'}_clouds`;
    }

    planet.applyInitialTilt();
    planet.addDebugAxisLine();

    planet.orbitalGroup.add(planet.mesh);
    planet.orbitalGroup.add(planet.highlight);
    if (planet.clouds) planet.orbitalGroup.add(planet.clouds);
    planet.mass = config.mass * Math.pow(10, config.pow || 0);

    if ((config as any).magneticField) {
      planet.createMagneticFieldVisualization();
    }

    return planet;
  }
}
