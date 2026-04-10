import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { TextureService } from '../webgl/texture.service';
import { Planet, PlanetConfig } from './planet.model';

@Injectable({ providedIn: 'root' })
export class PlanetFactory {
  constructor(private textureService: TextureService) { }

  async buildPlanet(prop: any): Promise<Planet> {
    const texturePaths = [
      prop.map || '',
      prop.bumpMap || '',
      prop.specMap || '',
      prop.cloudMap || '',
      prop.alphaMap || '',
    ];
    const textures = await this.textureService.loadMultipleTextures(texturePaths);
    const planet = new Planet(prop as PlanetConfig);
    const baseColor = prop.color ? new THREE.Color(prop.color) : new THREE.Color(0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      map: textures[0]?.image ? textures[0] : undefined,
      bumpMap: textures[1]?.image ? textures[1] : undefined,
      bumpScale: 0.25,
      specularMap: textures[2]?.image ? textures[2] : undefined,
      specular: new THREE.Color(0x555555),
      shininess: 10,
      emissive: textures[0]?.image ? new THREE.Color(0x000000) : baseColor.clone().multiplyScalar(0.3),
      emissiveIntensity: 0.8,
    });

    planet.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(prop.diameter || 2, prop.widthSegments || 64, prop.heightSegments || 64),
      material,
    );
    planet.mesh.castShadow = true;
    planet.mesh.receiveShadow = true;
    planet.mesh.name = prop.name || 'Planet';

    planet.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(prop.diameter * 1.08, 64, 64),
      new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.4, side: THREE.BackSide }),
    );
    planet.highlight.visible = false;

    if (prop.cloudMap && textures[3]?.image) {
      planet.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(prop.diameter + (prop.atmosphere || 0), 64, 64),
        new THREE.MeshPhongMaterial({
          map: textures[3],
          alphaMap: textures[4]?.image ? textures[4] : undefined,
          side: THREE.DoubleSide,
          opacity: 0.85,
          transparent: true,
          depthWrite: false,
        }),
      );
      planet.clouds.name = `${prop.name || 'Planet'}_clouds`;
    }

    planet.orbitalGroup.add(planet.mesh);
    planet.orbitalGroup.add(planet.highlight);
    if (planet.clouds) planet.orbitalGroup.add(planet.clouds);
    planet.mass = prop.mass * Math.pow(10, prop.pow || 0);
    return planet;
  }
}
