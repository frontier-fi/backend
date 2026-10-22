import { AprService } from '../';
import { Chain } from '@prisma/client';

async function calculationExample(
    chain: Chain = 'SEPOLIA',
    poolId = '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9',
) {
    const service = new AprService();

    if (poolId) {
        const items = await service.calculateAprForPool(chain, poolId);

        console.log('\nAPR Items:');
        items.forEach((item) => {
            console.log(`- ${item.title}: ${item.apr}`);
        });
    }
}

// Run the example
calculationExample(process.argv[2] as Chain, process.argv[3])
    .catch(console.error)
    .finally(() => process.exit(0));
