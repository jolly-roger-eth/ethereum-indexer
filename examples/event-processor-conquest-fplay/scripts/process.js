const admin = `0xbe19b59e8c588d68f475a407c7ba5fe813aeb792`;
const outerspace = `0x7ed5118E042F22DA546C9aaA9540D515A6F776E9`;
const accounts = [];
async function main() {
	let total = 0n;
	let inOuterSpace = 0n;
	let inAdminHands = 0n;
	let inPlayerHands = 0n;
	let list = [];
	for (const account of accounts) {
		const amount = BigInt(account.amount.slice(0, -1));
		total += amount;
		if (account.address.toLowerCase() === outerspace.toLowerCase()) {
			inOuterSpace += amount;
		} else {
			inPlayerHands += amount;
			list.push({from: account.address.toLowerCase(), amount});
		}
	}
	console.log({total, inAdminHands, inOuterSpace, inPlayerHands});
	console.log({num: list.length, accounts: accounts.length});

	// console.log(list.map((v) => ({from: v.from, amount: v.amount.toString()})));
}

main();
