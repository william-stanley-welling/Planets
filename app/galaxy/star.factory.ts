import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { TextureService } from '../webgl/texture.service';
import { PlanetFactory } from './planet.factory';
import { MoonFactory } from './moon.factory';
import { Star, StarConfig } from './star.model';

@Injectable({ providedIn: 'root' })
export class StarFactory {
  constructor(
    private textureService: TextureService,
    private planetFactory: PlanetFactory,
    private moonFactory: MoonFactory
  ) { }

  async buildStar(prop: StarConfig): Promise<Star> {
    const textures = await this.textureService.loadMultipleTextures([prop.map || '']);

    const star = new Star(prop);

    const sunMaterial = new THREE.MeshPhongMaterial({
      color: 0xffeecc,
      map: textures[0]?.image ? textures[0] : undefined,
      emissive: 0xffaa00,
      emissiveIntensity: 0.9,
      shininess: 0
    });

    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(prop.diameter || 139.2, prop.widthSegments || 128, prop.heightSegments || 128),
      sunMaterial
    );

    star.mesh.name = prop.name || 'Sun';
    star.group.add(star.mesh);

    // Strong point light for the Sun
    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    // Extra ambient to help when textures fail
    const extraAmbient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(extraAmbient);

    return star;
  }

  async attachSatellites(star: Star, satelliteProps: any[]): Promise<void> {
    for (const satProp of satelliteProps) {
      if (satProp.name?.toLowerCase() === 'sun') continue;

      const planet = await this.planetFactory.buildPlanet(satProp);
      star.addSatellite(planet);

      if (Array.isArray(satProp.moons) && satProp.moons.length > 0) {
        for (const moonProp of satProp.moons) {
          const moon = await this.moonFactory.buildMoon(moonProp);
          planet.addSatellite(moon);
        }
      }
    }
  }
}
