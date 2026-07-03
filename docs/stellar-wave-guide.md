# Stellar Wave Integration Guide

This guide explains how to use StellarKit UI patterns in a Stellar Wave app. It focuses on the flows most Wave projects need on day one: wallet connection, user transaction signing, and Soroban contract calls.

StellarKit UI should own reusable UI states such as connecting, connected, rejected, signing, submitted, and failed. Your application should still own the business rules, transaction construction, contract IDs, and backend validation.

## When To Use These Patterns

Use this guide when your Wave app needs to:

- connect a browser wallet such as Freighter;
- display the connected public key and current network;
- request signatures for user-approved Stellar transactions;
- invoke Soroban contracts from a client workflow;
- show clear UI feedback while wallet, RPC, and contract calls are pending.

## Recommended App Shape

A small Stellar Wave app usually needs these layers:

- Wallet adapter: connects to Freighter and exposes the public key.
- Network config: stores Testnet, Futurenet, or Mainnet RPC settings.
- Transaction service: builds XDR and requests wallet signatures.
- UI components: buttons, status banners, transaction previews, and error states.

Keep the wallet state near the top of the app so pages can reuse it:

```tsx
type WalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; publicKey: string; network: string }
  | { status: "error"; message: string };
```

## Wallet Connection Pattern

Install Freighter's browser API in the consuming app:

```bash
npm install @stellar/freighter-api
```

Create a small wallet helper that handles extension detection, permissions, and network discovery:

```ts
import {
  getAddress,
  getNetwork,
  isConnected,
  isAllowed,
  requestAccess,
} from "@stellar/freighter-api";

export async function connectWallet() {
  const connected = await isConnected();

  if (!connected.isConnected) {
    throw new Error("Freighter is not installed or is unavailable.");
  }

  const allowed = await isAllowed();

  if (!allowed.isAllowed) {
    const access = await requestAccess();

    if (!access.address) {
      throw new Error("Wallet access was rejected.");
    }
  }

  const address = await getAddress();
  const network = await getNetwork();

  if (!address.address) {
    throw new Error("No wallet address was returned.");
  }

  return {
    publicKey: address.address,
    network: network.network,
  };
}
```

In UI, make the wallet action explicit and reversible:

```tsx
type ConnectButtonProps = {
  status: "disconnected" | "connecting" | "connected";
  publicKey?: string;
  onConnect: () => void;
};

export function ConnectButton({
  status,
  publicKey,
  onConnect,
}: ConnectButtonProps) {
  if (status === "connected" && publicKey) {
    return <span>{shortenPublicKey(publicKey)}</span>;
  }

  return (
    <button type="button" disabled={status === "connecting"} onClick={onConnect}>
      {status === "connecting" ? "Connecting..." : "Connect wallet"}
    </button>
  );
}

function shortenPublicKey(publicKey: string) {
  return `${publicKey.slice(0, 6)}...${publicKey.slice(-6)}`;
}
```

## Transaction Signing Flow

Install the Stellar SDK in the consuming app:

```bash
npm install @stellar/stellar-sdk @stellar/freighter-api
```

Build the transaction with the SDK, show the user a human-readable preview, then ask the wallet to sign the XDR:

```ts
import {
  Asset,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const server = new Horizon.Server("https://horizon-testnet.stellar.org");

export async function buildPaymentXdr({
  sourcePublicKey,
  destinationPublicKey,
  amount,
}: {
  sourcePublicKey: string;
  destinationPublicKey: string;
  amount: string;
}) {
  const account = await server.loadAccount(sourcePublicKey);

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(60)
    .build();

  return transaction.toXDR();
}

export async function signPaymentXdr(xdr: string) {
  const signed = await signTransaction(xdr, {
    networkPassphrase: Networks.TESTNET,
  });

  return signed.signedTxXdr;
}
```

Submit the signed XDR only after the user confirms the wallet prompt:

```ts
import { Horizon, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const server = new Horizon.Server("https://horizon-testnet.stellar.org");

export async function submitSignedPayment(signedXdr: string) {
  const transaction = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  return server.submitTransaction(transaction);
}
```

Recommended UI states for signing:

- Preview: show destination, asset, amount, and network before opening the wallet.
- Signing: disable repeated clicks while the wallet prompt is open.
- Submitted: link to a Stellar explorer once the transaction hash is returned.
- Failed: show a retry action for network errors and a neutral message for user rejection.

## Soroban Contract Interaction Pattern

For Soroban calls, prefer building the transaction from a small service function. Keep contract IDs and RPC URLs in configuration instead of hardcoding them inside UI components.

```ts
import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const rpcServer = new rpc.Server("https://soroban-testnet.stellar.org");

export async function buildDonateContractXdr({
  sourcePublicKey,
  contractId,
  campaignId,
  amount,
}: {
  sourcePublicKey: string;
  contractId: string;
  campaignId: string;
  amount: bigint;
}) {
  const source = await rpcServer.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        "donate",
        Address.fromString(sourcePublicKey).toScVal(),
        nativeToScVal(campaignId, { type: "symbol" }),
        nativeToScVal(amount, { type: "i128" }),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await rpcServer.prepareTransaction(transaction);
  return prepared.toXDR();
}

export async function signSorobanXdr(xdr: string) {
  const signed = await signTransaction(xdr, {
    networkPassphrase: Networks.TESTNET,
  });

  return signed.signedTxXdr;
}
```

After signing, send the transaction through Soroban RPC:

```ts
import { Networks, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

const rpcServer = new rpc.Server("https://soroban-testnet.stellar.org");

export async function submitSorobanXdr(signedXdr: string) {
  const transaction = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  const result = await rpcServer.sendTransaction(transaction);

  return {
    hash: result.hash,
    status: result.status,
  };
}
```

## UI Checklist For Wave Apps

Before opening a wallet prompt:

- display the active network;
- display the connected account;
- summarize the operation in plain language;
- show the contract name or address when invoking Soroban;
- block submission if the wallet network does not match the app network.

After submission:

- show the transaction hash;
- keep the pending state until Horizon or Soroban RPC confirms the result;
- provide a link to an explorer that matches the selected network;
- never treat a wallet signature as final settlement until submission succeeds.

## Common Failure Cases

Handle these cases explicitly in StellarKit UI components:

- Freighter is not installed.
- The user rejects wallet access.
- The wallet is connected to the wrong network.
- The transaction simulation fails before signing.
- The wallet signs successfully, but RPC submission fails.
- The transaction remains pending longer than expected.

Good failure UI tells the user what happened and what they can do next without exposing raw XDR or stack traces by default.

## Minimal Integration Checklist

For a production-ready Wave integration:

- [ ] Wallet connect button exposes loading, connected, and error states.
- [ ] Connected public key is visible and shortened.
- [ ] Network mismatch blocks signing.
- [ ] Transaction previews are shown before wallet prompts.
- [ ] Signed XDR is submitted through the correct Horizon or Soroban RPC endpoint.
- [ ] Contract calls are prepared with Soroban RPC before signing.
- [ ] Submitted transactions expose a hash and explorer link.
- [ ] User rejection is treated as a normal cancel action, not a crash.

