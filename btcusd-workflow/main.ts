/**
 * btcUSD Autonomous CDP Workflow
 *
 * Fully autonomous CRE workflow. Every trigger cycle it:
 *
 * 1. Cron or HTTP trigger fires
 * 2. Fetch current Bitcoin block height with consensusMedianAggregation (robust across DON nodes)
 * 3. Fetch UTXOs from mempool.space Testnet4 API with consensusIdenticalAggregation
 * 4. Filter for confirmed UTXOs (N+ confirmations)
 * 5. Read BTC/USD price from Chainlink Data Feed (latestRoundData with staleness check)
 * 6. For each unattested UTXO: encode V2 VaultAttestation (with autoMintAmountUsdWei),
 *    generate DON-signed report, submit to CDPCore — contract auto-mints btcUSD up to MCR capacity
 * 7. Submit a V3 Snapshot to authoritatively sync collateral (detects spent UTXOs, reduces collateral)
 * 8. Check vault health factor — if undercollateralized, submit a V4 Liquidation report so CDPCore
 *    autonomously burns the depositor's btcUSD debt and clears the vault (no liquidator wallet needed)
 *
 * All on-chain writes log their tx hash + Base Sepolia explorer link.
 */

import {
	bytesToHex,
	consensusIdenticalAggregation,
	consensusMedianAggregation,
	cre,
	type CronPayload,
	encodeCallMsg,
	getNetwork,
	hexToBase64,
	type HTTPPayload,
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
	keccak256,
	parseAbiParameters,
	stringToHex,
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
	enableVaultSnapshotSync: z.boolean().default(false), // Requires CDPCore with V3 snapshot support
	autoMintAmountUsdWei: z.string().default('0'), // Optional auto-mint amount requested per new attestation (18 decimals)
	network: z.object({
		chainName: z.string(), // e.g., "ethereum-testnet-sepolia-base-1"
		cdpCoreAddress: z.string(), // CDPCore contract address on Base Sepolia
		btcUsdFeedAddress: z.string(), // Chainlink BTC/USD feed on Base Sepolia
		gasLimit: z.string(),
	}),
})

type Config = z.infer<typeof configSchema>

const VAULT_SNAPSHOT_REPORT_KIND = keccak256(stringToHex('BTCUSD_VAULT_SNAPSHOT_V1'))
const VAULT_LIQUIDATION_REPORT_KIND = keccak256(stringToHex('BTCUSD_LIQUIDATION_V1'))

const explorerLink = (txHash: string) => `https://sepolia.basescan.org/tx/${txHash}`

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

	const resp = sendRequester.sendRequest({
		url,
		method: 'GET' as const,
		headers: { 'Content-Type': 'application/json' },
	}).result()
	return json(resp) as MempoolUTXO[]
}

// Standalone block height fetcher — used with consensusMedianAggregation so that
// small differences in chain tip across DON nodes are resolved via median rather
// than requiring all nodes to see the exact same block.
const fetchBlockHeightForConsensus = (sendRequester: HTTPSendRequester): number => {
	const resp = sendRequester.sendRequest({
		url: 'https://mempool.space/testnet4/api/blocks/tip/height',
		method: 'GET' as const,
		headers: { 'Content-Type': 'application/json' },
	}).result()
	const heightStr = new TextDecoder().decode(resp.body)
	return parseInt(heightStr, 10)
}

// UTXO fetcher for DON consensus — uses consensusIdenticalAggregation because
// txid and value are factual on-chain data that must match exactly across all nodes.
// Block height is passed in (already median-aggregated) to compute confirmations.
const fetchUTXOsForConsensus = (
	sendRequester: HTTPSendRequester,
	args: { vaultAddress: string; confirmationsRequired: number; currentHeight: number },
): string => {
	const utxos = fetchMempoolUTXOs(sendRequester, args.vaultAddress)

	const confirmedUtxos: ConfirmedUTXO[] = utxos
		.filter((utxo) => utxo.status.confirmed && utxo.status.block_height)
		.map((utxo) => ({
			txid: utxo.txid,
			value: utxo.value,
			blockHeight: utxo.status.block_height!,
			confirmations: args.currentHeight - utxo.status.block_height! + 1,
		}))
		.filter((utxo) => utxo.confirmations >= args.confirmationsRequired)

	return JSON.stringify(confirmedUtxos)
}

// ============ On-Chain Reads ============

const PRICE_STALENESS_SECONDS = 3600n // 1 hour (matches typical testnet heartbeat)

