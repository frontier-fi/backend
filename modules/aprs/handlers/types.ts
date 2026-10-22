import { YbAprConfig } from '../../token-yields';

export interface AprHandlerConfigs {
    ybAprHandler?: YbAprConfig;
    aaveRewardsAprHandler?: boolean;
    morphoRewardsAprHandler?: boolean;
}
