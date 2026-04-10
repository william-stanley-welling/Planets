// ─── celestial.factory.ts ─────────────────────────────────────────────────────

/**
 * @fileoverview Generic abstract factory for constructing celestial body scene objects.
 * @module celestial.factory
 */

import { CelestialBody, CelestialConfig } from './celestial.model';

/**
 * Abstract factory base class.
 *
 * Implementors are responsible for loading textures, creating Three.js meshes,
 * and returning a fully initialised `CelestialBody` subclass.
 *
 * @template T Config type (must extend `CelestialConfig`).
 * @template U Return type (must extend `CelestialBody`).
 *
 * @abstract
 *
 * @example
 * ```typescript
 * @Injectable({ providedIn: 'root' })
 * export class PlanetFactory extends CelestialFactory<PlanetConfig, Planet> {
 *   async build(config: PlanetConfig): Promise<Planet> { ... }
 * }
 * ```
 */
export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {
  /**
   * Asynchronously constructs a `CelestialBody` from a configuration object.
   *
   * @param {T} config - Body configuration, including texture paths and orbital elements.
   * @returns {Promise<U>} Resolves with the fully built body.
   */
  abstract build(config: T): Promise<U>;
}
