const github = (repo: string, file: string) => `https://raw.githubusercontent.com/${repo}/main/${file}`;

/** Content synced from GitHub, all from frontier-fi forks. */
export const contentSources = {
    tokenList: github('frontier-fi/tokenlists', 'generated/balancer.tokenlist.json'),
    rateProviderReviews: github('frontier-fi/code-review', 'rate-providers/registry.json'),
    erc4626Reviews: github('frontier-fi/code-review', 'erc4626/registry.json'),
    featuredPools: github('frontier-fi/metadata', 'pools/featured.json'),
    poolTags: github('frontier-fi/metadata', 'pools/tags/index.json'),
    hookTags: github('frontier-fi/metadata', 'hooks/index.json'),
    erc4626Tags: github('frontier-fi/metadata', 'erc4626/index.json'),
    erc4626BufferBlocklist: github('frontier-fi/metadata', 'erc4626/bufferblocklist.json'),
    blockedTokens: github('frontier-fi/blocklist', 'tokens/blocked.csv'),
};
