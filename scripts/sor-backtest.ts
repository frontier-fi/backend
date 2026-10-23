/**
 * Replay stored swaps through the SOR and print how the quote compares with the amount that came out.
 *
 * Reads SWAP rows from the database, collapses hops that share a transaction into one
 * token-in / token-out pair, then keeps the newest swap for each pair. If the database
 * has fewer swaps than requested, every one of them is used.
 *
 * Requires the same environment as the API, including DATABASE_URL.
 *
 * Usage: bun scripts/sor-backtest.ts [chain] [count] [--verbose]
 *        bun run sor-backtest -- SEPOLIA 50 --verbose
 */

import { performance } from 'perf_hooks';
import { Chain, Prisma } from '@prisma/client';
import { prisma } from '../prisma/prisma-client';
import { sorService } from '../modules/sor/sor.service';
import { SwapEvent } from '../prisma/prisma-types';

const DEFAULT_CHAIN = Chain.SEPOLIA;
const DEFAULT_COUNT = 100;

type SwapRow = {
    tokenIn: string;
    tokenOut: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    amountIn: string;
    amountOut: string;
    transactionHash: string;
    blockNumber: number;
    logIndex: number;
};

type BacktestResult = {
    txHash: string;
    tokenIn: string;
    tokenOut: string;
    amount: string;
    historicAmountOut: string;
    sorAmountOut: string;
    improvement: number;
    durationMs: number;
    hops: number;
};

function usage(): string {
    const chains = Object.values(Chain).join(', ');
    return `Usage: bun scripts/sor-backtest.ts [chain] [count] [--verbose]\nChains: ${chains}\nCount defaults to ${DEFAULT_COUNT}.`;
}

function parseArgs(argv: string[]): { chain: Chain; count: number; verbose: boolean } | 'help' {
    const verbose = argv.includes('--verbose');
    const positional = argv.filter((arg) => arg !== '--verbose' && arg !== '--help');

    if (argv.includes('--help')) {
        console.log(usage());
        return 'help';
    }

    const chainArg = (positional[0] ?? DEFAULT_CHAIN).toUpperCase();
    if (!(chainArg in Chain)) {
        throw new Error(`Unknown chain ${positional[0]}.\n${usage()}`);
    }

    const countArg = positional[1] ?? String(DEFAULT_COUNT);
    const count = Number(countArg);
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`Count must be a positive integer, received ${countArg}.\n${usage()}`);
    }

    return { chain: chainArg as Chain, count, verbose };
}

function isSwapPayload(payload: Prisma.JsonValue): payload is SwapEvent['payload'] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = payload as Partial<SwapEvent['payload']>;
    return Boolean(record.tokenIn?.address && record.tokenIn.amount && record.tokenOut?.address && record.tokenOut.amount);
}

function collapseTransactions(swaps: SwapRow[]): SwapRow[] {
    const grouped = new Map<string, SwapRow[]>();
    for (const swap of swaps) {
        const existing = grouped.get(swap.transactionHash) ?? [];
        existing.push(swap);
        grouped.set(swap.transactionHash, existing);
    }

    const collapsed: SwapRow[] = [];
    for (const txSwaps of grouped.values()) {
        const sorted = txSwaps.sort((a, b) => a.logIndex - b.logIndex);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        collapsed.push({
            ...first,
            tokenOut: last.tokenOut,
            tokenOutSymbol: last.tokenOutSymbol,
            amountOut: last.amountOut,
        });
    }
    return collapsed;
}

