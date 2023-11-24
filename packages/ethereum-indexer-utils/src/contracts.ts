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

export function loadContracts<ABI extends Abi>(folderOrFile: string): IndexingSource<ABI> {
	if (fs.statSync(folderOrFile).isDirectory()) {
		return loadContractsFromFolder(folderOrFile);
	} else {
		return loadContractsFromFile(folderOrFile)
	}
}


export function loadContractsFromFile<ABI extends Abi>(file: string): IndexingSource<ABI> {

	let contractSTR = fs.readFileSync(file, 'utf-8');
	if (contractSTR.startsWith('export default {') && contractSTR.endsWith('} as const;')) {
		contractSTR = contractSTR.slice(15, -10);
	}
	const contracts = JSON.parse(contractSTR);

	return {
		chainId: contracts.chainId,
			contracts: Object.keys(contracts.contracts).map(
				(name) => (contracts as any).contracts[name],
			),
	}
}



export function loadContractsFromFolder<ABI extends Abi>(folder: string): IndexingSource<ABI> {
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
		const startBlock = deployment.receipt?.blockNumber
			? typeof deployment.receipt?.blockNumber === 'string'
				? parseInt(deployment.receipt?.blockNumber.slice(2), 16)
				: deployment.receipt?.blockNumber
			: undefined;
		if (added) {
			if (startBlock) {
				if (!contractsData[added.index].startBlock || (contractsData[added.index].startBlock as number) > startBlock) {
					(contractsData[added.index] as any).startBlock = startBlock;
				}
			}
			(contractsData[added.index] as any).abi = mergeABIs((contractsData[added.index] as any).abi, deployment.abi);
		} else {
			contractsData.push({
				address: deployment.address,
				abi: deployment.abi,
				startBlock,
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
