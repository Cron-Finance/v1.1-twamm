import { BigNumber, Signer, utils } from "ethers";
import { expect } from "chai"
import { network } from "hardhat"

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import { Vault } from "typechain/contracts/twault/balancer-core-v2/vault/Vault";
import { Vault__factory } from "typechain/factories/contracts/twault/balancer-core-v2/vault/Vault__factory";

import { PoolType, getBlockInterval } from "./../../scripts/utils/contractMgmt"
import { getNextOrderId,
         Swap,
         SwapManager,
         VaultTwammPoolAPIHelper } from "./../helpers/vaultTwammPoolAPIHelper"
import { PoolModel } from "../model_v2/vaultTwammPool"
import { ReserveCompareType, ReserveType, TokenPairAmtType, HistoricalBalance, Numberish } from "./types";


// Logging:
const ds = require("../../scripts/utils/debugScopes");
const log = ds.getLog("helpers-misc");

export const NULL_ADDR = "0x0000000000000000000000000000000000000000";
export const ZERO = BigNumber.from(0)



export function scaleUp(value: BigInt | BigNumber, decimals: BigInt | BigNumber | number): BigNumber
{
  let scaledValue = BigNumber.from(value)
  let decimalsBN = BigNumber.from(decimals)
  return scaledValue.mul(BigNumber.from(10).pow(decimalsBN))
}

export const getLastBlockNumber = async ():Promise<number> => 
{
  return Number(await network.provider.send("eth_blockNumber"));
}

export const getCurrentBlockNumber = async():Promise<number> =>
{
  return await getLastBlockNumber() + 1
}

export const seekToBlock = async (targetBlock: number, confirm: boolean = true): Promise<void> =>
{
  // Mine to block target block:
  //
  let currBlock = await getLastBlockNumber() + 1
  let blocksToMine = targetBlock - currBlock
  if (blocksToMine < 1) {
    throw Error(`Can't seek to block ${targetBlock}!  Current block number is ${currBlock}.`)
  }
  await mineBlocks(blocksToMine)

  currBlock = await getLastBlockNumber() + 1
  expect(currBlock).to.eq(targetBlock)
}

function toHexString(decimalNumber: number): string
{
  return `0x${decimalNumber.toString(16)}`
}

export const getBlockTimestamp = async(blockNumber: number, verbose=false):Promise<number> => 
{
  const blockObj = await network.provider.send("eth_getBlockByNumber", [toHexString(blockNumber), false]);
  const timestamp = Number(blockObj.timestamp)
  if (verbose) {
    log.info(`Block=${blockNumber}, timestamp=${timestamp}`)
  }

  return timestamp;
}

export const getTradeBlocks = async (intervals: number, obi?: number): Promise<number> => {
  if (obi == undefined) {
    const POOL_TYPE = PoolType.Liquid
    obi = getBlockInterval(POOL_TYPE);
  }

  const blockNumber = await getLastBlockNumber() + 1
  const lastExpiryBlock = blockNumber - (blockNumber % obi)
  const orderExpiry = obi * (intervals + 1) + lastExpiryBlock
  return orderExpiry - blockNumber
}


export const mineBlocks = async (blocksToMine?: number, verbose=false):Promise<number> =>
{
  const start = Number(await network.provider.send("eth_blockNumber"));
  const startTimestamp = await getBlockTimestamp(start, verbose);
  
  blocksToMine = (!blocksToMine) ? 1 : blocksToMine

  const BLOCK_TIME = 12   // 12s block times

  const nextTimeStamp = startTimestamp + BLOCK_TIME
  await network.provider.send("evm_setNextBlockTimestamp", [toHexString(nextTimeStamp)])

  // Fast way of doing this in hardhat w/ 12s block times:
  await network.provider.send("hardhat_mine", [toHexString(blocksToMine), toHexString(BLOCK_TIME)]);
  //
  // instead of slow way:
  //
  //  for (let idx = 0; idx < blocksToMine; idx++) {
  //    await network.provider.send("evm_mine");
  //  }

  const end = Number(await network.provider.send("eth_blockNumber"));

  if (verbose) {
    const timestamp = getBlockTimestamp(end, verbose);
    log.info(`Mined ${blocksToMine} blocks (start=${start}, end=${end}, diff=${end-start})`)
  }

  return end
}

export const deployBalancerVault = async (signer: Signer, wethAddress: string): Promise<Vault> =>
{
  const signerAddress = await signer.getAddress();
  const vaultDeployer = new Vault__factory(signer);
  const vaultContract = await vaultDeployer.deploy(
    signerAddress,
    wethAddress,
    0,
    0
  );
  
  // Next line needed when not automining.  (Not automining to align blocks to get
  // consistent benchmark results for TWAMM testing.)
  await mineBlocks();
  
  await vaultContract.deployed();
  return vaultContract;
}

