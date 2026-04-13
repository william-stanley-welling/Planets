import { CelestialBody, CelestialConfig } from './celestial.model';

export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {

  abstract build(config: T): Promise<U>;

}
