import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, setProvider } = pkg;
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import idl from "./chest_splitter_idl.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("9a6zrqau5xVEdxNqBUfL2G18WuryQbWeJScPAUHZvmmX");

// Chest treasury wallet, receives protocol fee (1.5%).
// Override with CHEST_PROTOCOL_WALLET env var for production.
// Default is the Chest devnet treasury (our Solana CLI keypair).
export const CHEST_PROTOCOL_WALLET = new PublicKey(
  process.env.CHEST_PROTOCOL_WALLET ||
    "HndLQmUiUzi6mn1BHUrMWuNKzagvPfPQSkXFm6tC7wev"
);

export const RPC_URLS: Record<string, string> = {
  "solana-devnet": "https://api.devnet.solana.com",
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://localhost:8899",
};

export interface SplitInitResult {
  splitConfigPda: string;
  vaultPda: string;
  merchantTokenAccount: string;
  protocolTokenAccount: string;
  txSignature: string;
}

export function computeSlugHash(slug: string): Buffer {
  return createHash("sha256").update(slug).digest().slice(0, 8);
}

/**
 * Derive the split_config and vault PDAs for a given authority + slug + mint.
 */
export async function deriveSplitPdas(
  authority: PublicKey,
  slug: string,
  usdcMint: PublicKey
): Promise<{ splitConfigPda: PublicKey; vaultPda: PublicKey }> {
  const slugHash = computeSlugHash(slug);

  const [splitConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("split"), authority.toBuffer(), slugHash],
    PROGRAM_ID
  );

  // Vault is now ATA(split_config_pda, mint), allowOwnerOffCurve = true for PDA owner
  const vaultPda = await getAssociatedTokenAddress(usdcMint, splitConfigPda, true);

  return { splitConfigPda, vaultPda };
}

/**
 * Ensure an ATA exists for a wallet; create it if missing.
 * Returns the ATA address.
 */
async function ensureAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner);

  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    // ATA doesn't exist, create it
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint
    );
    const { sendAndConfirmTransaction, Transaction } = await import(
      "@solana/web3.js"
    );
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);
    return ata;
  }
}

/**
 * Initialize a split config on-chain for the given merchant + slug.
 * Creates the SplitConfig PDA, vault PDA, and merchant/protocol ATAs if needed.
 */
export async function initializeSplit(opts: {
  feePayerKeypair: Uint8Array;
  merchantWallet: string;
  usdcMintAddress: string;
  slug: string;
  referrerBps: number;
  network: string;
}): Promise<SplitInitResult> {
  const rpcUrl = RPC_URLS[opts.network] ?? opts.network;
  const connection = new Connection(rpcUrl, "confirmed");

  const authority = Keypair.fromSecretKey(opts.feePayerKeypair);
  const wallet = new Wallet(authority);

  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  setProvider(provider);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  const merchantWallet = new PublicKey(opts.merchantWallet);
  const usdcMint = new PublicKey(opts.usdcMintAddress);

  const slugHash = computeSlugHash(opts.slug);
  const slugHashArray = Array.from(slugHash);

  const { splitConfigPda, vaultPda } = await deriveSplitPdas(
    authority.publicKey,
    opts.slug,
    usdcMint
  );

  // Ensure merchant and protocol ATAs exist before initializing
  const [merchantAta, protocolAta] = await Promise.all([
    ensureAta(connection, authority, usdcMint, merchantWallet),
    ensureAta(connection, authority, usdcMint, CHEST_PROTOCOL_WALLET),
  ]);

  const txSignature = await program.methods
    .initializeSplit(slugHashArray, opts.referrerBps)
    .accounts({
      authority: authority.publicKey,
      merchantWallet,
      protocolWallet: CHEST_PROTOCOL_WALLET,
      usdcMint,
      splitConfig: splitConfigPda,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return {
    splitConfigPda: splitConfigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    merchantTokenAccount: merchantAta.toBase58(),
    protocolTokenAccount: protocolAta.toBase58(),
    txSignature,
  };
}
