import { generate } from '@graphql-codegen/cli';
import config from '../codegen';

// The graphql-codegen CLI loads this config with ts-node. TypeScript 7 is ESM-only
// and does not expose ts.sys, so that loader crashes. Bun imports the config directly.
async function main() {
    await generate(config, true);
}

void main();
