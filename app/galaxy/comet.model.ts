import * as THREE from 'three';
import { CometConfig, OrbitingBody } from './celestial.model';

export class Comet extends OrbitingBody {
  tailMesh?: THREE.Mesh;
  comaMesh?: THREE.Mesh;
  dustTailMesh?: THREE.Mesh;
  ionTailMesh?: THREE.Mesh;

  constructor(config: CometConfig) {
    super(config);
    this.config = config;
  }

  updateHierarchy(simTime: number): void {
    super.updateHierarchy(simTime);
    if (this.tailMesh) {
      const worldPos = new THREE.Vector3();
      this.orbitalGroup.getWorldPosition(worldPos);
      const dirToSun = worldPos.clone().negate().normalize();
      this.tailMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirToSun);
    }
  }
}

export { PlanetConfig, SIMULATION_CONSTANTS } from './celestial.model';
