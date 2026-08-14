#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FINAL_RULES_PATH = 'firestore.rules';
const TRANSITION_RULES_PATH = 'firestore.transaction-privacy-transition.rules';
const TRANSITION_CONFIG_PATH = 'firebase.transaction-privacy-transition.json';

const FINAL_TRANSACTION_BLOCK = `      match /transactions/{transactionId} {
        // Canonical transaction records can contain pending waiver intent and
        // operational identifiers. They are server-only after Social Batch C1B.
        allow read, create, update, delete: if false;
      }
`;
const TRANSITION_TRANSACTION_BLOCK = `      match /transactions/{transactionId} {
        // Temporary C1B migration bridge: RC27 may still read canonical records
        // while RC28 is deployed and proven against the private projections.
        allow read: if isLeagueMember(leagueId);
        allow create, update, delete: if false;
      }
`;
const FINAL_WAIVER_BLOCK = `      match /waivers/{waiverId} {
        // Canonical waiver documents contain every private claim and are read
        // only by trusted Functions. Browsers use waiverPool and their own
        // members/{ownerId}/waiverClaims projection instead.
        allow read, create, update, delete: if false;
      }
`;
const TRANSITION_WAIVER_BLOCK = `      match /waivers/{waiverId} {
        // Temporary C1B migration bridge: retain the inherited member read only
        // until RC28 Hosting is verified, then deploy the final server-only rule.
        allow read: if isLeagueMember(leagueId);
        allow create, update, delete: if false;
      }
`;

const [finalRules, transitionRules, defaultConfigSource, transitionConfigSource] =
  await Promise.all([
    readFile(FINAL_RULES_PATH, 'utf8'),
    readFile(TRANSITION_RULES_PATH, 'utf8'),
    readFile('firebase.json', 'utf8'),
    readFile(TRANSITION_CONFIG_PATH, 'utf8'),
  ]);

assert.equal(
  finalRules.includes(FINAL_TRANSACTION_BLOCK),
  true,
  'The final canonical transaction rule must remain server-only.',
);
assert.equal(
  finalRules.includes(FINAL_WAIVER_BLOCK),
  true,
  'The final canonical waiver rule must remain server-only.',
);

const expectedTransition = finalRules
  .replace(FINAL_TRANSACTION_BLOCK, TRANSITION_TRANSACTION_BLOCK)
  .replace(FINAL_WAIVER_BLOCK, TRANSITION_WAIVER_BLOCK);

assert.equal(
  transitionRules,
  expectedTransition,
  'The transition Rules file may differ from final Rules only at the two canonical read gates.',
);

const defaultConfig = JSON.parse(defaultConfigSource);
const transitionConfig = JSON.parse(transitionConfigSource);
assert.equal(defaultConfig.firestore?.rules, FINAL_RULES_PATH);
assert.equal(transitionConfig.firestore?.rules, TRANSITION_RULES_PATH);
assert.equal(transitionConfig.firestore?.indexes, 'firestore.indexes.json');
assert.equal('hosting' in transitionConfig, false);
assert.equal('functions' in transitionConfig, false);

console.log(
  'Transaction privacy transition Rules audit passed: only canonical member reads remain temporarily enabled; final Rules stay server-only.',
);
console.log('Audit only. No Firebase project or production setting was changed.');
