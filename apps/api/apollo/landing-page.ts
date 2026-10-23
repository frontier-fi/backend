// Prefilled in Apollo Sandbox on GET /graphql.
export const examplePoolsQuery = `query Pools {
  poolGetPools(orderBy: totalLiquidity, orderDirection: desc) {
    id
    name
    symbol
    type
    chain
    address
    dynamicData {
      totalLiquidity
    }
  }
}`;