export const getBalanceData = async (poolHelper: VaultTwammPoolAPIHelper,
                                     poolModel: PoolModel): Promise<any> =>
{
  let balanceData: any = {}
  for (const balanceType of ['vault', 'orders', 'proceeds', 'balFees', 'cronFees', 'reserves']) {
    balanceData[balanceType] = { 
      contract: await poolHelper.getPoolBalance(balanceType),
      model: poolModel.getPoolBalance(balanceType)
    }
  }

  return balanceData
}

export const getBalanceDataComparisonStr = (balanceData: any): string =>
{
  let comparisonStr = ''
  for (const balanceType of Object.keys(balanceData)) {
    const balances = balanceData[balanceType]
    const { contract, model } = balances
    comparisonStr += `\t${balanceType}:\n`
    for (const token of ['token0', 'token1']) {
      comparisonStr += `\t\t${token} difference=${contract[token].sub(model[token])}\n` +
                       `\t\t         ${contract[token]} (contract)\n` +
                       `\t\t         ${model[token]} (model)\n`
    }
  }
  return comparisonStr
}

export const testBalanceData = (balanceData: any, tolerance?: BigNumber | number): void =>
{
  let _tolerance: BigNumber = (tolerance === undefined) ? BigNumber.from(0) :
                              (typeof tolerance === 'number') ? BigNumber.from(tolerance) :
                              tolerance

  const failures: string[] = []

  for (const balanceType of Object.keys(balanceData)) {
    const balances = balanceData[balanceType]
    const { contract, model } = balances
    for (const token of ['token0', 'token1']) {
      const difference = contract[token].sub(model[token])
      if (difference.abs().gt(_tolerance)) {
        failures.push(`${balanceType} (${token} difference=${difference})`)
      }
    }
  }

  let message = ''
  if (failures.length > 0) {
    message += `\n` +
               `The following balances exceeded specified tolerance of ${_tolerance}:\n` +
               `\t${failures.join('\t\n')}\n\n` +
               `All balances compared:\n` +
               `${getBalanceDataComparisonStr(balanceData)}`
  }

  expect(failures.length===0, message).to.be.equal(true)
}

export const getReserveData = async (poolHelper: VaultTwammPoolAPIHelper,
                                     poolModel: PoolModel,
                                     tolerance?: number,
                                     vaultTolerance?: ReserveType,
                                     stateTolerance?: ReserveType,
                                     viewTolerance?: ReserveType): Promise<ReserveCompareType[]> =>
{
  // Actual values:
  const vaultAct = await poolHelper.getVaultPoolReserves()
  const viewAct = await poolHelper.getPoolReserves()

  // Expected values from model:
  const vaultExp = poolModel.getVaultReserves()
  const viewExp = poolModel.getTwammReserves()

  const toleranceBN = (tolerance === undefined) ? BigNumber.from(0) : BigNumber.from(tolerance)
  vaultTolerance = (vaultTolerance) ? vaultTolerance : { reserve0: toleranceBN, reserve1: toleranceBN }
  viewTolerance = (viewTolerance) ? viewTolerance : { reserve0: toleranceBN, reserve1: toleranceBN }
  
  
  const result: ReserveCompareType[] = [ { pairs: { vaultAct, vaultExp }, differences: vaultTolerance } ]

  result.push({ pairs: { viewAct, viewExp },   differences: viewTolerance })
  return result
}

