/**
 * The merged ABI the stratagems indexer sees, as a TS literal.
 *
 * GENERATED from github.com/wighawag/stratagems @ 3d5a0b3f, contracts
 * deployments/base/{Stratagems,Gems,GemsGenerator}.json, which is the same three
 * contracts the real indexer is configured with, with same-named duplicates
 * dropped exactly as `LogEventFetcher` drops them.
 *
 * The last three events (AccounFixedRewardUpdated, AccountSharedRewardUpdated,
 * GlobalRewardUpdated) are taken from deployments/alpha1/GemsGenerator.json.
 * They do NOT exist on the `deployments/base` GemsGenerator, which is an earlier
 * version of the contract, so on the `stratagems-base` fixture the three
 * handlers that consume them cannot fire; on `stratagems-alpha1`, the LAUNCHED
 * game, they are 16,046 of the 31,332 events. Read `../../fixtures/README.md`
 * before assuming `base` means "the Base deployment": it does not.
 */
export const stratagemsABI = [
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
		],
		name: 'CommitmentCancelled',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				indexed: false,
				internalType: 'bytes24',
				name: 'commitmentHash',
				type: 'bytes24',
			},
		],
		name: 'CommitmentMade',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				indexed: true,
				internalType: 'bytes24',
				name: 'commitmentHash',
				type: 'bytes24',
			},
			{
				components: [
					{
						internalType: 'uint64',
						name: 'position',
						type: 'uint64',
					},
					{
						internalType: 'enum UsingStratagemsTypes.Color',
						name: 'color',
						type: 'uint8',
					},
				],
				indexed: false,
				internalType: 'struct UsingStratagemsTypes.Move[]',
				name: 'moves',
				type: 'tuple[]',
			},
			{
				indexed: false,
				internalType: 'bytes24',
				name: 'furtherMoves',
				type: 'bytes24',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'newReserveAmount',
				type: 'uint256',
			},
		],
		name: 'CommitmentRevealed',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'amountBurnt',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'bytes24',
				name: 'furtherMoves',
				type: 'bytes24',
			},
		],
		name: 'CommitmentVoid',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint64',
				name: 'position',
				type: 'uint64',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'enum UsingStratagemsTypes.Color',
				name: 'oldColor',
				type: 'uint8',
			},
			{
				indexed: false,
				internalType: 'enum UsingStratagemsTypes.Color',
				name: 'newColor',
				type: 'uint8',
			},
		],
		name: 'MoveProcessed',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				indexed: false,
				internalType: 'uint64[]',
				name: 'positions',
				type: 'uint64[]',
			},
		],
		name: 'MultiPoke',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'amountDeposited',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'newAmount',
				type: 'uint256',
			},
		],
		name: 'ReserveDeposited',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'player',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'amountWithdrawn',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'newAmount',
				type: 'uint256',
			},
		],
		name: 'ReserveWithdrawn',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				indexed: false,
				internalType: 'uint64',
				name: 'position',
				type: 'uint64',
			},
		],
		name: 'SinglePoke',
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
				internalType: 'address',
				name: 'approved',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'uint256',
				name: 'tokenID',
				type: 'uint256',
			},
		],
		name: 'Approval',
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
				name: 'tokenID',
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
				components: [
					{
						internalType: 'uint64',
						name: 'position',
						type: 'uint64',
					},
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'uint24',
						name: 'lastEpochUpdate',
						type: 'uint24',
					},
					{
						internalType: 'uint24',
						name: 'epochWhenTokenIsAdded',
						type: 'uint24',
					},
					{
						internalType: 'enum UsingStratagemsTypes.Color',
						name: 'color',
						type: 'uint8',
					},
					{
						internalType: 'uint8',
						name: 'life',
						type: 'uint8',
					},
					{
						internalType: 'int8',
						name: 'delta',
						type: 'int8',
					},
					{
						internalType: 'uint8',
						name: 'enemyMap',
						type: 'uint8',
					},
				],
				indexed: false,
				internalType: 'struct UsingStratagemsDebugTypes.DebugCell[]',
				name: 'cells',
				type: 'tuple[]',
			},
		],
		name: 'ForceCells',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'uint24',
				name: 'epoch',
				type: 'uint24',
			},
			{
				components: [
					{
						internalType: 'uint64',
						name: 'position',
						type: 'uint64',
					},
					{
						internalType: 'address',
						name: 'owner',
						type: 'address',
					},
					{
						internalType: 'enum UsingStratagemsTypes.Color',
						name: 'color',
						type: 'uint8',
					},
					{
						internalType: 'uint8',
						name: 'life',
						type: 'uint8',
					},
					{
						internalType: 'uint8',
						name: 'stake',
						type: 'uint8',
					},
				],
				indexed: false,
				internalType: 'struct UsingStratagemsDebugTypes.SimpleCell[]',
				name: 'cells',
				type: 'tuple[]',
			},
		],
		name: 'ForceSimpleCells',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: 'address',
				name: 'generator',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'bool',
				name: 'enabled',
				type: 'bool',
			},
		],
		name: 'GeneratorEnabled',
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
		],
		name: 'OwnershipTransferred',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'game',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'weight',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timestamp',
				type: 'uint256',
			},
		],
		name: 'GameEnabled',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
			{
				components: [
					{
						internalType: 'uint112',
						name: 'toWithdraw',
						type: 'uint112',
					},
					{
						internalType: 'uint40',
						name: 'lastTime',
						type: 'uint40',
					},
				],
				indexed: false,
				internalType: 'struct RewardsGenerator.FixedRatePerAccount',
				name: 'fixedRateStatus',
				type: 'tuple',
			},
		],
		name: 'AccounFixedRewardUpdated',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'account',
				type: 'address',
			},
			{
				components: [
					{
						internalType: 'uint112',
						name: 'points',
						type: 'uint112',
					},
					{
						internalType: 'uint104',
						name: 'totalRewardPerPointAccounted',
						type: 'uint104',
					},
					{
						internalType: 'uint112',
						name: 'rewardsToWithdraw',
						type: 'uint112',
					},
				],
				indexed: false,
				internalType: 'struct RewardsGenerator.SharedRatePerAccount',
				name: 'sharedRateStatus',
				type: 'tuple',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'timestamp',
				type: 'uint256',
			},
		],
		name: 'AccountSharedRewardUpdated',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				components: [
					{
						internalType: 'uint40',
						name: 'lastUpdateTime',
						type: 'uint40',
					},
					{
						internalType: 'uint104',
						name: 'totalRewardPerPointAtLastUpdate',
						type: 'uint104',
					},
					{
						internalType: 'uint112',
						name: 'totalPoints',
						type: 'uint112',
					},
				],
				indexed: false,
				internalType: 'struct RewardsGenerator.GlobalState',
				name: 'globalStatus',
				type: 'tuple',
			},
		],
		name: 'GlobalRewardUpdated',
		type: 'event',
	},
] as const;

export type StratagemsABI = typeof stratagemsABI;
