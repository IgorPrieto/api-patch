// Blocks `npm publish` of a prerelease under the default `latest` dist-tag (npm ignores publishConfig.tag).
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.npm_config_tag || 'latest';
if (version.includes('-') && tag === 'latest') {
  console.error(`Refusing to publish prerelease ${version} as "latest". Use: npm publish --tag beta`);
  process.exit(1);
}
console.log(`Publishing ${version} with dist-tag "${tag}".`);
