import type { ChangeFreezePeriod, ImpactPolicy } from '../contracts/index.js';

/** Serializable source definition; resolver-owned digest/capture fields are intentionally absent. */
export interface ProfileDefinition {
  profileId: string;
  revision: string;
  serviceName: string;
  serviceLevel: 'S0' | 'S1' | 'S2' | 'S3';
  timezone: string;
  allowedActions: readonly string[];
  forbiddenActions: readonly string[];
  changeFreezePeriods: readonly ChangeFreezePeriod[];
  impactPolicy: ImpactPolicy;
  policyVersion: string;
}
