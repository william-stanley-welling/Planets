import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, PlanetConfig, SIMULATION_CONSTANTS, StarConfig } from './celestial.model';
import { CometFactory } from './comet.factory';
import { MoonFactory } from './moon.factory';
import { PlanetFactory } from './planet.factory';
import { Star } from './star.model';

@Injectable({ providedIn: 'root' })
export class StarFactory extends CelestialFactory<StarConfig, Star> {
  constructor(
    private textureService: AssetTextureService,
    private planetFactory: PlanetFactory,
    private cometFactory: CometFactory,
    private moonFactory: MoonFactory
  ) {
    super();
  }

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

    const visualRadius = (config.diameter || 1) * SIMULATION_CONSTANTS.VISUAL_SCALE / 2;

    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius, config.widthSegments || 128, config.heightSegments || 128),
      sunMaterial
    );
    star.mesh.name = config.name || 'Sun';
    star.group.add(star.mesh);

    star.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius * 1.18, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffdd44,
        transparent: true,
        opacity: 0.55,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    star.highlight.visible = false;
    star.group.add(star.highlight);

    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);

    const extraAmbient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(extraAmbient);

    star.applyInitialTilt();

    const latLong = this.createLatLongLines(visualRadius);
    star.mesh.add(latLong);
    star.latLongGroup = latLong;

    if ((config as any).magneticField) {

    }

    return star;
  }

  async attachSatellites(star: Star, satelliteConfigs: PlanetConfig[] | CometConfig[]): Promise<void> {
    for (const satConfig of satelliteConfigs) {
      if (satConfig.name?.toLowerCase() === 'sun') continue;

      if (satConfig.name?.toLowerCase() === 'halley' || satConfig.name?.toLowerCase() === 'hale-bopp') {
        const comet = await this.cometFactory.build(satConfig);
        star.addSatellite(comet);
      } else {

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
}
