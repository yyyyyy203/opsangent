import type { ImpactSurfaceAssessment, ImpactSurfaceProvider } from '../contracts/index.js';

/** Explicit fallback used when no live impact data source has been configured. */
export class UnavailableImpactSurfaceProvider implements ImpactSurfaceProvider {
  public capture(): Promise<ImpactSurfaceAssessment> {
    return Promise.resolve({
      status: 'unavailable',
      reasonCode: 'impact_provider_unconfigured',
      evidenceIds: [],
    });
  }
}
