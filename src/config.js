/**
 * Config Loader
 * Compatible with all Node.js versions
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configPath = join(__dirname, '..', 'config', 'rpcs.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

export default config;