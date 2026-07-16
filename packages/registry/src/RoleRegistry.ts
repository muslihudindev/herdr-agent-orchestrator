import { PlatformConfig, RoleConfig, RoleName } from "../../shared/src/types";

export class RoleRegistry {
  constructor(private readonly config: PlatformConfig) {}

  get(role: RoleName): RoleConfig {
    return this.config.roles[role];
  }

  providerFor(role: RoleName): string {
    return this.get(role).provider;
  }

  replicasFor(role: RoleName): number {
    return this.get(role).replicas;
  }
}