function newestUniquePairs(swaps: SwapRow[]): SwapRow[] {
    const selected: SwapRow[] = [];
    const seen = new Set<string>();
    const newestFirst = [...swaps].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

    for (const swap of newestFirst) {
        const pair = `${swap.tokenIn}-${swap.tokenOut}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        selected.push(swap);
    }
    return selected;
}

async function loadSwaps(chain: Chain, count: number): Promise<{ events: number; skipped: number; swaps: SwapRow[] }> {
    const tokens = await prisma.prismaToken.findMany({ where: { chain }, select: { address: true, symbol: true } });
    const symbols = new Map(tokens.map((token) => [token.address.toLowerCase(), token.symbol]));

    const events = await prisma.prismaPoolEvent.findMany({
        where: { chain, type: 'SWAP', protocolVersion: 3 },
        orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
        take: count,
    });

    let skipped = 0;
    const rows: SwapRow[] = [];
    for (const event of events) {
        if (!isSwapPayload(event.payload)) {
            skipped += 1;
            continue;
        }
        rows.push({
            tokenIn: event.payload.tokenIn.address,
            tokenOut: event.payload.tokenOut.address,
            tokenInSymbol: symbols.get(event.payload.tokenIn.address.toLowerCase()) ?? '?',
            tokenOutSymbol: symbols.get(event.payload.tokenOut.address.toLowerCase()) ?? '?',
            amountIn: event.payload.tokenIn.amount,
            amountOut: event.payload.tokenOut.amount,
            transactionHash: event.tx,
            blockNumber: event.blockNumber,
            logIndex: event.logIndex,
        });
    }

    return { events: events.length, skipped, swaps: newestUniquePairs(collapseTransactions(rows)) };
}

async function quoteSwaps(chain: Chain, swaps: SwapRow[], verbose: boolean): Promise<{ results: BacktestResult[]; errors: number }> {
    const results: BacktestResult[] = [];
    let errors = 0;

    for (const swap of swaps) {
        try {
            const start = performance.now();
            const sorResult = await sorService.getSorSwapPaths({
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                swapAmount: swap.amountIn,
                swapType: 'EXACT_IN',
                chain,
            });
            const durationMs = performance.now() - start;
            const historicOut = Number(swap.amountOut);
            const sorOut = Number(sorResult.returnAmount);
            const improvement = historicOut > 0 && Number.isFinite(sorOut) ? ((sorOut - historicOut) / historicOut) * 100 : 0;

            results.push({
                txHash: swap.transactionHash,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                amount: swap.amountIn,
                historicAmountOut: swap.amountOut,
                sorAmountOut: sorResult.returnAmount,
                improvement,
                durationMs,
                hops: sorResult.swaps.length,
            });

            if (verbose) {
                console.log(
                    `${swap.tokenInSymbol.padStart(12)} -> ${swap.tokenOutSymbol.padEnd(12)} hist=${historicOut} sor=${sorResult.returnAmount} delta=${improvement.toFixed(2)}% ${durationMs.toFixed(1)}ms ${sorResult.swaps.length} hops`,
                );
            }
        } catch (error) {
            errors += 1;
            console.warn(`Failed ${swap.transactionHash}`, error);
        }
    }

    return { results, errors };
}

function printSummary(chain: Chain, results: BacktestResult[], errors: number): void {
    const timed = results.length > 1 ? results.slice(1) : results;
    const avgDuration = timed.reduce((sum, result) => sum + result.durationMs, 0) / (timed.length || 1);
    const avgImprovement = results.reduce((sum, result) => sum + result.improvement, 0) / (results.length || 1);

    console.log(`\nBacktest summary: ${chain}`);
    console.table({
        swapsTested: results.length,
        quoteErrors: errors,
        avgLatencyMs: avgDuration.toFixed(2),
        avgImprovementPercent: avgImprovement.toFixed(2),
        notFound: results.filter((result) => result.sorAmountOut === '0').length,
        better: results.filter((result) => result.improvement > 0).length,
        worse: results.filter((result) => result.sorAmountOut !== '0' && result.improvement < 0).length,
    });
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === 'help') return;
    const { chain, count, verbose } = parsed;
    const loaded = await loadSwaps(chain, count);

    if (loaded.events === 0) {
        console.log(`No v3 SWAP events for ${chain}.`);
        return;
    }

    console.log(
        `${chain}: requested up to ${count} swaps, found ${loaded.events}, quoting ${loaded.swaps.length} unique pairs` +
            (loaded.skipped > 0 ? `, skipped ${loaded.skipped} malformed rows` : '') +
            (loaded.events < count ? ' (database has fewer than requested)' : ''),
    );

    const { results, errors } = await quoteSwaps(chain, loaded.swaps, verbose);
    printSummary(chain, results, errors);
}

main()
    .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
