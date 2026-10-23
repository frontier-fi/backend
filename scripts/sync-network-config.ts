/**
 * Write Frontier deployment addresses into an existing config/<network>.ts.
 *
 * Contract addresses come from the ACTIVE entries in
 * https://github.com/frontier-fi/deployments/blob/main/addresses/_lookup.json
 * Mock contracts are skipped. A later task wins when the same contract name
 * is deployed twice.
 *
 * Multicall3 comes from
 * https://github.com/mds1/multicall/blob/main/deployments.json
 * Maker's Multicall v1 list is deprecated and does not cover current networks,
 * so the `multicall` field already in the config file is left as written.
 *
 * WETH, and ETH when that export exists, come from
 * https://github.com/frontier-fi/deployments/blob/main/src/constants.ts
 * Every address written into the config is EIP-55 checksummed.
 *
 * Subgraph URLs, hooks, and fees stay as written. The config file has to exist already.
 *
 * Usage: bun scripts/sync-network-config.ts [network...]
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getAddress, isAddress } from 'viem';

const LOOKUP_URL = 'https://raw.githubusercontent.com/frontier-fi/deployments/main/addresses/_lookup.json';
const CONSTANTS_URL = 'https://raw.githubusercontent.com/frontier-fi/deployments/main/src/constants.ts';
const MULTICALL_URL = 'https://raw.githubusercontent.com/mds1/multicall/main/deployments.json';
const CANONICAL_MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

type LookupFile = Record<string, { ACTIVE?: Record<string, Record<string, string>> }>;

type MulticallEntry = {
    chainId: number;
    url: string;
    address?: string;
};

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
}

function activeContracts(network: LookupFile[string]): Record<string, string> {
    const tasks = network.ACTIVE ?? {};
    const chosen = new Map<string, { task: string; address: string }>();

    for (const task of Object.keys(tasks).sort()) {
        for (const [name, address] of Object.entries(tasks[task])) {
            if (name.startsWith('Mock')) continue;
            const previous = chosen.get(name);
            if (previous && previous.address.toLowerCase() !== address.toLowerCase()) {
                console.warn(`${name}: ${task} replaces ${previous.task} (${previous.address} -> ${address})`);
            }
            chosen.set(name, { task, address });
        }
    }

    return Object.fromEntries(
        [...chosen.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => [name, checksumAddress(value.address)]),
    );
}

function addressFromMulticallEntry(entry: MulticallEntry): string | undefined {
    if (entry.address && /^0x[a-fA-F0-9]{40}$/.test(entry.address)) return entry.address;
    return entry.url.match(/0x[a-fA-F0-9]{40}/)?.[0];
}

function indexMulticall(entries: MulticallEntry[]): Map<number, string> {
    const byChain = new Map<number, string[]>();
    for (const entry of entries) {
        const address = addressFromMulticallEntry(entry);
        if (!address) continue;
        const list = byChain.get(entry.chainId) ?? [];
        if (!list.some((item) => item.toLowerCase() === address.toLowerCase())) list.push(address);
        byChain.set(entry.chainId, list);
    }

    const resolved = new Map<number, string>();
    for (const [chainId, addresses] of byChain) {
        if (addresses.length === 1) {
            resolved.set(chainId, checksumAddress(addresses[0]));
            continue;
        }
        const canonical = addresses.find((address) => address.toLowerCase() === CANONICAL_MULTICALL3.toLowerCase());
        if (!canonical) {
            throw new Error(`Chain ${chainId} has multiple Multicall3 addresses: ${addresses.join(', ')}`);
        }
        resolved.set(chainId, checksumAddress(canonical));
    }
    return resolved;
}

function chainIdFromConfig(source: string, file: string): number {
    const match = source.match(/chain:\s*\{[^}]*\bid:\s*(\d+)/s);
    if (!match) throw new Error(`${file} has no chain.id`);
    return Number(match[1]);
}

function addressRecord(source: string, exportName: string): Record<string, string> | undefined {
    const match = source.match(new RegExp(`export const ${exportName}\\b[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};`));
    if (!match) return undefined;

    const body = match[1];
    const entries: Record<string, string> = {};
    const pattern = /\baddress\s*:/.test(body)
        ? /(\w+)\s*:\s*\{[^}]*\baddress:\s*'(0x[a-fA-F0-9]{40})'/g
        : /(\w+)\s*:\s*'(0x[a-fA-F0-9]{40})'/g;
    for (const found of body.matchAll(pattern)) {
        entries[found[1]] = found[2];
    }
    return Object.keys(entries).length > 0 ? entries : undefined;
}

function replaceInBlock(source: string, blockName: string, key: string, value: string): string {
    const blockPattern = new RegExp(`(^\\s*${blockName}:\\s*\\{)([\\s\\S]*?)(^\\s*\\},)`, 'm');
    const block = source.match(blockPattern);
    if (!block) throw new Error(`${blockName} block is missing`);

    const keyPattern = new RegExp(`(^\\s*${key}:\\s*')[^']+(')`, 'm');
    if (!keyPattern.test(block[2])) throw new Error(`${blockName}.${key} is missing`);
    const body = block[2].replace(keyPattern, `$1${value}$2`);
    return source.replace(blockPattern, `$1${body}$3`);
}

function checksumAddress(address: string): string {
    if (!isAddress(address)) {
        throw new Error(`Invalid address ${address}`);
    }
    return getAddress(address);
}

function setTokenBlock(source: string, blockName: string, published: string): string {
    return replaceInBlock(source, blockName, 'address', checksumAddress(published));
}

function contractsBlock(contracts: Record<string, string>): string {
    const lines = Object.entries(contracts).map(([name, address]) => `        ${name}: '${address}',`);
    return `    // Active addresses from frontier-fi/deployments addresses/_lookup.json. Mock contracts are omitted.\n    contracts: {\n${lines.join('\n')}\n    },`;
}

function upsertContracts(source: string, contracts: Record<string, string>): string {
    const block = contractsBlock(contracts);
    const withComment =
        /^    \/\/ Active addresses from frontier-fi\/deployments.*\n    contracts: \{[\s\S]*?\n    \},/m;
    if (withComment.test(source)) return source.replace(withComment, block);

    const bare = /^    contracts: \{[\s\S]*?\n    \},/m;
    if (bare.test(source)) return source.replace(bare, block);

    const anchor = source.match(/^    hooks: \{/m);
    if (!anchor) throw new Error('Cannot place contracts: hooks block is missing');
    return source.replace(anchor[0], `${block}\n${anchor[0]}`);
}

function setMulticall3(source: string, address: string): string {
    const pattern = /^(\s*multicall3:\s*')[^']+(')/m;
    if (!pattern.test(source)) throw new Error('multicall3 is missing');
    let next = source.replace(pattern, `$1${checksumAddress(address)}$2`);
    const maker = /^(\s*multicall:\s*')(0x[a-fA-F0-9]{40})(')/m;
    const makerMatch = next.match(maker);
    if (makerMatch) {
        next = next.replace(maker, `$1${checksumAddress(makerMatch[2])}$3`);
    }
    const comment = '    // Multicall3 from https://github.com/mds1/multicall deployments.json.';
    if (!next.includes('github.com/mds1/multicall')) {
        next = next.replace(/^(\s*multicall:)/m, `${comment}\n$1`);
    }
    return next;
}

function syncFile(
    file: string,
    slug: string,
    contracts: Record<string, string>,
    multicall3: string,
    constantsSource: string,
): void {
    let source = readFileSync(file, 'utf8');
    if (!contracts.Router) throw new Error(`${file} lookup is missing Router`);

    const weth = addressRecord(constantsSource, 'WETH');
    const wethAddress = weth?.[slug];
    if (!wethAddress) throw new Error(`constants.ts has no WETH for ${slug}`);
    source = setTokenBlock(source, 'weth', wethAddress);

    const eth = addressRecord(constantsSource, 'ETH');
    if (!eth) {
        console.warn(`${slug}: ETH is not in constants.ts; leaving the native token address as written`);
    } else if (!eth[slug]) {
        throw new Error(`constants.ts has no ETH for ${slug}`);
    } else {
        source = setTokenBlock(source, 'eth', eth[slug]);
    }

    source = upsertContracts(source, contracts);
    source = setMulticall3(source, multicall3);
    writeFileSync(file, source);
}

async function main(): Promise<void> {
    const requested = process.argv.slice(2);
    const lookup = await fetchJson<LookupFile>(LOOKUP_URL);
    const constantsSource = await fetch(CONSTANTS_URL).then((response) => {
        if (!response.ok) throw new Error(`${CONSTANTS_URL} returned ${response.status}`);
        return response.text();
    });
    const multicalls = indexMulticall(await fetchJson<MulticallEntry[]>(MULTICALL_URL));
    const slugs = requested.length > 0 ? requested : Object.keys(lookup);

    for (const slug of slugs) {
        const network = lookup[slug];
        if (!network) throw new Error(`${slug} is not in ${LOOKUP_URL}`);

        const file = path.join('config', `${slug}.ts`);
        let source: string;
        try {
            source = readFileSync(file, 'utf8');
        } catch {
            throw new Error(`${file} does not exist. Create the network config before syncing addresses into it.`);
        }

        const chainId = chainIdFromConfig(source, file);
        const multicall3 = multicalls.get(chainId);
        if (!multicall3) throw new Error(`No Multicall3 deployment for chain ${chainId} (${slug})`);

        const contracts = activeContracts(network);
        if (!contracts.Vault || !contracts.Router) throw new Error(`${slug} lookup is missing Vault or Router`);
        syncFile(file, slug, contracts, multicall3, constantsSource);
        console.log(`${slug}: wrote ${Object.keys(contracts).length} contracts, multicall3 ${multicall3}`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
