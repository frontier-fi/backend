-- DropIndex
DROP INDEX IF EXISTS "PrismaPool_id_chain_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaPoolToken_id_chain_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaToken_address_chain_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaTokenCurrentPrice_tokenAddress_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaTokenCurrentPrice_tokenAddress_chain_key";

-- DropIndex
DROP INDEX IF EXISTS "PrismaTokenDynamicData_tokenAddress_chain_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaPriceRateProviderData_chain_rateProviderAddress_idx";

-- DropIndex
DROP INDEX IF EXISTS "PrismaErc4626ReviewData_chain_erc4626Address_idx";

-- Fix NULL token_data_part concatenation and cross-chain join condition in generate_pool_search_vector
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
  JOIN "PrismaToken" tk ON t.address = tk.address AND tk.chain::TEXT = chain_text
  LEFT JOIN "PrismaToken" ut ON ut.address = tk."underlyingTokenAddress" AND ut.chain::TEXT = chain_text
  WHERE t."poolId" = pool_id AND t.chain::TEXT = chain_text;

  RETURN
    setweight(to_tsvector('simple', COALESCE(protocol_version_part, '')), 'A') ||
    to_tsvector('simple', regexp_replace(COALESCE(name_symbol_part, '') || ' ' || COALESCE(token_data_part, '') || ' ' || COALESCE(hook_data_part, ''), '[-/]', ' ', 'g'));
END;
$$;

-- Include underlyingTokenAddress updates in PrismaToken search vector trigger
DROP TRIGGER IF EXISTS trig_update_pool_search_vector_on_prismatoken_change ON "PrismaToken";

CREATE TRIGGER trig_update_pool_search_vector_on_prismatoken_change
AFTER UPDATE OF name, symbol, "underlyingTokenAddress" ON "PrismaToken"
FOR EACH ROW
EXECUTE FUNCTION update_search_vector();

-- Backfill any existing pools whose search_vector was previously NULL
UPDATE "PrismaPool"
SET search_vector = generate_pool_search_vector(id, chain::TEXT)
WHERE search_vector IS NULL;
