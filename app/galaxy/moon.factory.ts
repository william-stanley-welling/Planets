import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
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
      map: textures[0]?.image ? textures[0] : undefined,
      bumpMap: textures[1]?.image ? textures[1] : undefined,
      bumpScale: 0.12,
      specularMap: textures[2]?.image ? textures[2] : undefined,
      specular: new THREE.Color(0x222222),
      shininess: 6,
      emissive: textures[0]?.image
        ? new THREE.Color(0x000000)
        : baseColor.clone().multiplyScalar(0.6),
      emissiveIntensity: 0.8,
    });

    // Small fill-light keeps moons visible far from the star.
    moon.orbitalGroup.add(new THREE.PointLight(0xffffff, 0.5, 0, 1));

    // TODO: remove debugScale once moon diameter configs are calibrated to
    //       match the visual scale of planets (currently planets render much larger).
    const debugScale = 5;
    const visualDiam = (config.diameter || 1) * debugScale;

    moon.mesh = new THREE.Mesh(new THREE.SphereGeometry(visualDiam, 32, 32), material);
    moon.mesh.name = config.name || 'Moon';

    // ── Selection highlight halo ──────────────────────────────────────────────
    // Teal (0x44ffcc) distinguishes moon halos from the blue planet halos.
    // Scale 1.30× accounts for the debug scale factor so the halo remains
    // proportional to the visible mesh.
    moon.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualDiam * 1.30, 32, 32),
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
        new THREE.SphereGeometry(visualDiam + (config.atmosphere || 0.001), 32, 32),
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

    moon.orbitalGroup.add(moon.mesh);
    moon.orbitalGroup.add(moon.highlight);
    if (moon.clouds) moon.orbitalGroup.add(moon.clouds);
    moon.mass = (config.mass || 1) * Math.pow(10, config.pow || 0);
    return moon;
  }
}
