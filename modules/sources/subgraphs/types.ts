import { V3VaultSubgraphClient } from './vault';

export type UserBalancesSubgraphClient = Pick<V3VaultSubgraphClient, 'lastSyncedBlock' | 'getAllPoolSharesWithBalance'>;
