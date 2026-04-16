import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { SIMULATION_CONSTANTS } from './celestial.model';
import { Moon, MoonConfig } from './moon.model';

@Injectable({ providedIn: 'root' })
export class MoonFactory extends CelestialFactory<MoonConfig, Moon> {
  constructor(private textureService: AssetTextureService) {
    super();
  }

  async build(config: MoonConfig): Promise<Moon> {
    const texturePaths = [
      config.map || '',
      config.bumpMap || '',
      config.specMap || '',
      config.cloudMap || '',
      config.alphaMap || '',
    ];
    const textures = await this.textureService.loadMultipleTextures(texturePaths);
    const moon = new Moon(config);
    const baseColor = config.color ? new THREE.Color(config.color) : new THREE.Color(0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      bumpScale: 0.12,
      specular: new THREE.Color(0x222222),
      shininess: 6,
      emissive: textures[0]?.image ? new THREE.Color(0x000000) : baseColor.clone().multiplyScalar(0.6),
      emissiveIntensity: 0.8,
      ...(textures[0]?.image && { map: textures[0] }),
      ...(textures[1]?.image && { bumpMap: textures[1] }),
      ...(textures[2]?.image && { specularMap: textures[2] }),
    });

    moon.orbitalGroup.add(new THREE.PointLight(0xffffff, 0.5, 0, 1));

    const visualRadius = (config.diameter || 1) * SIMULATION_CONSTANTS.VISUAL_SCALE / 2;

    const wSeg = config.widthSegments || 32;
    const hSeg = config.heightSegments || 32;
    moon.mesh = new THREE.Mesh(new THREE.SphereGeometry(visualRadius, wSeg, hSeg), material);
    moon.mesh.name = config.name || 'Moon';

    moon.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * 1.30, wSeg, hSeg),
      new THREE.MeshBasicMaterial({
        color: 0x44ffcc,
        transparent: true,
        opacity: 0.70,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    moon.highlight.visible = false;

    if (config.cloudMap && textures[3]?.image) {
      moon.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius + (config.atmosphere || 0.001), wSeg, hSeg),
        new THREE.MeshPhongMaterial({
          map: textures[3],
          alphaMap: textures[4]?.image ? textures[4] : undefined,
          side: THREE.DoubleSide,
          opacity: 0.7,
          transparent: true,
          depthWrite: false,
        }),
      );
      moon.clouds.name = `${config.name || 'Moon'}_clouds`;
    }

    moon.applyInitialTilt();

    moon.orbitalGroup.add(moon.mesh);
    moon.orbitalGroup.add(moon.highlight);
    if (moon.clouds) moon.orbitalGroup.add(moon.clouds);
    moon.mass = (config.mass || 1) * Math.pow(10, config.pow || 0);

    const latLong = this.createLatLongLines(visualRadius);
    moon.mesh.add(latLong);
    moon.latLongGroup = latLong;

    if ((config as any).magneticField) {

    }

    return moon;
  }
}
