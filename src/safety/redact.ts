const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => secret.length >= 6))];
  return (text: string) => {
    let out = text;
    for (const secret of values) {
      out = out.split(secret).join("[REDACTED]");
    }
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]");
    out = out.replace(/\b(?:sk|xai|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
    return out;
  };
}

export function secretValuesFromEnv(names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    if (!SECRET_NAME.test(name)) continue;
    const value = process.env[name];
    if (value && value.length >= 6) values.push(value);
  }
  return values;
}

export const BASE_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS",
] as const;

export function allowlistedEnv(extraNames: readonly string[]): {
  env: NodeJS.ProcessEnv;
  secrets: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const secrets: string[] = [];
  for (const name of extraNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Refusing environment variable with an unsafe name: ${name}`);
    }
    const value = process.env[name];
    if (value === undefined) continue;
    env[name] = value;
    if (SECRET_NAME.test(name) && value.length >= 6) secrets.push(value);
  }
  return { env, secrets };
}
