import type { ContractData } from 'ethereum-indexer';
import fs from 'fs';
import path from 'path';

function mergeABIs(abi1: any[], abi2: any[]): any[] {
  const namesUsed: { [name: string]: boolean } = {};
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

export function loadContracts(folder: string): ContractData[] {
  const contractsAdded: { [address: string]: { index: number } } = {};
  const contractsData: ContractData[] = [];
  const files = fs.readdirSync(folder);
  for (const file of files) {
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
          contractsData[added.index].startBlock > deployment.receipt?.blockNumber
        ) {
          contractsData[added.index].startBlock = deployment.receipt?.blockNumber;
        }
      }
      contractsData[added.index].eventsABI = mergeABIs(contractsData[added.index].eventsABI, deployment.abi);
    } else {
      contractsData.push({
        address: deployment.address,
        eventsABI: deployment.abi,
        startBlock: deployment.receipt?.blockNumber,
      });
      contractsAdded[deployment.address] = { index: contractsData.length - 1 };
    }
  }
  return contractsData;
}
