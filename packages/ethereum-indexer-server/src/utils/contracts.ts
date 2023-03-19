import type {Abi, ContractData, IndexingSource} from 'ethereum-indexer';
import fs from 'fs';
import path from 'path';

function mergeABIs(abi1: any[], abi2: any[]): any[] {
	const namesUsed: {[name: string]: boolean} = {};
	const newABI = [];
	for (const fragment of abi1) {
		namesUsed[fragment.name] = true;
		newABI.push(fragment);
	}
	for (const fragment of abi2) {
		if (!namesUsed[fragment.name]) {
			namesUsed[fragment.name] = true;
			newABI.push(fragment);
		}
	}
	return newABI;
}

export function loadContracts<ABI extends Abi>(folder: string): IndexingSource<ABI> {
	const contractsAdded: {[address: string]: {index: number}} = {};
	const contractsData: ContractData<ABI>[] = [];
	const files = fs.readdirSync(folder);
	let chainId = undefined;
	for (const file of files) {
		if (file === '.chainId') {
			chainId = fs.readFileSync(path.join(folder, file), 'utf8');
			continue;
		}
		if (!file.endsWith('.json')) {
			continue;
		}
		const content = fs.readFileSync(path.join(folder, file), 'utf8');
		const deployment = JSON.parse(content);
		if (!deployment.address) {
			continue;
		}
		const added = contractsAdded[deployment.address];
		if (added) {
			if (deployment.receipt?.blockNumber) {
				if (
					!contractsData[added.index].startBlock ||
					(contractsData[added.index].startBlock as number) > deployment.receipt?.blockNumber
				) {
					(contractsData[added.index] as any).startBlock = deployment.receipt?.blockNumber;
				}
			}
			(contractsData[added.index] as any).abi = mergeABIs((contractsData[added.index] as any).abi, deployment.abi);
		} else {
			contractsData.push({
				address: deployment.address,
				abi: deployment.abi,
				startBlock: deployment.receipt?.blockNumber,
			});
			contractsAdded[deployment.address] = {index: contractsData.length - 1};
		}
	}

	if (!chainId || isNaN(parseInt(chainId))) {
		throw new Error(`invalid chainId: ${chainId}`);
	}
	return {
		chainId,
		contracts: contractsData,
	};
}
