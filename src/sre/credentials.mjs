// Select the configured token source without returning credential values.
// Validation and live permission checks belong to their respective callers.
export function selectTokenMode(config,env={}) {
  return config.tokenEnv&&env[config.tokenEnv]?'static-token':config.oauth?'oauth':'static-token';
}