export const getReserveDataDifferenceStr = (reserveData: ReserveCompareType[],
                                            warnOnAcceptableDifference=false): string => 
{
  const reservePairKeys = ['reserve0', 'reserve1']
  const actualIdx = 0
  const expectedIdx = 1

  let differenceStr = ''
  for (const reserveDataObj of reserveData) {
    const reservePairNames = Object.keys(reserveDataObj.pairs)
    const reservePairObjs: any = Object.values(reserveDataObj.pairs)
    let resKeyCount = 0
    for (const reserveKey of reservePairKeys) {
      resKeyCount++
      const actualObj = reservePairObjs[actualIdx][reserveKey]
      const expectedObj = reservePairObjs[expectedIdx][reserveKey]
      const difference = actualObj.sub(expectedObj)
      // TODO: something better than the next line to workaround the typescript
      //       issue with indexing defined objects
      const expectedDifference = (reserveKey === 'reserve0') ?
        reserveDataObj.differences.reserve0 :
        reserveDataObj.differences.reserve1

      if (!difference.eq(expectedDifference)) {
        const actualResPairName = reservePairNames[actualIdx]
        let resType = (actualResPairName.startsWith('vpr')) ? 'B-Vault:  ' :
          (actualResPairName.startsWith('psr')) ?             'T-State:  ' :
          (actualResPairName.startsWith('pr')) ?              'T-View:   ' : ''

        const actualName = reservePairNames[actualIdx] + '.' + reserveKey
        const expectedName = reservePairNames[expectedIdx] + '.' + reserveKey
        differenceStr += (resKeyCount === 1) ? `${resType}\n` : ''
        differenceStr +=
          `\t${actualName} - ${expectedName} = ${difference}, Expect ${expectedDifference}\n` +
          `\t\t${actualName} = ${actualObj}\n` +
          `\t\t${expectedName} = ${expectedObj}\n`
      }
    }
  }
  if (differenceStr !== '') {
    differenceStr = '\nFound Reserve Differences (Actual - Expected = Difference)\n' +
                    '--------------------------------------------------------------------------------\n' + 
                    differenceStr + '\n'
    if (warnOnAcceptableDifference) {
      log.warn(differenceStr)
    }
  }

  return differenceStr
}

/**
 * Compares different reserve actual values against expected, identifying 
 * differences and testing to ensure that the difference is met as a +/- tolerance
 * between values.
 * 
 * Useful for quickly identifying tolerances between multiple values in a specific
 * test (one iteration to discover and set the values).
 * 
 * @param reserveData An array of reserve compare types, for example:
 * 
 *     let reserveData: any = [
 *       { pairs: { vpr, evpr }, differences: { reserve0: 5, reserve1: 4 } },
 *       { pairs: { psr, epsr }, differences: { reserve0: 2, reserve1: 2 } },
 *       { pairs: { pr, epr },   differences: { reserve0: 2, reserve1: 2 } } ]
 *
 * TODO: This won't fail if there is a change--just if the change exceeds the largest
 *       difference.
 *       - add ability to fail on a difference.
 */
export const compareReserveData = (reserveData: ReserveCompareType[], warnOnAcceptableDifference=false): void =>
{
  const reservePairKeys = ['reserve0', 'reserve1']
  const actualIdx = 0
  const expectedIdx = 1

  // Two-pass comparison.
  //
  // 1. Compute the actual differences and report if they are not
  //    as expected.
  let differenceStr = getReserveDataDifferenceStr(reserveData, warnOnAcceptableDifference)
  
  // 2. Perform expect closeTo comparisons using the expected 
  //    differences to fail the test if changes detected.
  for (const reserveDataObj of reserveData) {
    const reservePairNames = Object.keys(reserveDataObj.pairs)
    const reservePairObjs: any = Object.values(reserveDataObj.pairs)
    for (const reserveKey of reservePairKeys) {
      const actualObj = reservePairObjs[actualIdx][reserveKey]
      const expectedObj = reservePairObjs[expectedIdx][reserveKey]
      const actualName = reservePairNames[actualIdx] + '.' + reserveKey
      const expectedName = reservePairKeys[expectedIdx] + '.' + reserveKey

      const tolerance = (reserveKey === 'reserve0') ?
        reserveDataObj.differences.reserve0.abs() :
        reserveDataObj.differences.reserve1.abs()
      
      // Note: had to put optional message in expect instead of closeTo to get it to print.
      const message = '\n' +
                      `Actual reserve, ${actualName}, doesn't match expected, ${expectedName}\n`
                      + differenceStr +
                      'AssertionError'
      expect(actualObj, message)
      .to.be.closeTo(
        expectedObj,
        tolerance)
    }
  }
}

