-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('BASE', 'MAINNET', 'SEPOLIA');

-- CreateEnum
CREATE TYPE "PrismaLastBlockSyncedCategory" AS ENUM ('POOLS_V3', 'ADD_POOLS_V3', 'SNAPSHOTS', 'BPT_BALANCES_V3', 'JOIN_EXITS_V3', 'SWAPS_V3');

-- CreateEnum
CREATE TYPE "PrismaPoolType" AS ENUM ('WEIGHTED', 'STABLE', 'GYROE');

-- CreateEnum
CREATE TYPE "PrismaPoolAprType" AS ENUM ('SWAP_FEE', 'DYNAMIC_SWAP_FEE_24H', 'SWAP_FEE_24H', 'SWAP_FEE_7D', 'SWAP_FEE_30D', 'NATIVE_REWARD', 'IB_YIELD', 'MERKL', 'SURPLUS', 'SURPLUS_24H', 'SURPLUS_7D', 'SURPLUS_30D');

-- CreateEnum
CREATE TYPE "PoolEventType" AS ENUM ('JOIN', 'EXIT', 'SWAP');

-- CreateEnum
CREATE TYPE "PrismaTokenTypeOption" AS ENUM ('WHITE_LISTED', 'BLOCKED_V3', 'BPT', 'ERC4626');

-- CreateTable
CREATE TABLE "PrismaLastBlockSynced" (
    "category" "PrismaLastBlockSyncedCategory" NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'SEPOLIA',
    "blockNumber" INTEGER NOT NULL,

    CONSTRAINT "PrismaLastBlockSynced_pkey" PRIMARY KEY ("category","chain")
);

