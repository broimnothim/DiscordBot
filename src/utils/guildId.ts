export function isValidSnowflake(v?: string): boolean {
  return !!v && /^\d{17,20}$/.test(v) && !/^0+$/.test(v);
}

export function resolveGuildId(configGuildId?: string, envGuildId?: string): string | undefined {
  if (isValidSnowflake(configGuildId)) return configGuildId;
  if (isValidSnowflake(envGuildId)) return envGuildId;
  return undefined;
}
