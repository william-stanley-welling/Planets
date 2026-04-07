import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { TextureService } from '../webgl/texture.service';
import { Planet, PlanetConfig } from './planet.model';

@Injectable({ providedIn: 'root' })
export class PlanetFactory {
  constructor(private textureService: TextureService) { }

  async buildPlanet(prop: any): Promise<Planet> {
    const textures = await this.textureService.loadMultipleTextures([
      prop.map,
      prop.bumpMap,
      prop.specMap,
      prop.cloudMap,
      prop.alphaMap
    ]);

    const planet = new Planet(prop as PlanetConfig);

    planet.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(prop.diameter, prop.widthSegments, prop.heightSegments),
      new THREE.MeshPhongMaterial({
        color: 0xaaaaaa,
        map: textures[0],
        bumpMap: textures[1],
        bumpScale: 0.25,
        specularMap: textures[2],
        specular: new THREE.Color('grey'),
        shininess: 10
      })
    );
    planet.mesh.castShadow = planet.mesh.receiveShadow = true;
    planet.mesh.name = prop.name;

    planet.group.add(planet.mesh);

    // planet.highlight = new THREE.Mesh(
    //   new THREE.SphereGeometry(prop.diameter + (prop.atmosphere || 0) + 0.005, prop.widthSegments, prop.heightSegments),
    //   new THREE.MeshLambertMaterial({ color: 0x00aaff, opacity: 0.3, transparent: true, depthWrite: false })
    // );
    // planet.highlight.name = `${prop.name}_highlight`;
    // planet.highlight.visible = true;


    planet.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(prop.diameter * 1.05, prop.widthSegments, prop.heightSegments),
      new THREE.MeshBasicMaterial({
        color: 0x00aaff,
        transparent: true,
        opacity: 0.5,      // Increased opacity
        side: THREE.BackSide // Shows a "halo" around the edges
      })
    );
    planet.highlight.visible = false; // Start hidden


    planet.group.add(planet.highlight);

    planet.spotLight = new THREE.SpotLight(0xffffff, 1.2, 0, Math.PI / 3, 0.8);
    planet.spotLight.castShadow = true;
    planet.spotLight.shadow.camera.near = 0.1;
    planet.spotLight.target = planet.mesh;
    planet.group.add(planet.spotLight);

    if (prop.cloudMap && textures[3]) {
      planet.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(prop.diameter + (prop.atmosphere || 0), prop.widthSegments, prop.heightSegments),
        new THREE.MeshPhongMaterial({
          map: textures[3],
          alphaMap: textures[4],
          side: THREE.DoubleSide,
          opacity: 0.85,
          transparent: true,
          depthWrite: false
        })
      );
      planet.clouds.castShadow = false;
      planet.clouds.receiveShadow = false;
      planet.group.add(planet.clouds);
    }

    planet.mass = prop.mass * Math.pow(10, prop.pow || 0);

    // REMOVED: planet.group.position.set(...) 
    // In heliocentric design position is now set every frame by revolve() using Keplerian orbit (relative to parent group).
    // This works for both planets (around Sun) and moons (around planets).

    return planet;
  }

  /**
   * Moons are fully supported via the same Satellite abstraction (OrbitingBody).
   * buildMoon() can be added identically to buildPlanet() — just instantiate Moon instead of Planet.
   * The Keplerian revolve logic and THREE.Group hierarchy are identical.
   */
}
