/**
 * btcUSD Bitcoin Attestation Workflow
 *
 * This CRE workflow monitors a Bitcoin vault address, verifies deposits via mempool.space API,
 * reads BTC/USD price from Chainlink Data Feeds, and submits signed attestations to CDPCore.
 *
 * Flow:
 * 1. Cron triggers every 2 minutes
 * 2. Fetch UTXOs from mempool.space Testnet4 API for the vault address
 * 3. Filter for confirmed UTXOs (6+ confirmations)
 * 4. Check if each UTXO is already attested via CDPCore.isAttested()
 * 5. Read BTC/USD price from Chainlink Data Feed
 * 6. Encode VaultAttestation struct
 * 7. Generate DON-signed report
 * 8. Submit report to CDPCore on Base Sepolia
 */

import {
	bytesToHex,
	consensusIdenticalAggregation,
	cre,
	type CronPayload,
	encodeCallMsg,
	getNetwork,
	hexToBase64,
	type HTTPSendRequester,
	json,
	LAST_FINALIZED_BLOCK_NUMBER,
	Runner,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	parseAbiParameters,
	zeroAddress,
} from 'viem'
import { z } from 'zod'
import { CDPCore, PriceFeedAggregator } from './contracts/abi'

// ============ Config Schema ============

const configSchema = z.object({
	schedule: z.string(), // Cron schedule, e.g., "0 */2 * * * *" (every 2 min)
	vaultAddress: z.string(), // Bitcoin testnet vault address to monitor
	depositorAddress: z.string(), // EVM address of the depositor (for demo: single user)
	confirmationsRequired: z.number().min(1).default(6), // Minimum confirmations
	network: z.object({
		chainName: z.string(), // e.g., "ethereum-testnet-sepolia-base-1"
		cdpCoreAddress: z.string(), // CDPCore contract address on Base Sepolia
		btcUsdFeedAddress: z.string(), // Chainlink BTC/USD feed on Base Sepolia
		gasLimit: z.string(),
	}),
})

type Config = z.infer<typeof configSchema>

// ============ Types ============

// Mempool.space API UTXO response shape (Testnet4)
interface MempoolUTXO {
	txid: string
	vout: number
	value: number // satoshis
	status: {
		confirmed: boolean
		block_height?: number
		block_hash?: string
		block_time?: number
	}
}

// Internal UTXO representation after filtering
interface ConfirmedUTXO {
	txid: string
	value: number // satoshis
	blockHeight: number
	confirmations: number
}

// ============ Helpers ============

const safeJsonStringify = (obj: unknown): string =>
	JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

const getEvmClient = (chainName: string) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: chainName,
		isTestnet: true,
	})
	if (!network) {
		throw new Error(`Network not found for chain: ${chainName}`)
	}
	return new cre.capabilities.EVMClient(network.chainSelector.selector)
}

// Convert txid string (64 hex chars) to bytes32
const txidToBytes32 = (txid: string): Hex => {
	// Bitcoin txids are displayed in reverse byte order, so we reverse it
	const bytes = txid.match(/.{2}/g)?.reverse().join('') || txid
	return `0x${bytes}` as Hex
}

// ============ Mempool.space Testnet4 API ============

const fetchMempoolUTXOs = (
	sendRequester: HTTPSendRequester,
	vaultAddress: string,
): MempoolUTXO[] => {
	const url = `https://mempool.space/testnet4/api/address/${vaultAddress}/utxo`

	const req = {
		url,
		method: 'GET' as const,
		headers: {
			'Content-Type': 'application/json',
		},
	}

	const resp = sendRequester.sendRequest(req).result()
	return json(resp) as MempoolUTXO[]
}

const fetchCurrentBlockHeight = (sendRequester: HTTPSendRequester): number => {
	const url = 'https://mempool.space/testnet4/api/blocks/tip/height'

	const req = {
		url,
		method: 'GET' as const,
		headers: {
			'Content-Type': 'application/json',
		},
	}

	const resp = sendRequester.sendRequest(req).result()
	// Response is plain text number
	const heightStr = new TextDecoder().decode(resp.body)
	return parseInt(heightStr, 10)
}

// Fetch function for consensus - returns UTXOs as JSON string
const fetchUTXOsForConsensus = (
	sendRequester: HTTPSendRequester,
	config: Config,
): string => {
	const utxos = fetchMempoolUTXOs(sendRequester, config.vaultAddress)
	const currentHeight = fetchCurrentBlockHeight(sendRequester)

	// Filter and enrich UTXOs
	const confirmedUtxos: ConfirmedUTXO[] = utxos
		.filter((utxo) => utxo.status.confirmed && utxo.status.block_height)
		.map((utxo) => ({
			txid: utxo.txid,
			value: utxo.value,
			blockHeight: utxo.status.block_height!,
			confirmations: currentHeight - utxo.status.block_height! + 1,
		}))
		.filter((utxo) => utxo.confirmations >= config.confirmationsRequired)

	return JSON.stringify(confirmedUtxos)
}

// ============ On-Chain Reads ============

const readBtcUsdPrice = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
): bigint => {
	const feedAddress = runtime.config.network.btcUsdFeedAddress

	const callData = encodeFunctionData({
		abi: PriceFeedAggregator,
		functionName: 'latestAnswer',
	})

	const resp = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: feedAddress as Address,
				data: callData,
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const price = decodeFunctionResult({
		abi: PriceFeedAggregator,
		functionName: 'latestAnswer',
		data: bytesToHex(resp.data),
	}) as bigint

	runtime.log(`BTC/USD price from Chainlink: ${price.toString()} (8 decimals)`)
	return price
}

