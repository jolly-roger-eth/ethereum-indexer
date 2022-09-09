import {
  EventWithId,
  fromSingleJSONEventProcessorObject,
  SingleJSONEventProcessorObject,
} from 'ethereum-indexer-json-processor';

import { logs } from 'named-logs';

import eip721 from './eip721.json';
import { Data, Spaceship } from './types';

const namedLogger = logs('VoidrunnerEventProcessor');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const VoidrunnerEventProcessor: SingleJSONEventProcessorObject<Data> = {
  async setup(json: Data): Promise<void> {
    json.voidrunners = [];
    json.spaceships = [];
    namedLogger.info(`setup complete!`);
  },
  onTransfer(data: Data, event: EventWithId) {
    namedLogger.info(`onTransfer...`);

    const to = event.args.to as string;

    const tokenID = event.args.id as string;

    let spaceship: Spaceship;
    let spaceshipIndex = data.spaceships.findIndex((v) => v.tokenID === tokenID);
    if (spaceshipIndex !== -1) {
      spaceship = data.spaceships[spaceshipIndex];
    }

    if (!spaceship) {
      namedLogger.info(`new token ${tokenID}: with owner: ${to}`);
      spaceship = {
        tokenID,
        owner: to,
      };
      data.spaceships.push(spaceship);
    } else {
      namedLogger.info(`token ${tokenID} already exists`);
      if (to === ZERO_ADDRESS) {
        namedLogger.info(`deleting it...`);
        data.spaceships.splice(spaceshipIndex, 1);
        return;
      } else {
        namedLogger.info(`setting new owner: ${to}`);
        spaceship.owner = to;
      }
    }

    namedLogger.info(JSON.stringify(data, null, 2));
  },
};

// we export a factory function called processor
// the helper "fromSingleEventProcessorObject" will transform the single event processor...
// ... into the processor type expected by ethereum-indexer-server
export const processor = fromSingleJSONEventProcessorObject(() => VoidrunnerEventProcessor);

// we expose contractsData as generic to be used on any chain
export const contractsData = [
  {
    eventsABI: eip721,
    address: '0x4658e9c5e1e05280e3708741aba63b7ff4e81055',
    startBlock: 14953977,
  },
];

// we also expose a object keyed by chainId
export const contractsDataPerChain = { 1: contractsData };