export const checkFees = async (poolContract: any,
                                poolModel: PoolModel,
                                tolerance=0,
                                warnOnAcceptableDifference=true,
                                logDifference=false): Promise<void> =>
{
  const actualBalancerFees = await poolContract.getBalancerFeeAmounts();
  const balFeeT0: BigNumber = actualBalancerFees.balFee0U96;
  const balFeeT1: BigNumber = actualBalancerFees.balFee1U96;

  const balancerFees = poolModel.getBalancerFees()
  const balFeeDiffT0 = balFeeT0.sub(balancerFees.token0)
  const balFeeDiffT1 = balFeeT1.sub(balancerFees.token1)

  const toleranceBN = BigNumber.from(tolerance)

  let differenceStr = ''
  if (balFeeDiffT0.abs().gt(toleranceBN) || logDifference) {
    differenceStr += `Balancer Fees Token 0 Difference = ${balFeeDiffT0}\n` +
                     `\tactual = ${balFeeT0}\n` +
                     `\tmodel  = ${balancerFees.token0}\n`
  }
  if (balFeeDiffT1.abs().gt(toleranceBN) || logDifference) {
    differenceStr += `Balancer Fees Token 1 Difference = ${balFeeDiffT1}\n` +
                     `\tactual = ${balFeeT1}\n` +
                     `\tmodel  = ${balancerFees.token1}\n`
  }
  if (differenceStr !== '') {
    differenceStr = '\nFound Balancer Fee Differences (Actual - Expected = Difference)\n' +
                    '--------------------------------------------------------------------------------\n' + 
                    differenceStr + '\n'
    if (warnOnAcceptableDifference) {
      log.warn(differenceStr)
    }
  }

  const checks = [ { name: 'Balancer Fees T0', actual: balFeeT0, expected: balancerFees.token0 },
                   { name: 'Balancer Fees T1', actual: balFeeT1, expected: balancerFees.token1 } ]
  for (const check of checks) {
    const message = '\n' +
                    `${check.name} actual doesn't match expected.\n`
                    + differenceStr +
                    'AssertionError'
    expect(check.actual, message).to.be.closeTo(check.expected, toleranceBN)
  }
}

export const getVaultBalances = async(poolHelper: VaultTwammPoolAPIHelper): Promise<TokenPairAmtType> => {
  const balancerVaultContract: Vault = poolHelper.getVaultContract()
  const poolId: string = poolHelper.getPoolId()
  const t0Addr: string = poolHelper.getToken0Contract().address
  const t1Addr: string = poolHelper.getToken1Contract().address

  const t0Data = await balancerVaultContract.getPoolTokenInfo(poolId, t0Addr)
  const t1Data = await balancerVaultContract.getPoolTokenInfo(poolId, t1Addr)
  return {
    token0: t0Data.cash.add(t0Data.managed),
    token1: t1Data.cash.add(t1Data.managed)
  }
}

// Converts types
export const getReserveAmounts = async(poolContract: any, blockNumber?: number): Promise<ReserveType> => {
  blockNumber = (blockNumber != undefined) ? blockNumber : await getLastBlockNumber();
  const vrResult = await poolContract.callStatic.getVirtualReserves(blockNumber, false)
  return {
    reserve0: vrResult.token0ReserveU112,
    reserve1: vrResult.token1ReserveU112
  }
}

export const dumpContractAccounting = async(poolHelper: VaultTwammPoolAPIHelper,
                                       tag?: string): Promise<any> =>
{
  const _tag = (tag==undefined) ? '' : `(${tag})`

  const blockNumber = await getLastBlockNumber()

  const vaultBalances = await getVaultBalances(poolHelper);
  const viewReserves = await getReserveAmounts(poolHelper.getPoolContract(),
                                                blockNumber)
 
  const poolContract = poolHelper.getPoolContract();
  const orders = await poolContract.getOrderAmounts();
  const proceeds = await poolContract.getProceedAmounts();
  const balancerFees = await poolContract.getBalancerFeeAmounts();
  const cronFiFees = await poolContract.getCronFeeAmounts();

  const salesRates = await poolContract.getSalesRates();
  
  const lvob = await poolContract.getLastVirtualOrderBlock()
  
  const token0TwammRes = vaultBalances.token0.sub(
                            orders.orders0U112.add(
                              proceeds.proceeds0U112.add(
                                balancerFees.balFee0U96.add(
                                  cronFiFees.cronFee0U96))));

  const token1TwammRes = vaultBalances.token1.sub(
                            orders.orders1U112.add(
                              proceeds.proceeds1U112.add(
                                balancerFees.balFee1U96.add(
                                  cronFiFees.cronFee1U96))));

  log.debug(`\nPool Accounting State: ${_tag}\n` +
            `--------------------------------------------------\n` +
            `Block Num:             ${blockNumber}\n` +
            `LVOB:                  ${lvob}\n` +
            `LP supply:             ${await poolContract.totalSupply()}\n` +
            `Vault Reserve0:        ${vaultBalances.token0}\n` +
            `Vault Reserve1:        ${vaultBalances.token1}\n` +
            `Orders T0:             ${orders.orders0U112}\n` +
            `Orders T1:             ${orders.orders1U112}\n` +
            `Proceeds T0:           ${proceeds.proceeds0U112}\n` +
            `Proceeds T1:           ${proceeds.proceeds1U112}\n` +
            `Twamm Diff Reserve0:   ${token0TwammRes}\n` +
            `Twamm Diff Reserve1:   ${token1TwammRes}\n` +
            `Twamm View Reserve0:   ${viewReserves.reserve0}\n` +
            `Twamm View Reserve1:   ${viewReserves.reserve1}\n` +
            `Collect Balancer Fees: ${await poolContract.isCollectingBalancerFees()}\n` +
            `Swap Fee Points:       ${await poolContract.getShortTermFeePoints()}\n` +
            `Partner Points:        ${await poolContract.getPartnerFeePoints()}\n` +
            `LT Fee Points:         ${await poolContract.getLongTermFeePoints()}\n` +
            `Balancer Fees0:        ${balancerFees.balFee0U96}\n` +
            `Balancer Fees1:        ${balancerFees.balFee1U96}\n` +
            `CronFi Fees0:          ${cronFiFees.cronFee0U96}\n` +
            `CronFi Fees1:          ${cronFiFees.cronFee1U96}\n` +
            `Sales Rate 0:          ${salesRates.salesRate0U112}\n` +
            `Sales Rate 1:          ${salesRates.salesRate1U112}\n`)
}

