import { registerDeepSeekProviderPlugin } from './deepseek/index.js';

let defaultsRegistered = false;

export function registerDefaultProviderPlugins(): void {
  if (defaultsRegistered) {
    return;
  }

  registerDeepSeekProviderPlugin();

  defaultsRegistered = true;
}
