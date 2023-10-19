export default [
	{
		inputs: [
			{
				internalType: 'address',
				name: '_contractOwner',
				type: 'address',
			},
			{
				components: [
					{
						internalType: 'address',
						name: 'facetAddress',
						type: 'address',
					},
					{
						internalType: 'enum IDiamondCut.FacetCutAction',
						name: 'action',
						type: 'uint8',
					},
					{
						internalType: 'bytes4[]',
						name: 'functionSelectors',
						type: 'bytes4[]',
					},
				],
				internalType: 'struct IDiamondCut.FacetCut[]',
				name: '_diamondCut',
				type: 'tuple[]',
			},
			{
				components: [
					{
						internalType: 'address',
						name: 'initContract',
						type: 'address',
					},
					{
						internalType: 'bytes',
						name: 'initData',
						type: 'bytes',
					},
				],
				internalType: 'struct Diamond.Initialization[]',
				name: '_initializations',
				type: 'tuple[]',
			},
		],
		stateMutability: 'payable',
		type: 'constructor',
	},
	{
		stateMutability: 'payable',
		type: 'fallback',
	},
	{
		stateMutability: 'payable',
		type: 'receive',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'operator',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'approved',
				type: 'bool',
			},
		],
		name: 'ApprovalForAll',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'uint256',
				name: 'block',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timestamp',
				type: 'uint256',
			},
		],
		name: 'BlockTime',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'stake',
				type: 'uint256',
			},
		],
		name: 'ExitComplete',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'fleet',
				type: 'uint256',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'fleetOwner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'destinationOwner',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'destination',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'gift',
				type: 'bool',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'won',
				type: 'bool',
			},
			{
				components: [
					{
						internalType: 'uint32',
						name: 'newNumspaceships',
						type: 'uint32',
					},
					{
						internalType: 'int40',
						name: 'newTravelingUpkeep',
						type: 'int40',
					},
					{
						internalType: 'uint32',
						name: 'newOverflow',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'numSpaceshipsAtArrival',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'taxLoss',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'fleetLoss',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'planetLoss',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'inFlightFleetLoss',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'inFlightPlanetLoss',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'accumulatedDefenseAdded',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'accumulatedAttackAdded',
						type: 'uint32',
					},
				],
				indexed: false,
				internalType: 'struct ImportingOuterSpaceEvents.ArrivalData',
				name: 'data',
				type: 'tuple',
			},
		],
		name: 'FleetArrived',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'fleetSender',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'fleetOwner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'from',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'address',
				name: 'operator',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'fleet',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'quantity',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newNumSpaceships',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'int40',
				name: 'newTravelingUpkeep',
				type: 'int40',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newOverflow',
				type: 'uint32',
			},
		],
		name: 'FleetSent',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'address',
				name: 'newGeneratorAdmin',
				type: 'address',
			},
		],
		name: 'GeneratorAdminChanged',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'address',
				name: 'newGenerator',
				type: 'address',
			},
		],
		name: 'GeneratorChanged',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'bytes32',
				name: 'genesis',
				type: 'bytes32',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'resolveWindow',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timePerDistance',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'exitDuration',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'acquireNumSpaceships',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'productionSpeedUp',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'frontrunningDelay',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'productionCapAsDuration',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'upkeepProductionDecreaseRatePer10000th',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'fleetSizeFactor6',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'initialSpaceExpansion',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'expansionDelta',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'giftTaxPer10000',
				type: 'uint256',
			},
		],
		name: 'Initialized',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'PlanetExit',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'PlanetReset',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'acquirer',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'numSpaceships',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'int40',
				name: 'travelingUpkeep',
				type: 'int40',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'overflow',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'stake',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'freegift',
				type: 'bool',
			},
		],
		name: 'PlanetStake',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'previousOwner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'newOwner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newNumspaceships',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'int40',
				name: 'newTravelingUpkeep',
				type: 'int40',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newOverflow',
				type: 'uint32',
			},
		],
		name: 'PlanetTransfer',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'giver',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'rewardId',
				type: 'uint256',
			},
		],
		name: 'RewardSetup',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'rewardId',
				type: 'uint256',
			},
		],
		name: 'RewardToWithdraw',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'newStake',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'freegift',
				type: 'bool',
			},
		],
		name: 'StakeToWithdraw',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'from',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'to',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'Transfer',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'origin',
				type: 'uint256',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'fleet',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newNumspaceships',
				type: 'uint32',
			},
			{
				indexed: false,
				internalType: 'int40',
				name: 'newTravelingUpkeep',
				type: 'int40',
			},
			{
				indexed: false,
				internalType: 'uint32',
				name: 'newOverflow',
				type: 'uint32',
			},
		],
		name: 'TravelingUpkeepRefund',
		type: 'event',
	},
	{
		inputs: [],
		name: 'init',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'generator',
		outputs: [
			{
				internalType: 'contract IOnStakeChange',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'generatorAdmin',
		outputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'contract IOnStakeChange',
				name: 'newGenerator',
				type: 'address',
			},
		],
		name: 'setGenerator',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'newAdmin',
				type: 'address',
			},
		],
		name: 'setGeneratorAdmin',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'fleetId',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'from',
				type: 'uint256',
			},
		],
		name: 'getFleet',
		outputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'uint40',
				name: 'launchTime',
				type: 'uint40',
			},
			{
				internalType: 'uint32',
				name: 'quantity',
				type: 'uint32',
			},
			{
				internalType: 'uint64',
				name: 'flyingAtLaunch',
				type: 'uint64',
			},
			{
				internalType: 'uint64',
				name: 'destroyedAtLaunch',
				type: 'uint64',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'fleetId',
				type: 'uint256',
			},
			{
				components: [
					{
						internalType: 'uint256',
						name: 'from',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'to',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'distance',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'arrivalTimeWanted',
						type: 'uint256',
					},
					{
						internalType: 'bool',
						name: 'gift',
						type: 'bool',
					},
					{
						internalType: 'address',
						name: 'specific',
						type: 'address',
					},
					{
						internalType: 'bytes32',
						name: 'secret',
						type: 'bytes32',
					},
					{
						internalType: 'address',
						name: 'fleetSender',
						type: 'address',
					},
					{
						internalType: 'address',
						name: 'operator',
						type: 'address',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.FleetResolution',
				name: 'resolution',
				type: 'tuple',
			},
		],
		name: 'resolveFleet',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'from',
				type: 'uint256',
			},
			{
				internalType: 'uint32',
				name: 'quantity',
				type: 'uint32',
			},
			{
				internalType: 'bytes32',
				name: 'toHash',
				type: 'bytes32',
			},
		],
		name: 'send',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'fleetSender',
						type: 'address',
					},
					{
						internalType: 'address',
						name: 'fleetOwner',
						type: 'address',
					},
					{
						internalType: 'uint256',
						name: 'from',
						type: 'uint256',
					},
					{
						internalType: 'uint32',
						name: 'quantity',
						type: 'uint32',
					},
					{
						internalType: 'bytes32',
						name: 'toHash',
						type: 'bytes32',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.FleetLaunch',
				name: 'launch',
				type: 'tuple',
			},
		],
		name: 'sendFor',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'contractURI',
		outputs: [
			{
				internalType: 'string',
				name: '',
				type: 'string',
			},
		],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'getPlanet',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'uint40',
						name: 'ownershipStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint40',
						name: 'exitStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint32',
						name: 'numSpaceships',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'overflow',
						type: 'uint32',
					},
					{
						internalType: 'uint40',
						name: 'lastUpdated',
						type: 'uint40',
					},
					{
						internalType: 'bool',
						name: 'active',
						type: 'bool',
					},
					{
						internalType: 'uint256',
						name: 'reward',
						type: 'uint256',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.ExternalPlanet',
				name: 'state',
				type: 'tuple',
			},
			{
				components: [
					{
						internalType: 'int8',
						name: 'subX',
						type: 'int8',
					},
					{
						internalType: 'int8',
						name: 'subY',
						type: 'int8',
					},
					{
						internalType: 'uint32',
						name: 'stake',
						type: 'uint32',
					},
					{
						internalType: 'uint16',
						name: 'production',
						type: 'uint16',
					},
					{
						internalType: 'uint16',
						name: 'attack',
						type: 'uint16',
					},
					{
						internalType: 'uint16',
						name: 'defense',
						type: 'uint16',
					},
					{
						internalType: 'uint16',
						name: 'speed',
						type: 'uint16',
					},
					{
						internalType: 'uint16',
						name: 'natives',
						type: 'uint16',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.PlanetStats',
				name: 'stats',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'getPlanetState',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'uint40',
						name: 'ownershipStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint40',
						name: 'exitStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint32',
						name: 'numSpaceships',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'overflow',
						type: 'uint32',
					},
					{
						internalType: 'uint40',
						name: 'lastUpdated',
						type: 'uint40',
					},
					{
						internalType: 'bool',
						name: 'active',
						type: 'bool',
					},
					{
						internalType: 'uint256',
						name: 'reward',
						type: 'uint256',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.ExternalPlanet',
				name: 'state',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'getUpdatedPlanetState',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'uint40',
						name: 'ownershipStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint40',
						name: 'exitStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint32',
						name: 'numSpaceships',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'overflow',
						type: 'uint32',
					},
					{
						internalType: 'uint40',
						name: 'lastUpdated',
						type: 'uint40',
					},
					{
						internalType: 'bool',
						name: 'active',
						type: 'bool',
					},
					{
						internalType: 'uint256',
						name: 'reward',
						type: 'uint256',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.ExternalPlanet',
				name: 'state',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'operator',
				type: 'address',
			},
		],
		name: 'isApprovedForAll',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'name',
		outputs: [
			{
				internalType: 'string',
				name: '_name',
				type: 'string',
			},
		],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'ownerAndOwnershipStartTimeOf',
		outputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'uint40',
				name: 'ownershipStartTime',
				type: 'uint40',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'ownerOf',
		outputs: [
			{
				internalType: 'address',
				name: 'currentOwner',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'from',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'to',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'safeTransferFrom',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'from',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'to',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'safeTransferFrom',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'operator',
				type: 'address',
			},
			{
				internalType: 'bool',
				name: 'approved',
				type: 'bool',
			},
		],
		name: 'setApprovalForAll',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'contract IApprovalForAllReceiver',
				name: 'operator',
				type: 'address',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'setApprovalForAllIfNeededAndCall',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'symbol',
		outputs: [
			{
				internalType: 'string',
				name: '_symbol',
				type: 'string',
			},
		],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: '_tokenId',
				type: 'uint256',
			},
		],
		name: 'tokenURI',
		outputs: [
			{
				internalType: 'string',
				name: 'uri',
				type: 'string',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'from',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'to',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'transferFrom',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'getAllianceRegistry',
		outputs: [
			{
				internalType: 'contract AllianceRegistry',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'getDiscovered',
		outputs: [
			{
				components: [
					{
						internalType: 'uint32',
						name: 'minX',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'maxX',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'minY',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'maxY',
						type: 'uint32',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.Discovered',
				name: '',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'getGeneisHash',
		outputs: [
			{
				internalType: 'bytes32',
				name: '',
				type: 'bytes32',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256[]',
				name: 'locations',
				type: 'uint256[]',
			},
		],
		name: 'getPlanetStates',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'uint40',
						name: 'ownershipStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint40',
						name: 'exitStartTime',
						type: 'uint40',
					},
					{
						internalType: 'uint32',
						name: 'numSpaceships',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'overflow',
						type: 'uint32',
					},
					{
						internalType: 'uint40',
						name: 'lastUpdated',
						type: 'uint40',
					},
					{
						internalType: 'bool',
						name: 'active',
						type: 'bool',
					},
					{
						internalType: 'uint256',
						name: 'reward',
						type: 'uint256',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.ExternalPlanet[]',
				name: 'planetStates',
				type: 'tuple[]',
			},
			{
				components: [
					{
						internalType: 'uint32',
						name: 'minX',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'maxX',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'minY',
						type: 'uint32',
					},
					{
						internalType: 'uint32',
						name: 'maxY',
						type: 'uint32',
					},
				],
				internalType: 'struct ImportingOuterSpaceTypes.Discovered',
				name: 'discovered',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
		],
		name: 'acquireViaFreeTokenTransferFrom',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
		],
		name: 'acquireViaTransferFrom',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'balanceToWithdraw',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'exitFor',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'uint256[]',
				name: 'locations',
				type: 'uint256[]',
			},
		],
		name: 'fetchAndWithdrawFor',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'forAddress',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'onTokenPaidFor',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'onTokenTransfer',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'withdrawFor',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'addReward',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'sponsor',
				type: 'address',
			},
		],
		name: 'getPrevRewardIds',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'location',
				type: 'uint256',
			},
		],
		name: 'getRewardId',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'fullRewardId',
				type: 'uint256',
			},
		],
		name: 'hasRewardGoalBeenAchieved',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		anonymous: false,
		inputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'facetAddress',
						type: 'address',
					},
					{
						internalType: 'enum IDiamondCut.FacetCutAction',
						name: 'action',
						type: 'uint8',
					},
					{
						internalType: 'bytes4[]',
						name: 'functionSelectors',
						type: 'bytes4[]',
					},
				],
				indexed: false,
				internalType: 'struct IDiamondCut.FacetCut[]',
				name: '_diamondCut',
				type: 'tuple[]',
			},
			{
				indexed: false,
				internalType: 'address',
				name: '_init',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'bytes',
				name: '_calldata',
				type: 'bytes',
			},
		],
		name: 'DiamondCut',
		type: 'event',
	},
	{
		inputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'facetAddress',
						type: 'address',
					},
					{
						internalType: 'enum IDiamondCut.FacetCutAction',
						name: 'action',
						type: 'uint8',
					},
					{
						internalType: 'bytes4[]',
						name: 'functionSelectors',
						type: 'bytes4[]',
					},
				],
				internalType: 'struct IDiamondCut.FacetCut[]',
				name: '_diamondCut',
				type: 'tuple[]',
			},
			{
				internalType: 'address',
				name: '_init',
				type: 'address',
			},
			{
				internalType: 'bytes',
				name: '_calldata',
				type: 'bytes',
			},
		],
		name: 'diamondCut',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'previousOwner',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'newOwner',
				type: 'address',
			},
		],
		name: 'OwnershipTransferred',
		type: 'event',
	},
	{
		inputs: [],
		name: 'owner',
		outputs: [
			{
				internalType: 'address',
				name: 'owner_',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: '_newOwner',
				type: 'address',
			},
		],
		name: 'transferOwnership',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'bytes4',
				name: '_functionSelector',
				type: 'bytes4',
			},
		],
		name: 'facetAddress',
		outputs: [
			{
				internalType: 'address',
				name: 'facetAddress_',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'facetAddresses',
		outputs: [
			{
				internalType: 'address[]',
				name: 'facetAddresses_',
				type: 'address[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: '_facet',
				type: 'address',
			},
		],
		name: 'facetFunctionSelectors',
		outputs: [
			{
				internalType: 'bytes4[]',
				name: 'facetFunctionSelectors_',
				type: 'bytes4[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'facets',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'facetAddress',
						type: 'address',
					},
					{
						internalType: 'bytes4[]',
						name: 'functionSelectors',
						type: 'bytes4[]',
					},
				],
				internalType: 'struct IDiamondLoupe.Facet[]',
				name: 'facets_',
				type: 'tuple[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'bytes4',
				name: '_interfaceId',
				type: 'bytes4',
			},
		],
		name: 'supportsInterface',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
