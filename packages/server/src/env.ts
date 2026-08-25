export type Env = {
	DEV?: string;
	/**
	 * The shared secret a log-fetcher presents as `Authorization: Bearer <token>`
	 * to reach `/ingest`.
	 *
	 * OPTIONAL in the type and REQUIRED in effect: with no token configured the
	 * server can authenticate nobody, so every ingestion call is refused with 401.
	 * That is the fail-closed direction on purpose. The retired server generated a
	 * key at boot and printed it to stdout, which is a server whose security is a
	 * line in a log file, and it is not repeated here.
	 */
	INGEST_TOKEN?: string;
};
