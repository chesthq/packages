import { createHash } from "crypto";
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, setProvider, Wallet } = pkg;
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import idl from "./chest_splitter_idl.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("9a6zrqau5xVEdxNqBUfL2G18WuryQbWeJScPAUHZvmmX");

const RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "solana:devnet": "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  "solana:mainnet": "https://api.mainnet-beta.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://localhost:8899",
};

export interface SplitDistributeResult {
  success: boolean;
  txSignature?: string;
  merchantAmount: number;
  referrerAmount: number;
  protocolAmount: number;
  error?: string;
}

/**
 * Compute the slug hash (first 8 bytes of SHA-256) used for PDA derivation.
 */
export function computeSlugHash(slug: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(slug).digest().slice(0, 8));
}

/**
 * Compute split amounts in token atomic units.
 * Uses subtraction method for merchant to avoid dust.
 */
export function computeSplitAmounts(
  totalAmount: number,
  referrerBps: number,
  protocolBps: number,
  hasReferrer: boolean
): { merchant: number; referrer: number; protocol: number } {
  const protocolShare = Math.floor((totalAmount * protocolBps) / 10000);
  const referrerShare = hasReferrer
    ? Math.floor((totalAmount * referrerBps) / 10000)
    : 0;
  const merchantShare = totalAmount - protocolShare - referrerShare;

  return {
    merchant: merchantShare,
    referrer: referrerShare,
    protocol: protocolShare,
  };
}

/**
 * Call the distribute instruction on the chest_splitter program.
 * Fire-and-forget, returns a promise that resolves when the tx confirms.
 *
 * referrerTokenAccount: a wallet address (pubkey string). Its ATA for the mint
 * is derived on the fly. When has_referrer=false, protocol_token is used as the
 * dummy account (amount transferred will be 0, so it doesn't matter).
 */
export async function callDistribute(opts: {
  feePayerKeypair: Uint8Array;
  splitConfigPda: string;
  merchantTokenAccount: string;
  protocolTokenAccount: string;
  referrerTokenAccount: string | null;
  usdcMint: string;
  amount: number;
  referrerBps: number;
  protocolBps: number;
  hasReferrer: boolean;
  network: string;
}): Promise<SplitDistributeResult> {
  const amounts = computeSplitAmounts(
    opts.amount,
    opts.referrerBps,
    opts.protocolBps,
    opts.hasReferrer
  );

  try {
    const rpcUrl = RPC_URLS[opts.network] ?? opts.network;
    const connection = new Connection(rpcUrl, "confirmed");

    const cranker = Keypair.fromSecretKey(opts.feePayerKeypair);
    const wallet = new Wallet(cranker);

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    setProvider(provider);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = new Program(idl as any, provider);

    const splitConfigPda = new PublicKey(opts.splitConfigPda);
    const usdcMint = new PublicKey(opts.usdcMint);
    const merchantToken = new PublicKey(opts.merchantTokenAccount);
    const protocolToken = new PublicKey(opts.protocolTokenAccount);

    // Vault is now ATA(split_config_pda, mint), derived client-side
    const vaultPda = await getAssociatedTokenAddress(usdcMint, splitConfigPda, true);

    // Resolve referrer token account: derive ATA from wallet address.
    // Create the ATA if it doesn't exist (cranker pays ~0.002 SOL rent).
    // When no referrer, use protocol_token as dummy (amount = 0, safe).
    let referrerToken: PublicKey;
    let effectiveHasReferrer = opts.hasReferrer;
    if (opts.hasReferrer && opts.referrerTokenAccount) {
      const referrerWallet = new PublicKey(opts.referrerTokenAccount);
      const referrerAta = await getAssociatedTokenAddress(usdcMint, referrerWallet);
      try {
        await getAccount(connection, referrerAta);
        referrerToken = referrerAta;
      } catch {
        // ATA doesn't exist, create it so the referrer can receive funds
        const createAtaIx = createAssociatedTokenAccountInstruction(
          cranker.publicKey,
          referrerAta,
          referrerWallet,
          usdcMint
        );
        const createAtaTx = new Transaction().add(createAtaIx);
        await sendAndConfirmTransaction(connection, createAtaTx, [cranker]);
        referrerToken = referrerAta;
      }
    } else {
      referrerToken = protocolToken;
      effectiveHasReferrer = false;
    }

    const txSignature = await program.methods
      .distribute(new BN(opts.amount), effectiveHasReferrer)
      .accounts({
        cranker: cranker.publicKey,
        splitConfig: splitConfigPda,
        usdcMint,
        vault: vaultPda,
        merchantToken,
        protocolToken,
        referrerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    return {
      success: true,
      txSignature,
      merchantAmount: amounts.merchant,
      referrerAmount: amounts.referrer,
      protocolAmount: amounts.protocol,
    };
  } catch (err) {
    return {
      success: false,
      merchantAmount: amounts.merchant,
      referrerAmount: amounts.referrer,
      protocolAmount: amounts.protocol,
      error: `Distribute failed: ${(err as Error).message}`,
    };
  }
}
