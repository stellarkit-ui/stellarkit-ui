import React, { useState } from 'react';
import {
  TransactionConfirmModal,
  verifyAndConsumeApprovalReceipt,
  type TransactionApprovalReceipt,
  type TransactionConfirmDetails,
} from '../TransactionConfirmModal/TransactionConfirmModal';

export interface PaymentFormProps {
  /** Available assets for selection (defaults to XLM) */
  assets?: { code: string; issuer?: string }[];
  /** Default network fee displayed to the user (defaults to "0.00001 XLM") */
  defaultFee?: string;
  /**
   * Callback invoked to sign and broadcast the payment ONLY after the user
   * explicitly confirms the transaction inside `TransactionConfirmModal`.
   */
  onSignAndSubmit: (details: TransactionConfirmDetails) => Promise<{ hash?: string } | void>;
  /** Optional callback invoked when the user cancels the confirmation modal */
  onCancelConfirmation?: () => void;
}

/**
 * Enforces mandatory user confirmation before invoking the wallet signer/submitter.
 * Throws a `SecurityError` if called without a valid, unconsumed `TransactionApprovalReceipt`
 * matching `details`.
 */
export async function executeConfirmedPayment(
  details: TransactionConfirmDetails,
  receipt: TransactionApprovalReceipt,
  onSignAndSubmit: (details: TransactionConfirmDetails) => Promise<{ hash?: string } | void>
): Promise<{ hash?: string } | void> {
  verifyAndConsumeApprovalReceipt(details, receipt);
  return onSignAndSubmit(details);
}

/**
 * Stellar payment form with mandatory pre-signing `TransactionConfirmModal` verification.
 */
export const PaymentForm: React.FC<PaymentFormProps> = ({
  assets = [{ code: 'XLM' }],
  defaultFee = '0.00001 XLM',
  onSignAndSubmit,
  onCancelConfirmation,
}) => {
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedAssetKey, setSelectedAssetKey] = useState(
    assets[0] ? `${assets[0].code}:${assets[0].issuer || 'native'}` : 'XLM:native'
  );
  const [memo, setMemo] = useState('');
  const [pendingTx, setPendingTx] = useState<TransactionConfirmDetails | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successHash, setSuccessHash] = useState<string | null>(null);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessHash(null);

    const trimmedDest = destination.trim();
    if (!/^G[A-Z2-7]{55}$/.test(trimmedDest)) {
      setError('Invalid Stellar destination address (must start with G and be 56 characters)');
      return;
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Amount must be a positive number');
      return;
    }

    const [assetCode, rawIssuer] = selectedAssetKey.split(':');
    const assetIssuer = rawIssuer && rawIssuer !== 'native' ? rawIssuer : undefined;

    // Open mandatory TransactionConfirmModal instead of submitting directly
    setPendingTx({
      destination: trimmedDest,
      amount: amount.trim(),
      assetCode: assetCode || 'XLM',
      assetIssuer,
      memo: memo.trim() || undefined,
      fee: defaultFee,
    });
  };

  const handleConfirmModal = async (receipt: TransactionApprovalReceipt) => {
    if (!pendingTx) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await executeConfirmedPayment(pendingTx, receipt, onSignAndSubmit);
      setPendingTx(null);
      setAmount('');
      setMemo('');
      if (result && typeof result === 'object' && result.hash) {
        setSuccessHash(result.hash);
      } else {
        setSuccessHash('submitted');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction signing failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelModal = () => {
    if (isSubmitting) return;
    setPendingTx(null);
    onCancelConfirmation?.();
  };

  return (
    <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <form onSubmit={handleFormSubmit} className="space-y-4" data-testid="stellar-payment-form">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Destination Address
          </label>
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="G..."
            required
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Amount
            </label>
            <input
              type="number"
              step="any"
              min="0.0000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Asset
            </label>
            <select
              value={selectedAssetKey}
              onChange={(e) => setSelectedAssetKey(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            >
              {assets.map((asset) => {
                const key = `${asset.code}:${asset.issuer || 'native'}`;
                return (
                  <option key={key} value={key}>
                    {asset.code}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Memo (Optional)
          </label>
          <input
            type="text"
            maxLength={28}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Invoice #1042"
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </div>

        {error && (
          <div
            role="alert"
            data-testid="payment-form-error"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {successHash && (
          <div
            role="status"
            data-testid="payment-form-success"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/50 dark:text-emerald-300"
          >
            Transaction confirmed and submitted ({successHash}).
          </div>
        )}

        <button
          type="submit"
          data-testid="payment-review-submit-btn"
          className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Review & Send Payment
        </button>
      </form>

      <TransactionConfirmModal
        isOpen={pendingTx !== null}
        transaction={pendingTx}
        isSubmitting={isSubmitting}
        onConfirm={handleConfirmModal}
        onCancel={handleCancelModal}
      />
    </div>
  );
};
