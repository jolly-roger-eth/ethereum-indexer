#!/usr/bin/env ts-node
import 'dotenv/config';
import 'named-logs-console'; // active named-logs and use console as basic logger

const oclif = require('@oclif/core');

oclif.run().then(require('@oclif/core/flush')).catch(require('@oclif/core/handle'));
