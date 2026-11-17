import { YbAprConfig } from '../../token-yields';

export interface AprHandlerConfigs {
    ybAprHandler?: YbAprConfig;
    merklAprHandler?: boolean;
    aaveRewardsAprHandler?: boolean;
    morphoRewardsAprHandler?: boolean;
}
