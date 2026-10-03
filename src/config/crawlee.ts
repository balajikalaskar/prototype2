import { Configuration, type ConfigurationOptions } from '@crawlee/core';

/** Crawlee's default constructor probes crawlee.json synchronously; this API uses validated env settings. */
export class InMemoryConfiguration extends Configuration {
  protected override buildOptions(options: ConfigurationOptions): void {
    this.options = new Map();
    for (const key of Object.keys(options) as Array<keyof ConfigurationOptions>) {
      this.options.set(key, options[key]);
    }
  }
}
