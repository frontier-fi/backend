import { AprService } from '../';
import { Chain } from '@prisma/client';
import { logger } from '../../common/logger';

async function calculationExample(chain: Chain = 'SEPOLIA', poolId = '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9') {
    const service = new AprService();

    if (poolId) {
        const items = await service.calculateAprForPool(chain, poolId);
        logger.info('Calculated pool APR items', { chain, poolId, items });
    }
}

// Run the example
calculationExample(process.argv[2] as Chain, process.argv[3])
    .catch((err) => logger.error('APR calculation example failed', { err }))
    .finally(() => process.exit(0));
