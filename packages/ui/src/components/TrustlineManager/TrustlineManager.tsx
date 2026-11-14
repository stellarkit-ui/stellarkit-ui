import React, { useState } from 'react';

export interface StellarTrustline {
  /** Asset code (1-12 alphanumeric characters, e.g. "USDC", "AQUA") */
  assetCode: string;
  /** Asset issuer Stellar public key (56-char Ed25519 G... address) */
  assetIssuer: string;
  /** Current asset balance string (e.g. "120.5000000" or "0.0000000") */
  balance: string;
  /** Optional trustline limit (defaults to max Stellar limit) */
  limit?: string;
  /** Whether the trustline is authorized by the issuer */
  isAuthorized?: boolean;
}

export interface TrustlineValidationResult {
  valid: boolean;
  error?: string;
}

const STELLAR_ASSET_CODE_REGEX = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ISSUER_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Validates Stellar asset code (1-12 alphanumeric characters, excluding native XLM)
 * and issuer public key (56-character StrKey Ed25519 G... address), as well as
 * duplicate trustline checks.
 */
export function validateTrustlineInput(
  assetCode: string,
  assetIssuer: string,
  existingTrustlines: StellarTrustline[] = [],
  limit?: string
): TrustlineValidationResult {
  const code = assetCode.trim();
  const issuer = assetIssuer.trim();

  if (!code) {
    return { valid: false, error: 'Asset code is required' };
  }
  if (!STELLAR_ASSET_CODE_REGEX.test(code)) {
    return {
      valid: false,
      error: 'Asset code must be 1 to 12 alphanumeric characters (A-Z, a-z, 0-9)',
    };
  }
  if (code.toUpperCase() === 'XLM' && !issuer) {
    return { valid: false, error: 'Native XLM does not require a trustline' };
  }
  if (!issuer) {
    return { valid: false, error: 'Issuer address is required' };
  }
  if (!STELLAR_ISSUER_REGEX.test(issuer)) {
    return {
      valid: false,
      error: 'Invalid Stellar issuer address (must start with G and be 56 characters)',
    };
  }

  const duplicate = existingTrustlines.some(
    (t) => t.assetCode === code && t.assetIssuer.toUpperCase() === issuer.toUpperCase()
  );
  if (duplicate) {
    return {
      valid: false,
      error: `Trustline for ${code} (${issuer.slice(0, 6)}...${issuer.slice(-4)}) already exists`,
    };
  }

  if (limit !== undefined && limit.trim() !== '') {
    const numericLimit = Number(limit);
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      return { valid: false, error: 'Trustline limit must be a positive number' };
    }
  }

  return { valid: true };
}

/**
 * Checks whether a trustline can be removed on the Stellar network.
 * Stellar protocol requires a trustline balance to be exactly 0 before removal (`changeTrust` with limit 0).
 */
export function canRemoveTrustline(trustline: StellarTrustline): TrustlineValidationResult {
  const numericBalance = Number(trustline.balance);
  if (Number.isFinite(numericBalance) && numericBalance > 0) {
    return {
      valid: false,
      error: `Cannot remove ${trustline.assetCode} trustline while balance is non-zero (${trustline.balance})`,
    };
  }
  return { valid: true };
}

export interface TrustlineManagerProps {
  /** List of active trustlines for the connected Stellar account */
  trustlines: StellarTrustline[];
  /** Called when the user submits a valid new trustline (`changeTrust` operation) */
  onAddTrustline: (params: {
    assetCode: string;
    assetIssuer: string;
    limit?: string;
  }) => Promise<void>;
  /** Called when the user confirms removing an existing trustline (`changeTrust` with limit "0") */
  onRemoveTrustline: (params: { assetCode: string; assetIssuer: string }) => Promise<void>;
  /** Optional loading state while fetching account trustlines */
  isLoading?: boolean;
}

/**
 * Component allowing users to view, add, and remove Stellar asset trustlines
 * with asset code + issuer StrKey validation, zero-balance removal checks,
 * confirmation prompts, and status feedback.
 */