const checkIsAttested = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	txidBytes32: Hex,
): boolean => {
	const cdpCoreAddress = runtime.config.network.cdpCoreAddress

	const callData = encodeFunctionData({
		abi: CDPCore,
		functionName: 'isAttested',
		args: [txidBytes32],
	})

	const resp = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: cdpCoreAddress as Address,
				data: callData,
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const isAttested = decodeFunctionResult({
		abi: CDPCore,
		functionName: 'isAttested',
		data: bytesToHex(resp.data),
	}) as boolean

	return isAttested
}

// ============ Report Submission ============

const submitAttestation = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	utxo: ConfirmedUTXO,
	btcPriceUsd: bigint,
): string => {
	const config = runtime.config

	runtime.log(`Submitting attestation for txid: ${utxo.txid}`)
	runtime.log(`  Amount: ${utxo.value} satoshis`)
	runtime.log(`  Block height: ${utxo.blockHeight}`)
	runtime.log(`  BTC price: ${btcPriceUsd.toString()}`)

	// Encode VaultAttestation struct
	// struct VaultAttestation {
	//     bytes32 txid;
	//     uint64 amountSat;
	//     uint32 blockHeight;
	//     uint256 btcPriceUsd;
	//     uint256 timestamp;
	//     address depositor;
	// }
	const txidBytes32 = txidToBytes32(utxo.txid)
	const timestamp = BigInt(Math.floor(Date.now() / 1000))

	const reportData = encodeAbiParameters(
		parseAbiParameters(
			'bytes32 txid, uint64 amountSat, uint32 blockHeight, uint256 btcPriceUsd, uint256 timestamp, address depositor',
		),
		[
			txidBytes32,
			BigInt(utxo.value),
			utxo.blockHeight,
			btcPriceUsd,
			timestamp,
			config.depositorAddress as Address,
		],
	)

	runtime.log(`Encoded report data: ${reportData}`)

	// Generate DON-signed report
	const reportResponse = runtime
		.report({
			encodedPayload: hexToBase64(reportData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Submit to CDPCore via Keystone Forwarder
	const resp = evmClient
		.writeReport(runtime, {
			receiver: config.network.cdpCoreAddress,
			report: reportResponse,
			gasConfig: {
				gasLimit: config.network.gasLimit,
			},
		})
		.result()

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`Failed to write report: ${resp.errorMessage || resp.txStatus}`)
	}

	const txHash = resp.txHash || new Uint8Array(32)
	const txHashHex = bytesToHex(txHash)

	runtime.log(`Attestation submitted successfully!`)
	runtime.log(`  TX Hash: ${txHashHex}`)

	return txHashHex
}

// ============ Main Workflow Logic ============

const processAttestations = (runtime: Runtime<Config>): string => {
	const config = runtime.config

	runtime.log(`=== btcUSD Bitcoin Attestation Workflow ===`)
	runtime.log(`Vault address: ${config.vaultAddress}`)
	runtime.log(`Min confirmations: ${config.confirmationsRequired}`)

	// Initialize clients
	const evmClient = getEvmClient(config.network.chainName)
	const httpClient = new cre.capabilities.HTTPClient()

	// 1. Fetch UTXOs with DON consensus
	runtime.log(`Fetching UTXOs from mempool.space Testnet4 API...`)

	const utxosJson = httpClient
		.sendRequest(runtime, fetchUTXOsForConsensus, consensusIdenticalAggregation<string>())(config)
		.result()

	const confirmedUtxos: ConfirmedUTXO[] = JSON.parse(utxosJson)
	runtime.log(`Found ${confirmedUtxos.length} confirmed UTXOs with ${config.confirmationsRequired}+ confirmations`)

	if (confirmedUtxos.length === 0) {
		runtime.log(`No new deposits to process.`)
		return JSON.stringify({ status: 'no_deposits', processed: 0 })
	}

	// 2. Read BTC/USD price from Chainlink
	const btcPriceUsd = readBtcUsdPrice(runtime, evmClient)

	// 3. Process each UTXO
	const results: Array<{ txid: string; status: string; txHash?: string }> = []

	for (const utxo of confirmedUtxos) {
		const txidBytes32 = txidToBytes32(utxo.txid)

		// Check if already attested
		const isAttested = checkIsAttested(runtime, evmClient, txidBytes32)

		if (isAttested) {
			runtime.log(`UTXO ${utxo.txid} already attested, skipping.`)
			results.push({ txid: utxo.txid, status: 'already_attested' })
			continue
		}

		// Submit attestation
		try {
			const txHash = submitAttestation(runtime, evmClient, utxo, btcPriceUsd)
			results.push({ txid: utxo.txid, status: 'attested', txHash })
		} catch (error) {
			runtime.log(`Failed to attest UTXO ${utxo.txid}: ${error}`)
			results.push({ txid: utxo.txid, status: 'failed' })
		}
	}

	const attestedCount = results.filter((r) => r.status === 'attested').length
	runtime.log(`=== Attestation complete: ${attestedCount}/${confirmedUtxos.length} processed ===`)

	return safeJsonStringify({
		status: 'complete',
		vaultAddress: config.vaultAddress,
		btcPriceUsd: btcPriceUsd.toString(),
		processed: attestedCount,
		results,
	})
}

// ============ Handlers ============

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
	if (!payload.scheduledExecutionTime) {
		throw new Error('Scheduled execution time is required')
	}
	runtime.log(`Cron triggered at: ${payload.scheduledExecutionTime}`)
	return processAttestations(runtime)
}

// ============ Workflow Init ============

const initWorkflow = (config: Config) => {
	const cron = new cre.capabilities.CronCapability()
	return [
		cre.handler(
			cron.trigger({ schedule: config.schedule }),
			onCronTrigger,
		),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}

main()
