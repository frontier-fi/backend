-- Remove ERC4626 classification for tokens whose underlying asset is the native gas token sentinel
-- (e.g. shMON on MONAD), which is not an ERC-20 contract and cannot be stored in PrismaToken or used in V3 buffers.
DELETE FROM "PrismaTokenType" tt
USING "PrismaToken" t
WHERE tt."tokenAddress" = t."address"
  AND tt."chain" = t."chain"
  AND tt."type" = 'ERC4626'
  AND LOWER(t."underlyingTokenAddress") = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

UPDATE "PrismaToken"
SET "underlyingTokenAddress" = NULL,
    "unwrapRate" = '1',
    "maxDeposit" = '0',
    "maxWithdraw" = '0',
    "bufferBalanceUnderlying" = '0',
    "bufferBalanceWrapped" = '0'
WHERE LOWER("underlyingTokenAddress") = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