export const dumpOrder = async ( poolContract: any,
                                 account: SignerWithAddress,
                                 orderId: BigInt | Number,
                                 tag?: string ): Promise<void> =>
{
  let _orderId: BigInt
  if (typeof orderId === 'number') {
    _orderId = BigInt(orderId)
  } else if (typeof orderId === 'bigint') {
    _orderId = orderId
  } else {
    throw new Error(`Value passed in for orderId is not BigInt or Number: ${typeof orderId}`)
  }

  const orderInfo = await poolContract.connect(account).getOrder(_orderId)
  const _tag = (tag==undefined) ? '' : `(${tag})`
  log.info(`\n` +
           `Order ID ${_orderId} ${_tag}\n` +
           `--------------------------------------------------------------------------------\n` +
           `curr block =   ${await getLastBlockNumber()}\n` +
           `token0To1 =    ${orderInfo.token0To1}\n` +
           `paused =       ${orderInfo.paused}\n` +
           `deposit =      ${orderInfo.deposit}\n` +
           `proceeds =     ${orderInfo.proceeds}\n` +
           `salesRate =    ${orderInfo.salesRate}\n` +
           `owner =        ${orderInfo.owner}\n` +
           `delegate =     ${orderInfo.delegate}\n` +
           `orderExpiry =  ${orderInfo.orderExpiry}\n` +
           `orderStart =   ${orderInfo.orderStart}\n` +
           `scaledProceedsAtSubmissionU128 =  ${orderInfo.scaledProceedsAtSubmissionU128}\n`)
}

// NOTE: revertCode is not used herein, but is in place for future 
//       in the event that the problem divining the revert code is 
//       solved and expect to be revertedwith can be used.
//
export const expectFailure = async ( transaction: any,
                                     failDesc: string,
                                     revertCode: string,
                                     reason = "transaction failed",
                                     code = "CALL_EXCEPTION" ): Promise<void> =>
{
  let failed = false
  try {
    const rct = await transaction.wait()
  } catch (error: any) {
    failed = error && 
             error.reason === reason &&
             error.code === code;
  }
  expect(failed, failDesc).to.eq(true)
}

export const boolToBN = (value: boolean): BigNumber => {
  return (value) ? BigNumber.from(1) : ZERO;
}

export const ratiosNearlyEqual = (
                                   numeratorA: BigNumber,
                                   denominatorA: BigNumber,
                                   numeratorB: BigNumber,
                                   denominatorB: BigNumber,
                                   tolerance = BigNumber.from(1_000_000_000_000_000_000n) // 1e18
                                 ): boolean =>
{
  // Integer comparison to find out if two ratios are within 1/tolerance of eachother, from:
  //
  //    |  numeratorA       numeratorB  |          1
  //    | ------------  -  ------------ |  <=  ---------
  //    | denominatorA     denominatorB |      tolerance
  //
  return tolerance.mul((numeratorA.mul(denominatorB)).sub(numeratorB.mul(denominatorA)).abs())
         .lte(denominatorA.mul(denominatorB))
}


// TODO: cleanup passed in replacer handling ... (currently totally ignored)
export class JSONBI {
  static stringify = (value: any, 
               replacer?: ((this: any, key: string, value: any) => any) | undefined | null,
               space?: string | number | undefined): string =>
  {
    return JSON.stringify(value, JSONBI._replacerBI, space)
  }
  
  static parse(text: string,
        reviver?: ((this: any, key: string, value: any) => any) | undefined): any
  {
    return JSON.parse(text, JSONBI._reviverBI)
  }

