import { join } from 'path';
import * as fs from 'fs';
import YAML from 'yamljs';
import { configSchema, type Config } from './config_schema';

function loadYaml(filename: string) {
  const path = join('config', filename);

  if (fs.existsSync(path)) {
    return YAML.load(path);
  }

  throw new Error(`Config file not found: ${path}`);
}

export function getConfig(): Config {
  const raw = loadYaml('config.yaml');
  return configSchema.parse(raw);
}
