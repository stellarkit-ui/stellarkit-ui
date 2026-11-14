import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canRemoveTrustline,
  TrustlineManager,
  validateTrustlineInput,
  type StellarTrustline,
} from './TrustlineManager';

const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const SAMPLE_TRUSTLINES: StellarTrustline[] = [
  {
    assetCode: 'USDC',
    assetIssuer: VALID_ISSUER,
    balance: '420.5000000',
  },
  {
    assetCode: 'AQUA',
    assetIssuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
    balance: '0.0000000',
  },
];

test('validateTrustlineInput validates asset code length/characters, issuer StrKey, and duplicates', () => {
  assert.deepEqual(validateTrustlineInput('', VALID_ISSUER), {
    valid: false,
    error: 'Asset code is required',
  });

  assert.deepEqual(validateTrustlineInput('TOOLONGASSETCODE', VALID_ISSUER), {
    valid: false,
    error: 'Asset code must be 1 to 12 alphanumeric characters (A-Z, a-z, 0-9)',
  });

  assert.deepEqual(validateTrustlineInput('USDC', 'INVALID_ISSUER'), {
    valid: false,
    error: 'Invalid Stellar issuer address (must start with G and be 56 characters)',
  });

  assert.equal(
    validateTrustlineInput('USDC', VALID_ISSUER, SAMPLE_TRUSTLINES).valid,
    false
  );

  assert.deepEqual(validateTrustlineInput('EURC', VALID_ISSUER, SAMPLE_TRUSTLINES), {
    valid: true,
  });
});

test('canRemoveTrustline blocks removal when trustline balance is greater than zero', () => {
  const nonZeroCheck = canRemoveTrustline(SAMPLE_TRUSTLINES[0]);
  assert.equal(nonZeroCheck.valid, false);
  assert.match(nonZeroCheck.error ?? '', /while balance is non-zero/);

  const zeroCheck = canRemoveTrustline(SAMPLE_TRUSTLINES[1]);
  assert.deepEqual(zeroCheck, { valid: true });
});

test('TrustlineManager renders existing trustlines with balances, remove buttons, and add form', () => {
  const emptyHtml = renderToStaticMarkup(
    <TrustlineManager
      trustlines={[]}
      onAddTrustline={async () => {}}
      onRemoveTrustline={async () => {}}
    />
  );
  assert.match(emptyHtml, /No custom asset trustlines configured/);

  const populatedHtml = renderToStaticMarkup(
    <TrustlineManager
      trustlines={SAMPLE_TRUSTLINES}
      onAddTrustline={async () => {}}
      onRemoveTrustline={async () => {}}
    />
  );

  assert.match(populatedHtml, /Existing Trustlines \(2\)/);
  assert.match(populatedHtml, /USDC/);
  assert.match(populatedHtml, /420\.5000000/);
  assert.match(populatedHtml, /AQUA/);
  assert.match(populatedHtml, /Add New Trustline/);
});