  private static _replacerBI = (key: string, value: any): string => 
  {
    if (typeof value === 'object' &&
        value.hasOwnProperty('type') &&
        value.type === 'BigNumber') {
      return BigInt(value.hex).toString() + 'n'
    } else if (typeof value === 'bigint') {
      return value.toString() + 'n'
    }
    return value
  }

  private static _reviverBI = (key: string, value: any): any =>
  {
    // Adapted from: https://dev.to/benlesh/bigint-and-json-stringify-json-parse-2m8p
    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, value.length - 1));
    }
    return value
  }
}

export const getNumTradeBlocks = async(intervals: number,
                                obi: number,
                                doApprovals: boolean = true): Promise<number> =>
{
  let blockNumber = await getCurrentBlockNumber()

  // If the test infrastructure is doing approvals, the swap will execute in the next block.
  if (doApprovals) {
    blockNumber++
  }

  const lastExpiryBlock = blockNumber - (blockNumber % obi)
  const orderExpiry = obi * (intervals + 1) + lastExpiryBlock
  const tradeBlocks = orderExpiry - blockNumber

  return tradeBlocks
}

export class BalanceTracker {
  constructor(poolHelper: VaultTwammPoolAPIHelper) {
    this.poolHelper = poolHelper

    this.accountBalances = {}
  }

  saveBalance = async (account: SignerWithAddress) : Promise<void> =>
  {
    const address = account.address

    const results = await Promise.all([
      await getLastBlockNumber(),
      await this.poolHelper.getToken0Contract().balanceOf(address),
      await this.poolHelper.getToken1Contract().balanceOf(address)
    ])

    if (!this.accountBalances.hasOwnProperty(address)) {
      this.accountBalances[address] = []
    }

    this.accountBalances[address].push({
      block: results[0],
      balance: {
        token0: results[1],
        token1: results[2]
      }
    })
  }

  getBalance = (account: SignerWithAddress): HistoricalBalance =>
  {
    const address = account.address

    if (!this.accountBalances.hasOwnProperty(address)) {
      throw new Error(`Balancer Tracker does not contain any data for address ${address}`)
    }

    const balances = this.accountBalances[address]
    if (balances.length === 0) {
      throw new Error(`Balancer Tracker does not yet have balances for address ${address}`)
    }

    return balances[balances.length-1]
  }

  getDiff = (account: SignerWithAddress): TokenPairAmtType =>
  {
    const address = account.address

    if (!this.accountBalances.hasOwnProperty(address)) {
      throw new Error(`Balancer Tracker does not contain any data for address ${address}`)
    }

    const balances = this.accountBalances[address]
    const length = balances.length
    if (length <= 1) {
      throw new Error(`Balancer Tracker does not have sufficient data for historical` +
                      `balance diff of address ${address}`)
    }


    const curr = balances[length - 1].balance
    const prev = balances[length - 2].balance
    return {
      token0: curr.token0.sub(prev.token0),
      token1: curr.token1.sub(prev.token1)
    }
  }

  dumpBalances = (account: SignerWithAddress, tag?: string): void =>
  {
    const _tag = (tag === undefined) ? '' : `(${tag})`
    const { address } = account
    let dump = '\n'
    dump += `Balances for Account ${address} ${_tag}\n`
    dump += '--------------------------------------------------------------------------------\n'

    if (this.accountBalances.hasOwnProperty(address)) {
      const balances = this.accountBalances[address]
      for (const _balance of balances) {
        const {block, balance} = _balance
        dump += `block ${block}:\t\tT0=${balance.token0},\t\tT1=${balance.token1}\n`
      }
    }
    dump += '\n\n'

    log.info(dump)
  }

  private poolHelper: VaultTwammPoolAPIHelper
  private accountBalances: {
    [index: string]: HistoricalBalance []
  }
}

const expectWithinFraction = (actual: Numberish,
                              expected: Numberish,
                              numerator: Numberish,
                              denominator: Numberish): void =>
{
  const _actual = BigNumber.from(actual)
  const _expected = BigNumber.from(expected)
  const _numerator = BigNumber.from(numerator)
  const _denominator = BigNumber.from(denominator)

  const tolerance = (_expected.mul(_numerator)).div(_denominator)

  const absError = _actual.sub(_expected).abs()
  if (absError.gt(tolerance)) {
    const multiple = Number(absError)/Number(tolerance)
    log.info(`Error between actual (${actual}) and expected (${expected}) exceeds tolerance by factor ${multiple}.`)
  }
  expect(actual).to.be.closeTo(expected, tolerance)
}

