import { Chain } from '@prisma/client';
import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { formatUnits, parseEther, parseUnits } from 'viem';
import { GyroECLPPool } from './gyroECLPPool';
import {
    hookFactory,
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../../../../test/factories';

// On-chain integers from a recorded GyroE swap (1e18 in -> 989980003877180195 out).
// The database stores these as decimal strings; fromPrismaPool parses them back.
const RECORDED = {
    pool: '0x80fd5bc9d4fa6c22132f8bb2d9d30b01c3336fb3',
    tokenOut: '0xb19382073c7a0addbb56ac6af1808fa49e377b75',
    tokenIn: '0xb77eb1a70a96fdaaeb31db1b42f2b8b5846b2613',
    alpha: 998502246630054917n,
    beta: 1000200040008001600n,
    c: 707106781186547524n,
    s: 707106781186547524n,
    lambda: 4000000000000000000000n,
    tauAlphaX: -94861212813096057289512505574275160547n,
    tauAlphaY: 31644119574235279926451292677567331630n,
    tauBetaX: 37142269533113549537591131345643981951n,
    tauBetaY: 92846388265400743995957747409218517601n,
    u: 66001741173104803338721745994955553010n,
    v: 62245253919818011890633399060291020887n,
    w: 30601134345582732000058913853921008022n,
    z: -28859471639991253843240999485797747790n,
    dSq: 99999999999999999886624093342106115200n,
    swapFee: 10000000000000000n,
    totalShares: 535740808545474n,
    amountIn: 1000000000000000000n,
    amountOut: 989980003877180195n,
};

// Parameters of the Sepolia WETH/USDC GyroE pool 0xbfa2c112…, as the pools subgraph returns them.
const SEPOLIA_GYRO = {
    id: '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9',
    alpha: '0.90909090909090909',
    beta: '1.1',
    c: '0.707106781186547584',
    s: '0.707106781186547456',
    lambda: '4',
    tauAlphaX: '-0.18711210788999487114376173426627837',
    tauAlphaY: '0.982338566422474814877389663079634',
    tauBetaX: '0.1871121078899956503342314077577386',
    tauBetaY: '0.9823385664224746259827303482938255',
    u: '0.1871121078899952725449127781861215',
    v: '0.9823385664224746259827303482938255',
    w: '-0.00000000000000005551115123125782577152',
    z: '0.0000000000000003885780586188047908864',
    dSq: '0.9999999999999999774880982345603403',
};

const liquidity = {
    disableUnbalancedLiquidity: false,
    enableAddLiquidityCustom: false,
    enableDonation: false,
    enableRemoveLiquidityCustom: false,
};

function gyroPool(typeData: Record<string, string>, extra: Record<string, unknown> = {}) {
    const tokenOut = prismaPoolTokenFactory.build({
        address: RECORDED.tokenOut,
        balance: '1',
        priceRate: '1',
        index: 0,
        token: poolTokenFactory.build({ decimals: 18, address: RECORDED.tokenOut }),
    });
    const tokenIn = prismaPoolTokenFactory.build({
        address: RECORDED.tokenIn,
        balance: '1',
        priceRate: '1',
        index: 1,
        token: poolTokenFactory.build({ decimals: 18, address: RECORDED.tokenIn }),
    });
    tokenOut.index = 0;
    tokenIn.index = 1;

    return prismaPoolFactory.build({
        id: RECORDED.pool,
        address: RECORDED.pool,
        chain: Chain.SEPOLIA,
        type: 'ECLP',
        protocolVersion: 3,
        typeData,
        tokens: [tokenOut, tokenIn],
        dynamicData: prismaPoolDynamicDataFactory.build({
            swapFee: formatUnits(RECORDED.swapFee, 18),
            aggregateSwapFee: '0',
            totalShares: formatUnits(RECORDED.totalShares, 18),
        }),
        liquidityManagement: liquidity,
        ...extra,
    });
}

const recordedTypeData = {
    id: RECORDED.pool,
    alpha: formatUnits(RECORDED.alpha, 18),
    beta: formatUnits(RECORDED.beta, 18),
    c: formatUnits(RECORDED.c, 18),
    s: formatUnits(RECORDED.s, 18),
    lambda: formatUnits(RECORDED.lambda, 18),
    tauAlphaX: formatUnits(RECORDED.tauAlphaX, 38),
    tauAlphaY: formatUnits(RECORDED.tauAlphaY, 38),
    tauBetaX: formatUnits(RECORDED.tauBetaX, 38),
    tauBetaY: formatUnits(RECORDED.tauBetaY, 38),
    u: formatUnits(RECORDED.u, 38),
    v: formatUnits(RECORDED.v, 38),
    w: formatUnits(RECORDED.w, 38),
    z: formatUnits(RECORDED.z, 38),
    dSq: formatUnits(RECORDED.dSq, 38),
};

describe('GyroECLPPool', () => {
    const pool = GyroECLPPool.fromPrismaPool(gyroPool(recordedTypeData));

    test('parses decimal parameters back to the on-chain integers', () => {
        expect(pool.getPoolState()).toMatchObject({
            poolType: 'GYROE',
            poolAddress: RECORDED.pool,
            swapFee: RECORDED.swapFee,
            aggregateSwapFee: 0n,
            totalSupply: RECORDED.totalShares,
            balancesLiveScaled18: [parseEther('1'), parseEther('1')],
            tokenRates: [parseEther('1'), parseEther('1')],
            scalingFactors: [1n, 1n],
            paramsAlpha: RECORDED.alpha,
            paramsBeta: RECORDED.beta,
            paramsC: RECORDED.c,
            paramsS: RECORDED.s,
            paramsLambda: RECORDED.lambda,
            tauAlphaX: RECORDED.tauAlphaX,
            tauAlphaY: RECORDED.tauAlphaY,
            tauBetaX: RECORDED.tauBetaX,
            tauBetaY: RECORDED.tauBetaY,
            u: RECORDED.u,
            v: RECORDED.v,
            w: RECORDED.w,
            z: RECORDED.z,
            dSq: RECORDED.dSq,
            supportsUnbalancedLiquidity: true,
        });
    });

    test('quotes the recorded swap', () => {
        const tokenIn = pool.tokens[1].token;
        const tokenOut = pool.tokens[0].token;
        const amountOut = pool.swapGivenIn(tokenIn, tokenOut, TokenAmount.fromRawAmount(tokenIn, RECORDED.amountIn));

        expect(amountOut.amount).toBe(RECORDED.amountOut);
        expect(amountOut.amount).toBeLessThan(RECORDED.amountIn);
    });

    test('a copied pool quotes the same amount and does not share balances', () => {
        const copy = pool.copy();
        const tokenIn = pool.tokens[1].token;
        const tokenOut = pool.tokens[0].token;
        const amount = TokenAmount.fromRawAmount(tokenIn, RECORDED.amountIn);

        pool.swapGivenIn(tokenIn, tokenOut, amount, true);
        const copiedOut = copy.swapGivenIn(tokenIn, tokenOut, amount);

        expect(copiedOut.amount).toBe(RECORDED.amountOut);
        expect(copy.tokens[1].amount).toBe(parseEther('1'));
    });

    test('returns zero when unbalanced liquidity is disabled and the input is BPT', () => {
        const blocked = GyroECLPPool.fromPrismaPool(
            gyroPool(recordedTypeData, {
                liquidityManagement: { ...liquidity, disableUnbalancedLiquidity: true },
            }),
        );
        const bpt = new Token(11155111, blocked.id, 18);
        const out = blocked.swapGivenIn(
            bpt,
            blocked.tokens[0].token,
            TokenAmount.fromRawAmount(bpt, 1000n),
        );

        expect(out.amount).toBe(0n);
        expect(blocked.getLimitAmountSwap(blocked.tokens[1].token, blocked.tokens[0].token, SwapKind.GivenIn)).toBeGreaterThan(
            0n,
        );
    });

    test('an unknown hook does not change the ECLP parameters', () => {
        const hooked = GyroECLPPool.fromPrismaPool(
            gyroPool(recordedTypeData, {
                hook: hookFactory.build(),
            }),
        );
        const state = hooked.getPoolState();

        expect(state.hookType).toBeUndefined();
        expect(state.paramsLambda).toBe(RECORDED.lambda);
    });

    test('reads the Sepolia WETH/USDC GyroE parameters', () => {
        const sepolia = GyroECLPPool.fromPrismaPool(gyroPool(SEPOLIA_GYRO, { id: SEPOLIA_GYRO.id, address: SEPOLIA_GYRO.id }));
        const state = sepolia.getPoolState();

        expect(state.paramsAlpha).toBe(parseEther(SEPOLIA_GYRO.alpha));
        expect(state.paramsBeta).toBe(parseEther(SEPOLIA_GYRO.beta));
        expect(state.paramsC).toBe(parseEther(SEPOLIA_GYRO.c));
        expect(state.paramsS).toBe(parseEther(SEPOLIA_GYRO.s));
        expect(state.paramsLambda).toBe(parseEther(SEPOLIA_GYRO.lambda));
        expect(state.tauAlphaX).toBe(parseUnits(SEPOLIA_GYRO.tauAlphaX, 38));
        expect(state.tauBetaY).toBe(parseUnits(SEPOLIA_GYRO.tauBetaY, 38));
        expect(state.dSq).toBe(parseUnits(SEPOLIA_GYRO.dSq, 38));
    });

    test('rejects a pool with no dynamic data, no price rate, or an unknown token', () => {
        const missingData = gyroPool(recordedTypeData);
        missingData.dynamicData = null;
        expect(() => GyroECLPPool.fromPrismaPool(missingData)).toThrow(/dynamic data/);

        const missingRate = gyroPool(recordedTypeData);
        missingRate.tokens[0].priceRate = null as unknown as string;
        expect(() => GyroECLPPool.fromPrismaPool(missingRate)).toThrow(/price rate/);

        const stranger = new Token(11155111, '0x0000000000000000000000000000000000000001', 18);
        expect(() => pool.getPoolTokens(stranger, pool.tokens[0].token)).toThrow(/does not contain/);
    });
});
