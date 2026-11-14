import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createTransactionApprovalReceipt,
  TransactionConfirmModal,
  type TransactionApprovalReceipt,
  type TransactionConfirmDetails,
} from './TransactionConfirmModal';
import { executeConfirmedPayment } from '../PaymentForm/PaymentForm';

const SAMPLE_TX: TransactionConfirmDetails = {
  destination: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
  amount: '250.75',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  memo: 'Order #8841',
  fee: '0.00001 XLM',
};

test('TransactionConfirmModal renders destination, amount, asset, memo, fee, and action buttons when open', () => {
  const closedHtml = renderToStaticMarkup(
    <TransactionConfirmModal
      isOpen={false}
      transaction={SAMPLE_TX}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
  assert.equal(closedHtml, '');

  const openHtml = renderToStaticMarkup(
    <TransactionConfirmModal
      isOpen={true}
      transaction={SAMPLE_TX}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );

  assert.match(openHtml, /Confirm Stellar Transaction/);
  assert.match(openHtml, /GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/);
  assert.match(openHtml, /250\.75 USDC/);
  assert.match(openHtml, /Order #8841/);
  assert.match(openHtml, /0\.00001 XLM/);
  assert.match(openHtml, /Cancel/);
  assert.match(openHtml, /Confirm &amp; Sign/);
});

test('executeConfirmedPayment submits transaction only with a valid single-use approval receipt', async () => {
  const submitted: TransactionConfirmDetails[] = [];
  const receipt = createTransactionApprovalReceipt(SAMPLE_TX);

  const result = await executeConfirmedPayment(SAMPLE_TX, receipt, async (details) => {
    submitted.push(details);
    return { hash: 'tx_hash_abc123' };
  });

  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], SAMPLE_TX);
  assert.deepEqual(result, { hash: 'tx_hash_abc123' });

  // Replaying the same receipt a second time must be rejected
  await assert.rejects(
    executeConfirmedPayment(SAMPLE_TX, receipt, async () => ({ hash: 'replay' })),
    /SecurityError: Transaction approval receipt has already been used/
  );
  assert.equal(submitted.length, 1);
});

test('executeConfirmedPayment blocks programmatic bypass and post-confirmation payload tampering', async () => {
  let signerCalled = false;
  const mockSigner = async () => {
    signerCalled = true;
    return { hash: 'bypass_hash' };
  };

  // 1. Attempt to bypass with a forged receipt object
  const forgedReceipt = {
    fingerprint: 'forged',
    approvedAt: Date.now(),
  } as unknown as TransactionApprovalReceipt;

  await assert.rejects(
    executeConfirmedPayment(SAMPLE_TX, forgedReceipt, mockSigner),
    /SecurityError: Transaction signing requires explicit user confirmation/
  );
  assert.equal(signerCalled, false);

  // 2. Attempt to tamper with the destination or amount after user approval
  const validReceipt = createTransactionApprovalReceipt(SAMPLE_TX);
  const tamperedTx: TransactionConfirmDetails = {
    ...SAMPLE_TX,
    amount: '99999.00',
  };

  await assert.rejects(
    executeConfirmedPayment(tamperedTx, validReceipt, mockSigner),
    /SecurityError: Transaction details were modified after user confirmation/
  );
  assert.equal(signerCalled, false);
});
