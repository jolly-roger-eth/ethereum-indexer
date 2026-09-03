#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {createProgram} from './program.js';

createProgram().parse(process.argv);
