#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

// hooks the named-logs facade to the console. Done HERE, in the process entry
// point, and never in the library: a fetcher's log lines are the only
// observability a deployment has, but an application embedding `startFetcher`
// gets to choose its own sink.
import 'named-logs-console';

import {runFetcherProcess} from './index.js';

process.exit(await runFetcherProcess());
