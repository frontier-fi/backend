import { generate } from '@graphql-codegen/cli';
import config from '../codegen.ts';

const generates = Object.fromEntries(
    Object.entries(config.generates).filter(([path]) => path.includes('apps/api/gql')),
);

await generate({ ...config, generates }, true);
