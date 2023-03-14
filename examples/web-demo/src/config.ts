import {getHashParamsFromLocation, getParamsFromLocation} from './lib/utils/web';

export const globalQueryParams = ['debug', 'log', 'ethnode', '_d_eruda'];

export const hashParams = getHashParamsFromLocation();
export const {params} = getParamsFromLocation();
