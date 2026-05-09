import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";

const CHEST_DIR = join(homedir(), ".chest");
const WALLET_PATH = join(CHEST_DIR, "wallet.json");

// Solana BIP-44 derivation path
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface FeePayerInfo {
  address: string;
  keypair: Uint8Array;
  mnemonic: string;
  path: string;
  created: boolean;
}

interface WalletFile {
  mnemonic: string;
  derivationPath: string;
  solanaAddress: string;
  solanaKeypair: number[];
}

export async function ensureKeypair(): Promise<FeePayerInfo> {
  // Check for existing wallet
  if (existsSync(WALLET_PATH)) {
    const raw = await readFile(WALLET_PATH, "utf-8");
    const wallet: WalletFile = JSON.parse(raw);
    const secretKey = new Uint8Array(wallet.solanaKeypair);
    const kp = Keypair.fromSecretKey(secretKey);

    return {
      address: kp.publicKey.toBase58(),
      keypair: secretKey,
      mnemonic: wallet.mnemonic,
      path: WALLET_PATH,
      created: false,
    };
  }

  // Generate new seed phrase
  const mnemonic = bip39.generateMnemonic();
  const seed = await bip39.mnemonicToSeed(mnemonic);

  // Derive Solana keypair from seed
  const derived = derivePath(SOLANA_DERIVATION_PATH, seed.toString("hex"));
  const kp = Keypair.fromSeed(derived.key);

  // Save wallet file
  await mkdir(CHEST_DIR, { recursive: true });

  const walletFile: WalletFile = {
    mnemonic,
    derivationPath: SOLANA_DERIVATION_PATH,
    solanaAddress: kp.publicKey.toBase58(),
    solanaKeypair: Array.from(kp.secretKey),
  };

  await writeFile(WALLET_PATH, JSON.stringify(walletFile, null, 2));

  return {
    address: kp.publicKey.toBase58(),
    keypair: kp.secretKey,
    mnemonic,
    path: WALLET_PATH,
    created: true,
  };
}