-- CreateTable
CREATE TABLE "PrismaPool" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "createTime" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PrismaPoolType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "pauseManager" TEXT,
    "swapFeeManager" TEXT NOT NULL,
    "poolCreator" TEXT,
    "factory" TEXT,
    "protocolVersion" INTEGER NOT NULL DEFAULT 2,
    "search_vector" tsvector,
    "typeData" JSONB NOT NULL DEFAULT '{}',
    "liquidityManagement" JSONB NOT NULL DEFAULT '{}',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hook" JSONB,

    CONSTRAINT "PrismaPool_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolDynamicData" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "protocolYieldFee" TEXT,
    "protocolSwapFee" TEXT NOT NULL DEFAULT '0',
    "swapFee" TEXT NOT NULL DEFAULT '0',
    "aggregateSwapFee" TEXT NOT NULL DEFAULT '0',
    "aggregateYieldFee" TEXT NOT NULL DEFAULT '0',
    "swapEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "isInRecoveryMode" BOOLEAN NOT NULL DEFAULT false,
    "totalShares" TEXT NOT NULL,
    "totalSharesNum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalLiquidity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "surplus24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "yieldCapture24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocolFees24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocolYieldCapture24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "apr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "surplus48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "yieldCapture48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocolFees48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocolYieldCapture48h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalLiquidity24hAgo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalShares24hAgo" TEXT NOT NULL DEFAULT '0',
    "lifetimeVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lifetimeSwapFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holdersCount" INTEGER NOT NULL DEFAULT 0,
    "swapsCount" INTEGER NOT NULL DEFAULT 0,
    "tokenPairsData" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "PrismaPoolDynamicData_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolToken" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "nestedPoolId" TEXT,
    "priceRateProvider" TEXT,
    "exemptFromProtocolYieldFee" BOOLEAN NOT NULL DEFAULT false,
    "scalingFactor" TEXT,
    "balance" TEXT NOT NULL,
    "balanceUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weight" TEXT,
    "priceRate" TEXT NOT NULL DEFAULT '1.0',
    "latestFxPrice" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrismaPoolToken_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolAprItem" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "title" TEXT NOT NULL,
    "rewardTokenAddress" TEXT,
    "rewardTokenSymbol" TEXT,
    "apr" DOUBLE PRECISION NOT NULL,
    "type" "PrismaPoolAprType",

    CONSTRAINT "PrismaPoolAprItem_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolExpandedTokens" (
    "tokenAddress" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "nestedPoolId" TEXT,

    CONSTRAINT "PrismaPoolExpandedTokens_pkey" PRIMARY KEY ("tokenAddress","poolId","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolFilter" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "PrismaPoolFilter_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolFilterMap" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "filterId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,

    CONSTRAINT "PrismaPoolFilterMap_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPoolSnapshot" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL DEFAULT 2,
    "totalLiquidity" DOUBLE PRECISION NOT NULL,
    "sharePrice" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "fees24h" DOUBLE PRECISION NOT NULL,
    "surplus24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalShares" TEXT NOT NULL,
    "totalSharesNum" DOUBLE PRECISION NOT NULL,
    "swapsCount" INTEGER NOT NULL,
    "amounts" TEXT[],

    CONSTRAINT "PrismaPoolSnapshot_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PartitionedPoolEvent" (
    "id" TEXT NOT NULL,
    "tx" TEXT NOT NULL,
    "type" "PoolEventType" NOT NULL,
    "chain" "Chain" NOT NULL,
    "poolId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "blockTimestamp" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL DEFAULT 2,
    "valueUSD" DOUBLE PRECISION NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "PartitionedPoolEvent_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaTokenYield" (
    "address" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "apr" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrismaTokenYield_pkey" PRIMARY KEY ("address","chain")
);

-- CreateTable
CREATE TABLE "PrismaToken" (
    "address" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "decimals" INTEGER NOT NULL,
    "logoURI" TEXT,
    "websiteUrl" TEXT,
    "discordUrl" TEXT,
    "telegramUrl" TEXT,
    "twitterUsername" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "coingeckoPlatformId" TEXT,
    "coingeckoContractAddress" TEXT,
    "coingeckoTokenId" TEXT,
    "excludedFromCoingecko" BOOLEAN NOT NULL DEFAULT false,
    "underlyingTokenAddress" TEXT,
    "isBufferAllowed" BOOLEAN NOT NULL DEFAULT true,
    "unwrapRate" TEXT NOT NULL DEFAULT '1',
    "maxDeposit" TEXT NOT NULL DEFAULT '0',
    "maxWithdraw" TEXT NOT NULL DEFAULT '0',
    "tvl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bufferBalanceUnderlying" TEXT NOT NULL DEFAULT '0',
    "bufferBalanceWrapped" TEXT NOT NULL DEFAULT '0',

    CONSTRAINT "PrismaToken_pkey" PRIMARY KEY ("address","chain")
);

-- CreateTable
CREATE TABLE "PrismaTokenCurrentPrice" (
    "tokenAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "timestamp" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PrismaTokenCurrentPrice_pkey" PRIMARY KEY ("tokenAddress","chain")
);

-- CreateTable
CREATE TABLE "PrismaTokenPrice" (
    "tokenAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "timestamp" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PrismaTokenPrice_pkey" PRIMARY KEY ("tokenAddress","timestamp","chain")
);

-- CreateTable
CREATE TABLE "PrismaTokenDynamicData" (
    "coingeckoId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "ath" DOUBLE PRECISION NOT NULL,
    "atl" DOUBLE PRECISION NOT NULL,
    "marketCap" DOUBLE PRECISION,
    "fdv" DOUBLE PRECISION,
    "high24h" DOUBLE PRECISION NOT NULL,
    "low24h" DOUBLE PRECISION NOT NULL,
    "priceChange24h" DOUBLE PRECISION NOT NULL,
    "priceChangePercent24h" DOUBLE PRECISION NOT NULL,
    "priceChangePercent7d" DOUBLE PRECISION,
    "priceChangePercent14d" DOUBLE PRECISION,
    "priceChangePercent30d" DOUBLE PRECISION,

    CONSTRAINT "PrismaTokenDynamicData_pkey" PRIMARY KEY ("tokenAddress","chain")
);

-- CreateTable
CREATE TABLE "PrismaTokenType" (
    "id" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "type" "PrismaTokenTypeOption" NOT NULL,

    CONSTRAINT "PrismaTokenType_pkey" PRIMARY KEY ("id","chain")
);

-- CreateTable
CREATE TABLE "PrismaPriceRateProviderData" (
    "chain" "Chain" NOT NULL,
    "rateProviderAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "reviewed" BOOLEAN NOT NULL,
    "name" TEXT,
    "summary" TEXT,
    "reviewUrl" TEXT,
    "warnings" TEXT,
    "upgradableComponents" JSONB,

    CONSTRAINT "PrismaPriceRateProviderData_pkey" PRIMARY KEY ("chain","rateProviderAddress")
);

-- CreateTable
CREATE TABLE "PrismaErc4626ReviewData" (
    "chain" "Chain" NOT NULL,
    "erc4626Address" TEXT NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reviewFile" TEXT NOT NULL,
    "warnings" TEXT NOT NULL,
    "canUseBufferForSwaps" BOOLEAN NOT NULL DEFAULT false,
    "useUnderlyingForAddRemove" BOOLEAN NOT NULL DEFAULT false,
    "useWrappedForAddRemove" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PrismaErc4626ReviewData_pkey" PRIMARY KEY ("chain","erc4626Address")
);

-- CreateTable
CREATE TABLE "PrismaUser" (
    "address" TEXT NOT NULL,

    CONSTRAINT "PrismaUser_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "PrismaUserWalletBalance" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "balance" TEXT NOT NULL,
    "balanceNum" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userAddress" TEXT NOT NULL,
    "poolId" TEXT,
    "tokenAddress" TEXT NOT NULL,

    CONSTRAINT "PrismaUserWalletBalance_pkey" PRIMARY KEY ("id","chain")
);

-- CreateIndex
CREATE INDEX "PrismaPool_id_chain_idx" ON "PrismaPool"("id", "chain");

-- CreateIndex
CREATE INDEX "PrismaPool_categories_idx" ON "PrismaPool" USING GIN ("categories" array_ops);

-- CreateIndex
CREATE INDEX "PrismaPool_search_vector_idx" ON "PrismaPool" USING GIN ("search_vector");

-- CreateIndex
CREATE UNIQUE INDEX "PrismaPool_address_chain_key" ON "PrismaPool"("address", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolDynamicData_totalLiquidity_idx" ON "PrismaPoolDynamicData"("totalLiquidity");

-- CreateIndex
CREATE INDEX "PrismaPoolDynamicData_totalSharesNum_idx" ON "PrismaPoolDynamicData"("totalSharesNum" DESC);

-- CreateIndex
CREATE INDEX "PrismaPoolDynamicData_volume24h_idx" ON "PrismaPoolDynamicData"("volume24h");

-- CreateIndex
CREATE INDEX "PrismaPoolDynamicData_apr_idx" ON "PrismaPoolDynamicData"("apr");

-- CreateIndex
CREATE UNIQUE INDEX "PrismaPoolDynamicData_poolId_chain_key" ON "PrismaPoolDynamicData"("poolId", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolToken_id_chain_idx" ON "PrismaPoolToken"("id", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolToken_poolId_chain_idx" ON "PrismaPoolToken"("poolId", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolToken_address_chain_idx" ON "PrismaPoolToken"("address", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolToken_nestedPoolId_chain_idx" ON "PrismaPoolToken"("nestedPoolId", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolAprItem_poolId_chain_idx" ON "PrismaPoolAprItem"("poolId", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolAprItem_chain_type_idx" ON "PrismaPoolAprItem"("chain", "type");

-- CreateIndex
CREATE INDEX "PrismaPoolExpandedTokens_tokenAddress_chain_idx" ON "PrismaPoolExpandedTokens"("tokenAddress", "chain");

-- CreateIndex
CREATE INDEX "PrismaPoolSnapshot_protocolVersion_idx" ON "PrismaPoolSnapshot"("protocolVersion");

-- CreateIndex
CREATE INDEX "PrismaPoolSnapshot_timestamp_idx" ON "PrismaPoolSnapshot"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "PrismaPoolSnapshot_poolId_chain_idx" ON "PrismaPoolSnapshot"("poolId", "chain");

-- CreateIndex
CREATE INDEX "PartitionedPoolEvent_chain_type_blockTimestamp_blockNumber__idx" ON "PartitionedPoolEvent"("chain", "type", "blockTimestamp" DESC, "blockNumber" DESC, "logIndex" DESC);

-- CreateIndex
CREATE INDEX "PartitionedPoolEvent_chain_poolId_blockTimestamp_blockNumbe_idx" ON "PartitionedPoolEvent"("chain", "poolId", "blockTimestamp" DESC, "blockNumber" DESC, "logIndex" DESC);

-- CreateIndex
CREATE INDEX "PartitionedPoolEvent_chain_userAddress_idx" ON "PartitionedPoolEvent"("chain", "userAddress");

-- CreateIndex
CREATE INDEX "PrismaTokenYield_chain_address_idx" ON "PrismaTokenYield"("chain", "address");

-- CreateIndex
CREATE INDEX "PrismaToken_address_chain_idx" ON "PrismaToken"("address", "chain");

-- CreateIndex
CREATE INDEX "PrismaToken_tvl_idx" ON "PrismaToken"("tvl" DESC);

-- CreateIndex
CREATE INDEX "PrismaTokenCurrentPrice_tokenAddress_idx" ON "PrismaTokenCurrentPrice"("tokenAddress");

-- CreateIndex
CREATE INDEX "PrismaTokenCurrentPrice_chain_idx" ON "PrismaTokenCurrentPrice"("chain");

-- CreateIndex
CREATE UNIQUE INDEX "PrismaTokenCurrentPrice_tokenAddress_chain_key" ON "PrismaTokenCurrentPrice"("tokenAddress", "chain");

-- CreateIndex
CREATE INDEX "PrismaTokenPrice_timestamp_chain_idx" ON "PrismaTokenPrice"("timestamp", "chain");

-- CreateIndex
CREATE INDEX "PrismaTokenPrice_tokenAddress_chain_idx" ON "PrismaTokenPrice"("tokenAddress", "chain");

-- CreateIndex
CREATE INDEX "PrismaTokenDynamicData_tokenAddress_chain_idx" ON "PrismaTokenDynamicData"("tokenAddress", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "PrismaTokenType_tokenAddress_type_chain_key" ON "PrismaTokenType"("tokenAddress", "type", "chain");

-- CreateIndex
CREATE INDEX "PrismaPriceRateProviderData_chain_rateProviderAddress_idx" ON "PrismaPriceRateProviderData"("chain", "rateProviderAddress");

-- CreateIndex
CREATE INDEX "PrismaPriceRateProviderData_tokenAddress_idx" ON "PrismaPriceRateProviderData"("tokenAddress");

-- CreateIndex
CREATE INDEX "PrismaErc4626ReviewData_chain_erc4626Address_idx" ON "PrismaErc4626ReviewData"("chain", "erc4626Address");

-- CreateIndex
CREATE INDEX "PrismaErc4626ReviewData_assetAddress_idx" ON "PrismaErc4626ReviewData"("assetAddress");

-- CreateIndex
CREATE INDEX "PrismaUserWalletBalance_userAddress_idx" ON "PrismaUserWalletBalance"("userAddress");

-- CreateIndex
CREATE INDEX "PrismaUserWalletBalance_poolId_chain_idx" ON "PrismaUserWalletBalance"("poolId", "chain");

-- AddForeignKey
ALTER TABLE "PrismaPoolDynamicData" ADD CONSTRAINT "PrismaPoolDynamicData_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolToken" ADD CONSTRAINT "PrismaPoolToken_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolToken" ADD CONSTRAINT "PrismaPoolToken_address_chain_fkey" FOREIGN KEY ("address", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolToken" ADD CONSTRAINT "PrismaPoolToken_nestedPoolId_chain_fkey" FOREIGN KEY ("nestedPoolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolAprItem" ADD CONSTRAINT "PrismaPoolAprItem_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolExpandedTokens" ADD CONSTRAINT "PrismaPoolExpandedTokens_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolExpandedTokens" ADD CONSTRAINT "PrismaPoolExpandedTokens_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolExpandedTokens" ADD CONSTRAINT "PrismaPoolExpandedTokens_nestedPoolId_chain_fkey" FOREIGN KEY ("nestedPoolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolFilterMap" ADD CONSTRAINT "PrismaPoolFilterMap_filterId_chain_fkey" FOREIGN KEY ("filterId", "chain") REFERENCES "PrismaPoolFilter"("id", "chain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolFilterMap" ADD CONSTRAINT "PrismaPoolFilterMap_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaPoolSnapshot" ADD CONSTRAINT "PrismaPoolSnapshot_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaTokenCurrentPrice" ADD CONSTRAINT "PrismaTokenCurrentPrice_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaTokenPrice" ADD CONSTRAINT "PrismaTokenPrice_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaTokenDynamicData" ADD CONSTRAINT "PrismaTokenDynamicData_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaTokenType" ADD CONSTRAINT "PrismaTokenType_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaUserWalletBalance" ADD CONSTRAINT "PrismaUserWalletBalance_userAddress_fkey" FOREIGN KEY ("userAddress") REFERENCES "PrismaUser"("address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaUserWalletBalance" ADD CONSTRAINT "PrismaUserWalletBalance_poolId_chain_fkey" FOREIGN KEY ("poolId", "chain") REFERENCES "PrismaPool"("id", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaUserWalletBalance" ADD CONSTRAINT "PrismaUserWalletBalance_tokenAddress_chain_fkey" FOREIGN KEY ("tokenAddress", "chain") REFERENCES "PrismaToken"("address", "chain") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pool search is not represented in the Prisma schema beyond the tsvector column.
CREATE OR REPLACE FUNCTION public.generate_pool_search_vector(
    pool_id TEXT,
    chain_id TEXT
) RETURNS tsvector
LANGUAGE plpgsql
AS $$
DECLARE
  protocol_version_part TEXT;
  name_symbol_part TEXT;
  token_data_part TEXT;
  hook_data_part TEXT;
  chain_text TEXT := chain_id;
BEGIN
  SELECT
    CASE WHEN "protocolVersion" = 1 THEN 'COW' ELSE 'v' || COALESCE("protocolVersion"::TEXT, '') END,
    COALESCE(name, '') || ' ' ||
    COALESCE(symbol, '') || ' ' ||
    CASE WHEN "protocolVersion" = 2 THEN COALESCE(id, '') ELSE '' END || ' ' ||
    COALESCE(address::TEXT, '') || ' ' ||
    COALESCE(type::TEXT, '') || ' ' ||
    COALESCE(chain::TEXT, '') || ' ' ||
    COALESCE(array_to_string(categories, ' '), ''),
    COALESCE(hook->>'type', '')
  INTO protocol_version_part, name_symbol_part, hook_data_part
  FROM "PrismaPool"
  WHERE id = pool_id AND chain::TEXT = chain_text;

  SELECT string_agg(
    COALESCE(tk.name, '') || ' ' ||
    COALESCE(tk.symbol, '') || ' ' ||
    COALESCE(t.address, '') || ' ' ||
    COALESCE(ut.name, '') || ' ' ||
    COALESCE(ut.symbol, '') || ' ' ||
    COALESCE(tk."underlyingTokenAddress", ''),
    ' '
  )
  INTO token_data_part
  FROM "PrismaPoolToken" t
  JOIN "PrismaToken" tk ON t.address = tk.address AND t.chain::TEXT = chain_text
  LEFT JOIN "PrismaToken" ut ON ut.address = tk."underlyingTokenAddress" AND ut.chain::TEXT = chain_text
  WHERE t."poolId" = pool_id AND t.chain::TEXT = chain_text;

  RETURN
    setweight(to_tsvector('simple', protocol_version_part), 'A') ||
    to_tsvector('simple', regexp_replace(name_symbol_part || ' ' || token_data_part || ' ' || COALESCE(hook_data_part, ''), '[-/]', ' ', 'g'));
END;
$$;

CREATE OR REPLACE FUNCTION public.update_search_vector()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME ILIKE 'PrismaPool' THEN
    UPDATE "PrismaPool"
    SET search_vector = generate_pool_search_vector(id, chain::TEXT)
    WHERE id = NEW."id" AND chain::TEXT = NEW.chain::TEXT;
    RETURN NEW;
  ELSIF TG_TABLE_NAME ILIKE 'PrismaPoolToken' THEN
    UPDATE "PrismaPool"
    SET search_vector = generate_pool_search_vector(id, chain::TEXT)
    WHERE id = NEW."poolId" AND chain::TEXT = NEW.chain::TEXT;
    RETURN NEW;
  ELSIF TG_TABLE_NAME ILIKE 'PrismaToken' AND (TG_OP = 'UPDATE') THEN
    UPDATE "PrismaPool" p
    SET search_vector = generate_pool_search_vector(p.id, p.chain::TEXT)
    WHERE EXISTS (
      SELECT 1 FROM "PrismaPoolToken" pt
      WHERE pt.address = NEW.address
      AND pt.chain::TEXT = NEW.chain::TEXT
      AND pt."poolId" = p.id
      AND pt.chain::TEXT = p.chain::TEXT
    );
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trig_update_pool_search_vector
AFTER INSERT OR UPDATE OF name, symbol, address, type, chain, categories, "protocolVersion", hook
ON "PrismaPool"
FOR EACH ROW
EXECUTE FUNCTION update_search_vector();

CREATE TRIGGER trig_update_pool_search_vector_on_token_change
AFTER INSERT ON "PrismaPoolToken"
FOR EACH ROW
EXECUTE FUNCTION update_search_vector();

CREATE TRIGGER trig_update_pool_search_vector_on_prismatoken_change
AFTER UPDATE OF name, symbol ON "PrismaToken"
FOR EACH ROW
EXECUTE FUNCTION update_search_vector();
