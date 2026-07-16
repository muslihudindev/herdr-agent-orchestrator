import { ProviderConfig } from "../../shared/src/types";
import { Provider } from "./Provider";
import { ProcessProvider } from "./ProcessProvider";
import { SimulatedProvider } from "./SimulatedProvider";

export type ProviderFactory = (name: string, config: ProviderConfig) => Provider;

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly factories = new Map<string, ProviderFactory>();

  constructor() {
    this.registerFactory("simulated", (name, config) => new SimulatedProvider(name, config));
    this.registerFactory("process", (name, config) => new ProcessProvider(name, config));
  }

  registerFactory(type: string, factory: ProviderFactory): void {
    this.factories.set(type, factory);
  }

  configure(configs: Record<string, ProviderConfig>): void {
    for (const [name, config] of Object.entries(configs)) {
      const factory = this.factories.get(name) ?? this.factories.get("process");
      if (!factory) throw new Error(`No provider factory available for ${name}`);
      this.providers.set(name, factory(name, config));
    }
  }

  get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider not registered: ${name}`);
    return provider;
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }
}
