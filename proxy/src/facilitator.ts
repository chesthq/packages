import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2, getUsdcAddress, convertToTokenAmount } from "@x402/svm";
import { ExactSvmScheme as FacilitatorScheme } from "@x402/svm/exact/facilitator";
import type { PaymentPayload, PaymentRequirements, Network } from "@x402/core/types";

export interface ChestFacilitator {
  feePayer: string;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ success: boolean; txSignature?: string; error?: string }>;
  buildPaymentRequirements(opts: {
    price: number;
    wallet: string;
    network: string;
    route: string;
    payToOverride?: string;
  }): PaymentRequirements;
}

function networkToCaip2(network: string): Network {
  if (network === "solana-devnet" || network.includes("devnet")) return SOLANA_DEVNET_CAIP2 as Network;
  if (network === "solana-mainnet" || network.includes("mainnet")) return SOLANA_MAINNET_CAIP2 as Network;
  if (network.startsWith("solana:")) return network as Network;
  return SOLANA_DEVNET_CAIP2 as Network;
}

export async function createFacilitator(
  feePayerSecretKey: Uint8Array,
  network: string
): Promise<ChestFacilitator> {
  const caip2Network = networkToCaip2(network);

  // Create the keypair signer from the fee-payer secret key
  const keypairSigner = await createKeyPairSignerFromBytes(feePayerSecretKey);
  const feePayerAddress = keypairSigner.address;

  // Use a configured RPC if available — the SDK default (api.devnet.solana.com)
  // is heavily rate-limited and intermittently fails simulateTransaction, which
  // surfaces to agents as `transaction_simulation_failed`.
  const rpcUrl = network.includes("mainnet")
    ? process.env.SOLANA_MAINNET_RPC_URL
    : process.env.SOLANA_DEVNET_RPC_URL;

  // Create the facilitator signer (wraps keypair with RPC + signing capabilities)
  const facilitatorSigner = toFacilitatorSvmSigner(
    keypairSigner,
    rpcUrl ? { defaultRpcUrl: rpcUrl } : undefined,
  );

  // Create the SVM facilitator scheme
  const scheme = new FacilitatorScheme(facilitatorSigner);

  return {
    feePayer: feePayerAddress,

    async verify(payload, requirements) {
      try {
        const result = await scheme.verify(payload, requirements);
        if (!result.isValid) {
          console.warn("[facilitator.verify] invalid", {
            reason: (result as any).invalidReason,
            errorMessage: (result as any).errorMessage,
            payer: (result as any).payer,
            payTo: requirements.payTo,
            amount: requirements.amount,
            asset: requirements.asset,
            network: requirements.network,
          });
        }
        return {
          isValid: result.isValid,
          invalidReason: result.isValid ? undefined : (result as any).invalidReason || (result as any).errorMessage,
          payer: (result as any).payer,
        };
      } catch (err) {
        const e = err as Error;
        console.error("[facilitator.verify] threw", {
          message: e.message,
          stack: e.stack,
          payTo: requirements.payTo,
          amount: requirements.amount,
        });
        return {
          isValid: false,
          invalidReason: `Verification error: ${e.message}`,
        };
      }
    },

    async settle(payload, requirements) {
      try {
        const result = await scheme.settle(payload, requirements);
        return {
          success: true,
          txSignature: result.transaction,
        };
      } catch (err) {
        return {
          success: false,
          error: `Settlement error: ${(err as Error).message}`,
        };
      }
    },

    buildPaymentRequirements({ price, wallet, network: net, route, payToOverride }) {
      const caip2 = networkToCaip2(net);
      const usdcAddress = getUsdcAddress(caip2);
      const amount = convertToTokenAmount(String(price), 6); // USDC has 6 decimals

      return {
        scheme: "exact",
        network: caip2,
        amount: String(amount),
        payTo: payToOverride || wallet,
        maxTimeoutSeconds: 60,
        asset: usdcAddress,
        extra: {
          name: "Chest Gate",
          feePayer: feePayerAddress,
          route,
        },
      } as PaymentRequirements;
    },
  };
}
