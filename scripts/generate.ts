import { generate } from '@graphql-codegen/cli';
import config from '../codegen.ts';

// The graphql-codegen CLI loads this config with ts-node. TypeScript 7 is ESM-only
// and does not expose ts.sys, so that loader crashes. Bun imports the config directly.
await generate(config, true);