export const TrustlineManager: React.FC<TrustlineManagerProps> = ({
  trustlines,
  onAddTrustline,
  onRemoveTrustline,
  isLoading = false,
}) => {
  const [assetCode, setAssetCode] = useState('');
  const [assetIssuer, setAssetIssuer] = useState('');
  const [limit, setLimit] = useState('');
  const [confirmingRemovalKey, setConfirmingRemovalKey] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const validation = validateTrustlineInput(assetCode, assetIssuer, trustlines, limit);
    if (!validation.valid) {
      setFeedback({
        type: 'error',
        message: validation.error || 'Invalid trustline parameters',
      });
      return;
    }

    const cleanCode = assetCode.trim();
    const cleanIssuer = assetIssuer.trim();
    const cleanLimit = limit.trim() || undefined;

    setIsSubmitting(true);
    try {
      await onAddTrustline({
        assetCode: cleanCode,
        assetIssuer: cleanIssuer,
        limit: cleanLimit,
      });
      setAssetCode('');
      setAssetIssuer('');
      setLimit('');
      setFeedback({
        type: 'success',
        message: `Successfully added trustline for ${cleanCode}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : `Failed to add trustline for ${cleanCode}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveConfirm = async (trustline: StellarTrustline) => {
    setFeedback(null);
    const check = canRemoveTrustline(trustline);
    if (!check.valid) {
      setConfirmingRemovalKey(null);
      setFeedback({
        type: 'error',
        message: check.error || 'Cannot remove trustline',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await onRemoveTrustline({
        assetCode: trustline.assetCode,
        assetIssuer: trustline.assetIssuer,
      });
      setConfirmingRemovalKey(null);
      setFeedback({
        type: 'success',
        message: `Removed trustline for ${trustline.assetCode}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : `Failed to remove trustline for ${trustline.assetCode}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="trustline-manager"
      className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Stellar Trustlines
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Manage custom Stellar assets your account is authorized to hold and receive.
        </p>
      </div>

      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          data-testid={`trustline-feedback-${feedback.type}`}
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            feedback.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-300'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/50 dark:text-emerald-300'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="mb-6">
        <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Existing Trustlines ({trustlines.length})
        </h3>

        {isLoading ? (
          <div className="rounded-lg border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
            Loading trustlines...
          </div>
        ) : trustlines.length === 0 ? (
          <div
            data-testid="trustline-empty-state"
            className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800"
          >
            No custom asset trustlines configured for this account.
          </div>
        ) : (
          <ul
            data-testid="trustline-list"
            className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
          >
            {trustlines.map((item) => {
              const key = `${item.assetCode}:${item.assetIssuer}`;
              const isConfirming = confirmingRemovalKey === key;
              const shortIssuer = `${item.assetIssuer.slice(0, 6)}...${item.assetIssuer.slice(-4)}`;

              return (
                <li
                  key={key}
                  data-testid={`trustline-item-${item.assetCode}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div>
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {item.assetCode}
                      <span
                        className="ml-2 font-mono text-xs font-normal text-zinc-500 dark:text-zinc-400"
                        title={item.assetIssuer}
                      >
                        {shortIssuer}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                      Balance: <span className="font-mono font-medium">{item.balance}</span>{' '}
                      {item.assetCode}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isConfirming ? (
                      <>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleRemoveConfirm(item)}
                          data-testid={`trustline-confirm-remove-${item.assetCode}`}
                          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Confirm Remove
                        </button>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => setConfirmingRemovalKey(null)}
                          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setConfirmingRemovalKey(key)}
                        data-testid={`trustline-remove-btn-${item.assetCode}`}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        onSubmit={handleAddSubmit}
        data-testid="trustline-add-form"
        className="space-y-4 border-t border-zinc-200 pt-5 dark:border-zinc-800"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Add New Trustline
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Asset Code
            </label>
            <input
              type="text"
              maxLength={12}
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value)}
              placeholder="USDC"
              required
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Issuer Address
            </label>
            <input
              type="text"
              value={assetIssuer}
              onChange={(e) => setAssetIssuer(e.target.value)}
              placeholder="G..."
              required
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </div>
        </div>

        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="trustline-add-submit-btn"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isSubmitting ? 'Updating...' : 'Add Trustline'}
          </button>
        </div>
      </form>
    </div>
  );
};
