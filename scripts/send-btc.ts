/**
 * send-btc.ts
 * Sweeps all confirmed UTXOs from a P2WPKH testnet4 address to a recipient.
 * Used to simulate a vault withdrawal and trigger liquidation detection.
 *
 * Usage:
 *   bun run scripts/send-btc.ts <SENDER_WIF> <RECIPIENT_ADDRESS> [AMOUNT_SATS]
 *
 * If AMOUNT_SATS is omitted, sweeps entire balance (minus fee).
 */

import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet

const MEMPOOL = 'https://mempool.space/testnet4/api'

type UTXO = {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean; block_height?: number }
}

async function getUtxos(address: string): Promise<UTXO[]> {
  const res = await fetch(`${MEMPOOL}/address/${address}/utxo`)
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.statusText}`)
  const all: UTXO[] = await res.json()
  return all.filter((u) => u.status.confirmed)
}

async function getFeeRate(): Promise<number> {
  const res = await fetch(`${MEMPOOL}/v1/fees/recommended`)
  if (!res.ok) return 2
  const fees = await res.json()
  return fees.fastestFee ?? 2
}

async function broadcast(txHex: string): Promise<string> {
  const res = await fetch(`${MEMPOOL}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Broadcast failed: ${err}`)
  }
  return await res.text()
}

async function send(senderWif: string, recipientAddress: string, amountSats?: number) {
  const keyPair = ECPair.fromWIF(senderWif, network)
  const { address: senderAddress } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network,
  })

  console.log(`Sender    : ${senderAddress}`)
  console.log(`Recipient : ${recipientAddress}`)

  const utxos = await getUtxos(senderAddress!)
  if (!utxos.length) {
    throw new Error('No confirmed UTXOs found. Fund the address first and wait for confirmations.')
  }
  console.log(`UTXOs     : ${utxos.length} confirmed`)

  const feeRate = await getFeeRate()
  const totalInput = utxos.reduce((sum, u) => sum + u.value, 0)

  // Estimate tx size: 10.5 overhead + 68 per input + 31 output (P2WPKH)
  const estimatedSize = Math.ceil(10.5 + utxos.length * 68 + 31)
  const fee = Math.ceil(estimatedSize * feeRate)

  const sendAmount = amountSats !== undefined ? amountSats : totalInput - fee
  if (sendAmount <= 0 || totalInput - sendAmount < fee) {
    throw new Error(
      `Insufficient funds. Total: ${totalInput} sats, fee: ${fee} sats, requested: ${sendAmount} sats`
    )
  }
  if (sendAmount < 546) {
    throw new Error(`Send amount ${sendAmount} sats is below dust limit (546 sats)`)
  }

  console.log(`Total in  : ${totalInput} sats`)
  console.log(`Fee       : ${fee} sats @ ${feeRate} sat/vB`)
  console.log(`Sending   : ${sendAmount} sats`)

  const senderScript = bitcoin.address.toOutputScript(senderAddress!, network)
  const psbt = new bitcoin.Psbt({ network })

  for (const utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: senderScript, value: utxo.value },
    })
  }

  psbt.addOutput({ address: recipientAddress, value: sendAmount })

  for (let i = 0; i < utxos.length; i++) {
    psbt.signInput(i, keyPair)
  }

  psbt.finalizeAllInputs()
  const txHex = psbt.extractTransaction().toHex()

  console.log('\nBroadcasting...')
  const txid = await broadcast(txHex)
  console.log(`\nSuccess!`)
  console.log(`TXID : ${txid}`)
  console.log(`Link : https://mempool.space/testnet4/tx/${txid}`)

  return txid
}

const [, , senderWif, recipientAddress, amountArg] = process.argv

if (!senderWif || !recipientAddress) {
  console.error('Usage: bun run scripts/send-btc.ts <SENDER_WIF> <RECIPIENT_ADDRESS> [AMOUNT_SATS]')
  console.error('  Omit AMOUNT_SATS to sweep full balance.')
  process.exit(1)
}

send(senderWif, recipientAddress, amountArg ? parseInt(amountArg) : undefined).catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
