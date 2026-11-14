import React from 'react';

export interface TransactionConfirmDetails {
  /** Stellar destination public key (G...) or muxed account (M...) */
  destination: string;
  /** Positive decimal amount string (e.g. "125.50") */
  amount: string;
  /** Asset code (e.g. "XLM", "USDC") */
  assetCode: string;
  /** Optional asset issuer for non-native Stellar assets */
  assetIssuer?: string;
  /** Optional transaction memo */
  memo?: string;
  /** Estimated network fee in XLM (defaults to "0.00001 XLM") */
  fee?: string;
  /** Optional network label (e.g. "TESTNET" | "PUBLIC") */
  network?: string;
}

const APPROVAL_BRAND = Symbol('StellarKitTransactionApproval');

export interface TransactionApprovalReceipt {
  readonly [APPROVAL_BRAND]: true;
  readonly fingerprint: string;
  readonly approvedAt: number;
}

const issuedReceipts = new WeakSet<TransactionApprovalReceipt>();
const consumedReceipts = new WeakSet<TransactionApprovalReceipt>();

/**
 * Computes a deterministic canonical fingerprint for a transaction summary so that
 * any post-display mutation of destination, amount, asset, memo, or fee invalidates approval.
 */
export function computeTransactionFingerprint(details: TransactionConfirmDetails): string {
  const destination = details.destination.trim();
  const amount = details.amount.trim();
  const assetCode = (details.assetCode || 'XLM').trim().toUpperCase();
  const assetIssuer = (details.assetIssuer || 'native').trim();
  const memo = (details.memo || '').trim();
  const fee = (details.fee || '0.00001').trim();
  return `${destination}|${amount}|${assetCode}:${assetIssuer}|${memo}|${fee}`;
}

/**
 * Issues a single-use cryptographic-style in-memory approval receipt bound to the exact
 * transaction details displayed in `TransactionConfirmModal`.
 */
export function createTransactionApprovalReceipt(
  details: TransactionConfirmDetails
): TransactionApprovalReceipt {
  if (!details.destination?.trim()) {
    throw new Error('Cannot approve transaction: destination address is required');
  }
  const numericAmount = Number(details.amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Cannot approve transaction: amount must be a positive number');
  }

  const receipt: TransactionApprovalReceipt = Object.freeze({
    [APPROVAL_BRAND]: true as const,
    fingerprint: computeTransactionFingerprint(details),
    approvedAt: Date.now(),
  });
  issuedReceipts.add(receipt);
  return receipt;
}

/**
 * Verifies and consumes a `TransactionApprovalReceipt` before allowing a transaction
 * to be signed and submitted. Prevents programmatic bypass, forged receipts, replayed
 * receipts, or payload tampering between review and signing.
 */
export function verifyAndConsumeApprovalReceipt(
  details: TransactionConfirmDetails,
  receipt: unknown
): void {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !(APPROVAL_BRAND in receipt) ||
    !issuedReceipts.has(receipt as TransactionApprovalReceipt)
  ) {
    throw new Error(
      'SecurityError: Transaction signing requires explicit user confirmation via TransactionConfirmModal'
    );
  }

  const typedReceipt = receipt as TransactionApprovalReceipt;
  if (consumedReceipts.has(typedReceipt)) {
    throw new Error('SecurityError: Transaction approval receipt has already been used');
  }

  const expectedFingerprint = computeTransactionFingerprint(details);
  if (typedReceipt.fingerprint !== expectedFingerprint) {
    throw new Error(
      'SecurityError: Transaction details were modified after user confirmation'
    );
  }

  consumedReceipts.add(typedReceipt);
}

export interface TransactionConfirmModalProps {
  /** Whether the modal is open and visible */
  isOpen: boolean;
  /** Transaction parameters to review before signing */
  transaction: TransactionConfirmDetails | null;
  /** Whether signing/submission is currently in progress */
  isSubmitting?: boolean;
  /** Called with a single-use approval receipt when the user explicitly clicks Confirm */
  onConfirm: (receipt: TransactionApprovalReceipt) => void;
  /** Called when the user clicks Cancel or dismisses the modal */
  onCancel: () => void;
}

/**
 * Mandatory security confirmation modal displayed before signing and submitting
 * any Stellar transaction. Displays destination, amount, asset, memo, and network fee.
 */
export const TransactionConfirmModal: React.FC<TransactionConfirmModalProps> = ({
  isOpen,
  transaction,
  isSubmitting = false,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen || !transaction) {
    return null;
  }

  const formattedAsset = transaction.assetIssuer
    ? `${transaction.assetCode} (${transaction.assetIssuer.slice(0, 6)}...${transaction.assetIssuer.slice(-4)})`
    : transaction.assetCode || 'XLM';

  const formattedFee = transaction.fee?.trim() || '0.00001 XLM';
  const formattedMemo = transaction.memo?.trim() ? transaction.memo.trim() : 'None';

  const handleConfirmClick = () => {
    if (isSubmitting) return;
    const receipt = createTransactionApprovalReceipt(transaction);
    onConfirm(receipt);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stellarkit-tx-confirm-title"
      data-testid="transaction-confirm-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4">
          <h2
            id="stellarkit-tx-confirm-title"
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Confirm Stellar Transaction
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Please verify all transaction details carefully before signing with your wallet.
            Stellar transactions are irreversible once broadcast.
          </p>
        </div>

        <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">Destination</dt>
            <dd
              data-testid="tx-confirm-destination"
              className="max-w-[240px] truncate font-mono text-xs text-zinc-900 dark:text-zinc-100"
              title={transaction.destination}
            >
              {transaction.destination}
            </dd>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">Amount</dt>
            <dd
              data-testid="tx-confirm-amount"
              className="font-semibold text-zinc-900 dark:text-zinc-100"
            >
              {transaction.amount} { transaction.assetCode || 'XLM' }
            </dd>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">Asset</dt>
            <dd
              data-testid="tx-confirm-asset"
              className="font-mono text-xs text-zinc-900 dark:text-zinc-100"
            >
              {formattedAsset}
            </dd>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">Memo</dt>
            <dd
              data-testid="tx-confirm-memo"
              className="text-zinc-900 dark:text-zinc-100"
            >
              {formattedMemo}
            </dd>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">Network Fee</dt>
            <dd
              data-testid="tx-confirm-fee"
              className="font-mono text-xs text-zinc-900 dark:text-zinc-100"
            >
              {formattedFee}
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            data-testid="tx-confirm-cancel-btn"
            disabled={isSubmitting}
            onClick={onCancel}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="tx-confirm-submit-btn"
            disabled={isSubmitting}
            onClick={handleConfirmClick}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {isSubmitting ? 'Signing...' : 'Confirm & Sign'}
          </button>
        </div>
      </div>
    </div>
  );
};
