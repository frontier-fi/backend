-- Reset V3 subgraph sync watermarks so the worker automatically reloads
-- all V3 pools, dynamic data, and BPT balances from the redeployed subgraphs.
DELETE FROM "PrismaLastBlockSynced"
WHERE "category" IN ('ADD_POOLS_V3', 'POOLS_V3', 'BPT_BALANCES_V3');