const readBtcUsdPrice = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
): bigint => {
	const feedAddress = runtime.config.network.btcUsdFeedAddress

	const callData = encodeFunctionData({
		abi: PriceFeedAggregator,
		functionName: 'latestRoundData',
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

	const [, answer, , updatedAt] = decodeFunctionResult({
		abi: PriceFeedAggregator,
		functionName: 'latestRoundData',
		data: bytesToHex(resp.data),
	}) as [bigint, bigint, bigint, bigint, bigint]

	// Reject stale price data
	const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
	const age = nowSeconds - updatedAt
	if (age > PRICE_STALENESS_SECONDS) {
		throw new Error(`BTC/USD price feed is stale: ${age}s old (max ${PRICE_STALENESS_SECONDS}s)`)
	}

	runtime.log(`BTC/USD price from Chainlink: ${answer.toString()} (8 decimals), age: ${age}s`)
	return answer
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

// ============ Liquidation Detection ============

const checkVaultHealth = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	userAddress: Address,
): bigint => {
	const cdpCoreAddress = runtime.config.network.cdpCoreAddress

	const callData = encodeFunctionData({
		abi: CDPCore,
		functionName: 'healthFactor',
		args: [userAddress],
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

	const healthFactor = decodeFunctionResult({
		abi: CDPCore,
		functionName: 'healthFactor',
		data: bytesToHex(resp.data),
	}) as bigint

	return healthFactor
}

// ============ Report Submission ============

const submitAttestation = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	utxo: ConfirmedUTXO,
	btcPriceUsd: bigint,
): string => {
	const config = runtime.config
	const requestedMintAmountUsd = BigInt(config.autoMintAmountUsdWei || '0')

	runtime.log(`Submitting attestation for txid: ${utxo.txid}`)
	runtime.log(`  Amount: ${utxo.value} satoshis`)
	runtime.log(`  Block height: ${utxo.blockHeight}`)
	runtime.log(`  BTC price: ${btcPriceUsd.toString()}`)
	runtime.log(`  Requested auto-mint: ${requestedMintAmountUsd.toString()} wei`)

	// Encode report payload. For backward compatibility with already-deployed
	// contracts, use V1 format when auto-mint is 0, else use V2 format.
	const txidBytes32 = txidToBytes32(utxo.txid)
	const timestamp = BigInt(Math.floor(Date.now() / 1000))

	const reportData =
		requestedMintAmountUsd > BigInt(0)
			? encodeAbiParameters(
					parseAbiParameters(
						'bytes32 txid, uint64 amountSat, uint32 blockHeight, uint256 btcPriceUsd, uint256 timestamp, address depositor, uint256 mintAmountUsd',
					),
					[
						txidBytes32,
						BigInt(utxo.value),
						utxo.blockHeight,
						btcPriceUsd,
						timestamp,
						config.depositorAddress as Address,
						requestedMintAmountUsd,
					],
				)
			: encodeAbiParameters(
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
	runtime.log(`  Explorer: ${explorerLink(txHashHex)}`)

	return txHashHex
}

const submitVaultSnapshot = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	totalCollateralSat: bigint,
	btcPriceUsd: bigint,
): string => {
	const config = runtime.config
	const timestamp = BigInt(Math.floor(Date.now() / 1000))

	// Keep snapshot minting disabled by default to avoid repeated minting each cron run.
	const requestedMintAmountUsd = BigInt(0)

	const reportData = encodeAbiParameters(
		parseAbiParameters(
			'bytes32 reportKind, address depositor, uint256 collateralSat, uint256 btcPriceUsd, uint256 timestamp, uint256 mintAmountUsd, uint256 reserved, uint256 version',
		),
		[
			VAULT_SNAPSHOT_REPORT_KIND,
			config.depositorAddress as Address,
			totalCollateralSat,
			btcPriceUsd,
			timestamp,
			requestedMintAmountUsd,
			BigInt(0),
			BigInt(1),
		],
	)

	const reportResponse = runtime
		.report({
			encodedPayload: hexToBase64(reportData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

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
		throw new Error(`Failed to write snapshot report: ${resp.errorMessage || resp.txStatus}`)
	}

	const snapshotTxHash = bytesToHex(resp.txHash || new Uint8Array(32))
	runtime.log(`Vault snapshot submitted! TX: ${snapshotTxHash}`)
	runtime.log(`  Explorer: ${explorerLink(snapshotTxHash)}`)
	return snapshotTxHash
}

// V4 Liquidation report: DON-signed signal to CDPCore to liquidate an undercollateralized vault.
// CDPCore is an authorized burner on BtcUSD so it can burn the depositor's tokens directly — no approval needed.
const submitLiquidation = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	depositorAddress: Address,
): string => {
	const config = runtime.config
	const timestamp = BigInt(Math.floor(Date.now() / 1000))

	// V4 report: (reportKind, depositor, timestamp) = 3 × 32 bytes
	const reportData = encodeAbiParameters(
		parseAbiParameters('bytes32 reportKind, address depositor, uint256 timestamp'),
		[VAULT_LIQUIDATION_REPORT_KIND, depositorAddress, timestamp],
	)

	const reportResponse = runtime
		.report({
			encodedPayload: hexToBase64(reportData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	const resp = evmClient
		.writeReport(runtime, {
			receiver: config.network.cdpCoreAddress,
			report: reportResponse,
			gasConfig: { gasLimit: config.network.gasLimit },
		})
		.result()

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`Failed to submit liquidation: ${resp.errorMessage || resp.txStatus}`)
	}

	const txHashHex = bytesToHex(resp.txHash || new Uint8Array(32))
	runtime.log(`Liquidation executed! TX: ${txHashHex}`)
	runtime.log(`  Explorer: ${explorerLink(txHashHex)}`)
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

	// 1a. Fetch current Bitcoin block height with median consensus.
	//     DON nodes may observe slightly different chain tips; median gives a
	//     robust canonical value without requiring all nodes to agree exactly.
	runtime.log(`Fetching Bitcoin tip block height with median consensus...`)
	const currentHeight = httpClient
		.sendRequest(runtime, fetchBlockHeightForConsensus, consensusMedianAggregation<number>())()
		.result()
	runtime.log(`Consensus block height: ${currentHeight}`)

	// 1b. Fetch UTXOs with identical consensus.
	//     txid and value are factual on-chain data — all nodes must agree exactly.
	runtime.log(`Fetching UTXOs from mempool.space Testnet4 API...`)
	const utxosJson = httpClient
		.sendRequest(runtime, fetchUTXOsForConsensus, consensusIdenticalAggregation<string>())({
			vaultAddress: config.vaultAddress,
			confirmationsRequired: config.confirmationsRequired,
			currentHeight,
		})
		.result()

	const confirmedUtxos: ConfirmedUTXO[] = JSON.parse(utxosJson)
	runtime.log(`Found ${confirmedUtxos.length} confirmed UTXOs with ${config.confirmationsRequired}+ confirmations`)

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

	// 3.5 Optional authoritative collateral synchronization.
	// This allows spent vault UTXOs to reduce on-chain collateral.
	let snapshot: { status: string; txHash?: string; totalCollateralSat?: string } | undefined
	if (config.enableVaultSnapshotSync) {
		const totalCollateralSat = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.value), BigInt(0))
		runtime.log(`Submitting vault snapshot sync with collateral=${totalCollateralSat.toString()} sats`)
		try {
			const snapshotTxHash = submitVaultSnapshot(runtime, evmClient, totalCollateralSat, btcPriceUsd)
			snapshot = {
				status: 'synced',
				txHash: snapshotTxHash,
				totalCollateralSat: totalCollateralSat.toString(),
			}
		} catch (error) {
			runtime.log(`Failed to sync vault snapshot: ${error}`)
			snapshot = { status: 'failed' }
		}
	}

	// 4. Check vault health for liquidation detection
	runtime.log(`=== Checking Vault Health ===`)
	const depositorAddress = config.depositorAddress as Address
	const healthFactor = checkVaultHealth(runtime, evmClient, depositorAddress)

	// CDPCore health factor is integer basis points where:
	// - 100 = exactly at MCR threshold
	// - <100 = liquidatable
	const LIQUIDATION_THRESHOLD = BigInt(100)
	const isLiquidatable = healthFactor > BigInt(0) && healthFactor < LIQUIDATION_THRESHOLD

	runtime.log(`Depositor: ${depositorAddress}`)
	runtime.log(`Health Factor: ${healthFactor.toString()}`)
	runtime.log(`Liquidatable: ${isLiquidatable}`)

	let liquidationTxHash: string | undefined
	if (isLiquidatable) {
		runtime.log(`⚠️ Vault undercollateralized — submitting autonomous liquidation report...`)
		try {
			liquidationTxHash = submitLiquidation(runtime, evmClient, depositorAddress)
		} catch (error) {
			runtime.log(`Failed to submit liquidation: ${error}`)
		}
	} else if (healthFactor === BigInt(0)) {
		runtime.log(`No active debt position for this depositor.`)
	} else {
		runtime.log(`✓ Vault is healthy (above 150% MCR)`)
	}

	return safeJsonStringify({
		status: 'complete',
		vaultAddress: config.vaultAddress,
		btcPriceUsd: btcPriceUsd.toString(),
		processed: attestedCount,
		results,
		snapshot,
		liquidationStatus: {
			depositor: depositorAddress,
			healthFactor: healthFactor.toString(),
			isLiquidatable,
			liquidationTxHash,
		},
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

// HTTP trigger allows operators to run the workflow on-demand without waiting
// for the next cron interval — useful for manual attestation checks or demos.
const onHttpTrigger = (runtime: Runtime<Config>, _payload: HTTPPayload): string => {
	runtime.log(`HTTP trigger fired — running on-demand attestation check`)
	return processAttestations(runtime)
}

// ============ Workflow Init ============

const initWorkflow = (config: Config) => {
	const cron = new cre.capabilities.CronCapability()
	const http = new cre.capabilities.HTTPCapability()
	return [
		cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
		cre.handler(http.trigger({}), onHttpTrigger),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}

main()
