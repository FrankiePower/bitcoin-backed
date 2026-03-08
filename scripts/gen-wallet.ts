/**
 * gen-wallet.ts
 * Generates two P2WPKH testnet4 addresses:
 *   1. Vault address  — update config.json vaultAddress with this
 *   2. Destination    — send vault BTC here to trigger liquidation
 *
 * Usage:
 *   bun run scripts/gen-wallet.ts
 */

import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

function generateWallet() {
  const keyPair = ECPair.makeRandom({ network })
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network,
  })
  return {
    address: address!,
    wif: keyPair.toWIF(),
  }
}

const vault = generateWallet()
const destination = generateWallet()

console.log('=== Generated Wallets ===\n')
console.log('VAULT ADDRESS (receives BTC deposits, monitored by workflow)')
console.log(`  Address : ${vault.address}`)
console.log(`  WIF Key : ${vault.wif}`)
console.log('')
console.log('DESTINATION ADDRESS (send vault BTC here to trigger liquidation)')
console.log(`  Address : ${destination.address}`)
console.log(`  WIF Key : ${destination.wif}`)
console.log('')

// Auto-update config.json vaultAddress
const configPath = resolve(__dirname, '../btcusd-workflow/config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const oldVault = config.vaultAddress
config.vaultAddress = vault.address
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

console.log('=== config.json updated ===')
console.log(`  vaultAddress: ${oldVault} → ${vault.address}`)
console.log('')
console.log('Next steps:')
console.log(`  1. Fund vault with testnet4 BTC: https://mempool.space/testnet4/address/${vault.address}`)
console.log(`     Faucet: https://testnet4.anyone.eu.org or https://faucet.testnet4.dev`)
console.log(`  2. Save the WIF keys somewhere safe — you need them to spend`)
console.log(`  3. Wait for 6 confirmations, then the workflow will attest + auto-mint`)
console.log(`  4. To trigger liquidation, run:`)
console.log(`     bun run scripts/send-btc.ts "${vault.wif}" "${destination.address}"`)
