/**
 * Prints the fixture's fingerprint, to be run as a SEPARATE PROCESS by
 * `processorFingerprint.test.ts`. See the test for why a second process is the
 * only thing that can prove stability across restarts.
 */
import {fixtureFingerprint} from './fingerprintFixture.js';

process.stdout.write(String(fixtureFingerprint()));
