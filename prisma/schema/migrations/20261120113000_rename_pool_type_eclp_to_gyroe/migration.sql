-- Metadata-only atomic enum value rename (PostgreSQL 10+); updates all existing PrismaPool rows in place.
ALTER TYPE "PrismaPoolType" RENAME VALUE 'ECLP' TO 'GYROE';

-- ALTER TYPE RENAME VALUE does not fire row triggers.
-- generate_pool_search_vector() indexes PrismaPool.type::TEXT, so refresh search_vector on migrated rows.
UPDATE "PrismaPool"
SET search_vector = generate_pool_search_vector(id, chain::TEXT)
WHERE type = 'GYROE';
