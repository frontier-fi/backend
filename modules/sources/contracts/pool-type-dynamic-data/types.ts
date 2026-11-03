export type PoolTypeData = {
    typeData: StableTypeData;
};

export type StableTypeData = {
    amp: string;
    bptPriceRate: string;
    ampIsUpdating?: boolean;
    ampStartValue?: string;
    ampEndValue?: string;
    ampStartTime?: string;
    ampEndTime?: string;
};
