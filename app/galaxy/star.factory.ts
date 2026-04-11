import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { MoonConfig, PlanetConfig, StarConfig } from './celestial.model';
import { MoonFactory } from './moon.factory';
import { PlanetFactory } from './planet.factory';
import { Star } from './star.model';

/**
 * ~AI PROMPT~ Generate this and all comments within this file for complete compodoc.
 */
@Injectable({ providedIn: 'root' })
export class StarFactory extends CelestialFactory<StarConfig, Star> {
  constructor(
    private textureService: AssetTextureService,
    private planetFactory: PlanetFactory,
    private moonFactory: MoonFactory
  ) {
    super();
  }

  /*~AI PROMPT~ decompose into private methods, then generalize in abstract class celestial.factory.ts in which does the exact same thing.*/
  async build(config: StarConfig): Promise<Star> {
    const textures = await this.textureService.loadMultipleTextures([config.map || '']);
    const star = new Star(config);

    const sunMaterial = new THREE.MeshPhongMaterial({
      color: 0xffeecc,
      map: textures[0]?.image ? textures[0] : undefined,
      emissive: 0xffaa00,
      emissiveIntensity: 0.9,
      shininess: 0
    });

    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(config.diameter || 139.2, config.widthSegments || 128, config.heightSegments || 128),
      sunMaterial
    );
    star.mesh.name = config.name || 'Sun';
    star.group.add(star.mesh);

    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    const extraAmbient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(extraAmbient);

    return star;
  }

  /**
   * ~AI PROMPT~: Move this to celestial.factory.ts.
   * 
   * @param planet 
   * @param satelliteConfigs 
   */
  async attachSatellites(star: Star, satelliteConfigs: PlanetConfig[] | MoonConfig[]): Promise<void> {
    for (const satConfig of satelliteConfigs) {
      if (satConfig.name?.toLowerCase() === 'sun') continue;

      const planet = await this.planetFactory.build(satConfig);
      star.addSatellite(planet);

      if (Array.isArray((satConfig as any).moons) && (satConfig as any).moons.length > 0) {
        for (const moonConfig of (satConfig as any).moons) {
          const moon = await this.moonFactory.build(moonConfig);
          planet.addSatellite(moon);
        }
      }
    }
  }

}