export const expectWithinMillionths = (actual: Numberish,
                                       expected: Numberish,
                                       millionths: Numberish = 1): void =>
{
  const oneMillion = BigNumber.from(1000000)
  expectWithinFraction(actual, expected, millionths, oneMillion)
}

export const expectWithinBillionths = (actual: Numberish,
                                       expected: Numberish,
                                       billionths: Numberish = 1): void =>
{
  const oneBillion = BigNumber.from(1000000000)
  expectWithinFraction(actual, expected, billionths, oneBillion)
}

export const expectWithinTrillionths = (actual: Numberish,
                                        expected: Numberish,
                                        trillionths: Numberish = 1): void =>
{
  const oneTrillion = BigNumber.from(1_000_000_000_000)
  expectWithinFraction(actual, expected, trillionths, oneTrillion)
}

export type LTSwapTxnIngredients = {
  tradeBlocks: number,
  swapAmt: BigNumber,
  swap: Swap,
  orderId: number,
  salesRate: BigNumber
}

export const sumSwapAmts = (swapTxnIngreds: LTSwapTxnIngredients[]): BigNumber =>
{
  const sum = swapTxnIngreds.reduce(
    (accumulator: BigNumber, currentValue: any) => {
      return accumulator.add(currentValue.swapAmt)
    },
    BigNumber.from(ZERO)
  )

  return sum
}

// Useful for orders that have been extended
//
export const sumSwapAmtsFromOrders = (orderArr: any): { token0: BigNumber, token1: BigNumber } =>
{
  let token0 = ZERO
  let token1 = ZERO

  for (const order of orderArr) {
    let allBlocks = order.orderExpiry.sub(order.orderStart)
    if (order.token0To1) {
      token0 = token0.add(order.salesRate.mul(allBlocks))
    } else {
      token1 = token1.add(order.salesRate.mul(allBlocks))
    }
  }

  return { token0, token1 }
}

export class UnminedTxnBuilder {
  constructor(poolHelper: VaultTwammPoolAPIHelper,
              swapMgr: SwapManager,
              blockInterval: number,
              globalOwner: SignerWithAddress,
              defaultLTSwapOwner: SignerWithAddress,
              defaultLTDelegateOwner: SignerWithAddress)
  {
    this._poolHelper = poolHelper
    this._swapMgr = swapMgr

    this._blockInterval = blockInterval

    this._globalOwner = globalOwner
    this._defaultLTSwapOwner = defaultLTSwapOwner
    this._defaultLTSwapDelegate = defaultLTDelegateOwner
  }

  issueLTSwapExtend = async ( ltSwap: LTSwapTxnIngredients,
                              extendIntervals: number,
                              extendAmt?: BigNumber,
                              sender?: SignerWithAddress ) : Promise<any> =>
  {
    const extendBlocks = this._blockInterval * extendIntervals
    const _extendAmt = (extendAmt !== undefined) ?
                       extendAmt : ltSwap.salesRate.mul(extendBlocks)
    
    const _sender = (sender) ? sender: this._defaultLTSwapOwner

    const direction0To1 = ltSwap.swap.isDirection0To1()
    const extendObjects = (direction0To1) ?
                          await this._poolHelper.getExtendObjects(
                            _extendAmt,
                            ZERO,
                            ltSwap.orderId
                          ) : 
                          await this._poolHelper.getExtendObjects(
                            ZERO,
                            _extendAmt,
                            ltSwap.orderId
                          )

    const vaultContract = this._poolHelper.getVaultContract()
    const tokenContract = (direction0To1) ?
                          this._poolHelper.getToken0Contract() :
                          this._poolHelper.getToken1Contract()

    await tokenContract.connect(this._globalOwner).transfer(_sender.address, _extendAmt);
    await tokenContract.connect(_sender).approve(vaultContract.address, _extendAmt);

    await vaultContract.connect(_sender)
                               .joinPool(
                                 this._poolHelper.getPoolId(),
                                 _sender.address,
                                 _sender.address,
                                 extendObjects.joinStruct
                               )
  }

  issueLTSwap0To1 = async ( intervals: number,
                            salesRate: BigNumber,
                            owner?: SignerWithAddress,
                            delegate?: SignerWithAddress ) : Promise<LTSwapTxnIngredients> =>
  {
    return this.issueLTSwap(intervals,
                            salesRate,
                            true,
                            owner,
                            delegate)
  }
  
  issueLTSwap1To0 = async ( intervals: number,
                            salesRate: BigNumber,
                            owner?: SignerWithAddress,
                            delegate?: SignerWithAddress ) : Promise<LTSwapTxnIngredients> =>
  {
    return this.issueLTSwap(intervals,
                            salesRate,
                            false,
                            owner,
                            delegate)
  }

  issueLTSwap = async( intervals: number,
                       salesRate: BigNumber,
                       token0To1: boolean,
                       owner?: SignerWithAddress,
                       delegate?: SignerWithAddress) : Promise<LTSwapTxnIngredients> =>
  {
    const _owner = (owner) ? owner : this._defaultLTSwapOwner
    const _delegate = (delegate) ? delegate : this._defaultLTSwapDelegate

    const doSwap = false
    const doApprovals = false

    const tradeBlocks = await getNumTradeBlocks(intervals, this._blockInterval, doApprovals)
    const swapAmt = salesRate.mul(tradeBlocks)
    const swap = (token0To1) ?
                 this._swapMgr.newSwap0To1() :
                 this._swapMgr.newSwap1To0()
    const orderId = getNextOrderId()
    {
      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = await swap.longTerm(
        swapAmt,
        intervals,
        _owner,
        doSwap,
        doApprovals,
        _delegate
      )
      const vaultContract = this._poolHelper.getVaultContract()
      const tokenContract = (token0To1) ?
                            this._poolHelper.getToken0Contract() :
                            this._poolHelper.getToken1Contract()
      await tokenContract.connect(this._globalOwner).transfer(_owner.address, swapAmt)
      await tokenContract.connect(_owner).approve(vaultContract.address, swapAmt)
      await vaultContract.connect(_owner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
    }
    swap.setOrderId(orderId)

    return { tradeBlocks, swapAmt, swap, orderId, salesRate }
  }

  private _poolHelper: VaultTwammPoolAPIHelper
  private _swapMgr: SwapManager

  private _blockInterval: number

  private _globalOwner: SignerWithAddress
  private _defaultLTSwapOwner: SignerWithAddress
  private _defaultLTSwapDelegate: SignerWithAddress
}

// Returns 32 byte, left padded hex string corresponding to the provided value. Errors 
// if value is too large to fit within 32 bytes. Returned string DOES NOT include '0x'
// prefix.
//
const ZERO_STR_32_BYTES = "0000000000000000000000000000000000000000000000000000000000000000"
const getHexStrPaddedTo32bytes = (value: bigint): string =>
{
  const valueStr = value.toString(16)
  const end = ZERO_STR_32_BYTES.length-valueStr.length

  if (end < 0) {
    throw new Error(`getHexStrPaddedTo32bytes value (${value}) exceeds 32 bytes.`)
  }

  return ZERO_STR_32_BYTES.slice(0, end) + valueStr
}

// Returns the scaled proceeds of each order pool, 0 and 1, for the given block number and
// contract address on the network of the provided public client.
//
export const getScaledProceedsAtBlock = async(
                                               contractAddress: string,
                                               blockNumber: bigint,
                                               scaledProceedsMapSlotIndex: bigint = 10n
                                             ) : 
                                             Promise<{scaledProceeds0: bigint, scaledProceeds1: bigint}> => 
{
  // The structure this is fetching from within the contract is:
  //
  //    <7 slots in inherited contracts ...>
  //    virtualOrders(Struct)
  //        orderPools(Struct)
  //            currentSalesRates(U256)
  //            scaledProceeds(U256)
  //            salesRatesEndingPerBlock(Mapping...)
  //        scaledProceedsAtBlock(Mapping: uint256 => uint256)     <-- Slot Index 10
  //        ...
  //
  // Consult the documentation here to understand the decoding performed below (version
  // 0.7.6 of solidity is pertinent to the CronFi V1 TWAMM Contracts):
  //
  //    https://docs.soliditylang.org/en/v0.7.6/internals/layout_in_storage.html
  //    https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html
  //
  const k = getHexStrPaddedTo32bytes(blockNumber)
  const p = getHexStrPaddedTo32bytes(scaledProceedsMapSlotIndex)
  const k_concat_p: `0x${string}` = `0x${k.concat(p)}`
  const scaledProceedsAtBlockSlotIndex = BigInt(utils.keccak256(k_concat_p))


  const slotDataHexStr = await getStorageAt(
    contractAddress,
    utils.hexlify(scaledProceedsAtBlockSlotIndex)
  )
    
  // Consult Cron-Finance/twamm/contracts/twault/interfaces/Structs.sol regarding the
  // bit-encoding of scaledProceedsAtBlock, which is being decoded below into two the 
  // two scaled proceeds values:
  //
  const slotData = BigInt(slotDataHexStr)
  return {
    scaledProceeds0: slotData >> 128n,
    scaledProceeds1: slotData & ((2n ** 128n) - 1n)
  }
}
