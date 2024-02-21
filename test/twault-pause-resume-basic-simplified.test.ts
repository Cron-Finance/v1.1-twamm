import { expect } from "chai"

import { ethers, waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers";

import { SwapObjects } from "./helpers/types"
import { clearNextOrderId,
         Swap,
         SwapManager,
         getCurrOrderId,
         getNextOrderId,
         VaultTwammPoolAPIHelper} from "./helpers/vaultTwammPoolAPIHelper"
import { PoolModel } from "./model_v2/vaultTwammPool"
import { dumpOrder,
         expectFailure,
         scaleUp,
         getLastBlockNumber,
         mineBlocks,
         dumpContractAccounting,
         ZERO,
         JSONBI } from "./helpers/misc"      
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-pause-resume-basic-simplified");

// Equal initial liquidity for both token 0 & 1 of 10M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000_000n, TOKEN1_DECIMALS);

const getNumTradeBlocks = async(intervals: number, obi: number): Promise<number> =>
{
  // We add 2 blocks, because the trade executes in the current block (not the 
  // last block) and it occurs from start blocks to end blocks, which adds 1 
  // as well:
  const blockNumber = (await getLastBlockNumber()) + 2

  const lastExpiryBlock = blockNumber - (blockNumber % obi)
  const orderExpiry = obi * (intervals + 1) + lastExpiryBlock
  const tradeBlocks = orderExpiry - blockNumber

  return tradeBlocks
}

describe("TWAULT (TWAMM Balancer Vault) Pause & Resume Basic Simplified Suite", function ()
{
  let globalOwner: SignerWithAddress,
      ltOwner: SignerWithAddress,
      ltDelegate: SignerWithAddress,
      lp: SignerWithAddress,
      admin1: SignerWithAddress,
      admin2: SignerWithAddress,
      partnerBloxRoute: SignerWithAddress,
      partnerX: SignerWithAddress,
      arbitrageur1: SignerWithAddress,
      arbitrageur2: SignerWithAddress,
      arbitrageur3: SignerWithAddress,
      arbitrageur4: SignerWithAddress,
      arbitrageur5: SignerWithAddress,
      feeAddr1: SignerWithAddress,
      feeAddr2: SignerWithAddress,
      addrs: SignerWithAddress[];

  let poolHelper: VaultTwammPoolAPIHelper;
  let swapMgr: SwapManager;

  let poolModel: PoolModel;
    
  // Contracts for testing into local vars:
  let token0AssetContract: any;
  let token1AssetContract: any;
  let balancerVaultContract: any;
  let poolContract: any;
  let arbitrageListContract: any;
  let arbitrageListContract2: any;

  let BLOCK_INTERVAL: number

  const SALES_RATE_T0 = scaleUp(10n, TOKEN0_DECIMALS)
  const SALES_RATE_T1 = scaleUp(10n, TOKEN1_DECIMALS)


  beforeEach(async function () 
  {
    clearNextOrderId()
    await createSnapshot(waffle.provider);
    const result = await deployCommonContracts(PoolType.Stable);
    BLOCK_INTERVAL = result.BLOCK_INTERVAL
    globalOwner = result.owner;
    ltOwner = result.addr1
    ltDelegate = result.addr2
    lp = result.addr3
    admin1 = result.admin1
    admin2 = result.admin2
    partnerBloxRoute = result.partnerBloxRoute
    partnerX = result.partnerX,
    arbitrageur1 = result.arbitrageur1
    arbitrageur2 = result.arbitrageur2
    arbitrageur3 = result.arbitrageur3
    arbitrageur4 = result.arbitrageur4
    arbitrageur5 = result.arbitrageur5
    feeAddr1 = result.feeAddr1
    feeAddr2 = result.feeAddr2
    addrs = result.addrs
    poolHelper = result.poolHelper
    swapMgr = result.swapMgr
    token0AssetContract = result.token0AssetContract
    token1AssetContract = result.token1AssetContract
    balancerVaultContract = result.balancerVaultContract
    poolContract = result.poolContract
    arbitrageListContract = result.arbitrageListContract
    arbitrageListContract2 = result.arbitrageListContract2

    // The admin1 account isn't working properly, you get this error
    // when trying to use it:
    //
    //     "InvalidInputError: unknown account 0xe122eff60083bc550acbf31e7d8197a58d436b39"
    //
    // Thus we use the global owner to add admin2 here (the reason admin1 is broken is
    // that someone added an explicit address assignment that's not in the VM/hardhat in 
    // deployCommonContracts).
    // TODO: Talk to PB about this. (It's likely to do with the hard-wired contract address
    //       for the factory).
    //
    await poolContract.connect(globalOwner).setAdminStatus(admin2.address, true)
    await mineBlocks()


    // Zero fees for simple functionality testing:
    //
    await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
    await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
    await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
    await poolContract.connect(globalOwner).setCollectBalancerFees(false)
    await mineBlocks();

    // Add Liquidity:
    //
    await token0AssetContract.connect(globalOwner).transfer(lp.address, INITIAL_LIQUIDITY_0);
    await token1AssetContract.connect(globalOwner).transfer(lp.address, INITIAL_LIQUIDITY_1);
    let joinObjects = await poolHelper.getJoinObjects( INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1 );
    await token0AssetContract.connect(lp).approve(balancerVaultContract.address, joinObjects.token0Amt);
    await token1AssetContract.connect(lp).approve(balancerVaultContract.address, joinObjects.token1Amt);
    await mineBlocks();

    //
    // Provide initial liquidity:
    await balancerVaultContract.connect(lp).joinPool(
      poolHelper.getPoolId(),
      lp.address,
      lp.address,
      joinObjects.joinStruct
    )
    await mineBlocks();

    // Configure the model:
    poolModel = new PoolModel(PoolType.Stable)
    poolModel.initialMint(lp.address, INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1)
  })


  afterEach(function () {
    restoreSnapshot(waffle.provider);
  })


  // NOTE - UGLY:
  // --------------------------------------------------------------------------------
  // Unfortunately the expect mechanism for reverted with is not working
  // (possibly b/c external functions or something else). Anyway, the code below 
  // uses try/catch to examine failures in the receipts. Unfortunately it cannot 
  // examine the receipt for specific errors (i.e. CFI#008).
  //
  // TODO: When time, figure out why and extend to analyze particular error.
  //

  // NOTE - ALSO UGLY:
  // --------------------------------------------------------------------------------
  // These tests are a copy-pasta extravaganza.
  // This was done because of time constraints (losses due to debugging a generic 
  // seek / confirmation mechanism for executing portions of a test generically)
  //

  describe("LT Order Quantity Tests", function() {
    it ("should handle a 1 block pause in the issuing block (0->1, owner withdraw) [PR-SS-001]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, confirm, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the issuing block (0->1, owner withdraw at expiry block + 1) [PR-SS-002]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block plus 1').to.eq(orderInfo.orderExpiry.add(1))

      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the issuing block (0->1, delegate withdraw) [PR-SS-003]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the issuing block (1->0, owner withdraw) [PR-SS-004]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)

      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the issuing block (1->0, delegate withdraw) [PR-SS-005]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)

      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })


    it ("should handle a 2 block pause in the issuing block (0->1, owner withdraw) [PR-SS-006]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(2)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(2)
      expect(balChange.T0, 'Should get 2 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 2 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 2)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 2} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused blocks:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 2))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 2))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 2 block pause in the issuing block (0->1, owner withdraw at expiry block + 10) [PR-SS-007]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(2)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber + 9
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry.add(10))
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(2)
      expect(balChange.T0, 'Should get 2 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 2 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 2)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 2} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused blocks:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 2))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 2))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 2 block pause in the issuing block (0->1, delegate withdraw) [PR-SS-008]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(2)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(2)
      expect(balChange.T0, 'Should get 2 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 2 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 2)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 2} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused blocks:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 2))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 2))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 2 block pause in the issuing block (1->0, owner withdraw) [PR-SS-009]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(2)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)

      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1.mul(2)
      expect(balChange.T1, 'Should get 2 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 2 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 2)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 2} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 2))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 2))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 2 block pause in the issuing block (1->0, delegate withdraw) [PR-SS-010]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(2)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry, plus one block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)

      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1.mul(2)
      expect(balChange.T1, 'Should get 2 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 2 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 2)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 2} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 2))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 2))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause half way through (0->1, owner withdraw) [PR-SS-011]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause half way through (0->1, delegate withdraw) [PR-SS-012]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)

      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause half way through (1->0, owner withdraw) [PR-SS-013]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)

      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause half way through (1->0, delegate withdraw) [PR-SS-014]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause half way through (1->0, delegate withdraw at expiry block + 5) [PR-SS-015]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)

      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber + 4
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry.add(5))
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId, ltDelegate, ltOwner)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T0 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the last block (0->1, owner withdraw) [PR-SS-016]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last block of the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltOwner).exitPool(
        poolHelper.getPoolId(),
        ltOwner.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the last block (0->1, delegate withdraw) [PR-SS-017]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last block of the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltDelegate).exitPool(
        poolHelper.getPoolId(),
        ltDelegate.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the last block (1->0, owner withdraw) [PR-SS-018]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last block of the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltOwner).exitPool(
        poolHelper.getPoolId(),
        ltOwner.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the last block (1->0, delegate withdraw) [PR-SS-019]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last block of the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltDelegate).exitPool(
        poolHelper.getPoolId(),
        ltDelegate.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the last block (1->0, delegate withdraw at expiry block + OBI) [PR-SS-020]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last block of the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Confirm this is the expiry block
      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)
      
      await mineBlocks()

      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Mine to the expiry block plus OBI blocks:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = (orderInfo.orderExpiry.add(BLOCK_INTERVAL)) - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry.add(BLOCK_INTERVAL))

      // In the order expiry block plus OBI blocks:
      //   - Get previous balances to confirm amounts
      //   - Withdraw the order
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - 1)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(tradeBlocks - 1))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(tradeBlocks - 1))

      const fiveTenThousandthsSlip = (SALES_RATE_T1.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause at order start (0->1, owner withdraw at expiry block to delegate) [PR-SS-021]", async function() {
   
      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks(10)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock).to.eq(orderInfo.orderStart.add(10))

      // Mine to the order expiry, confirm, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltDelegate.address),
        T1: await token1AssetContract.balanceOf(ltDelegate.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltDelegate
      )
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltDelegate.address),
        T1: await token1AssetContract.balanceOf(ltDelegate.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(10)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - 10)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - 10))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - 10))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 11 block pause at order start (0->1, owner withdraw at expiry block) [PR-SS-022]", async function() {
   
      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      const pauseBlocks = 11
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock).to.eq(orderInfo.orderStart.add(pauseBlocks))

      // Mine to the order expiry, confirm, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause half way through the order (0->1, owner withdraw at expiry block) [PR-SS-023]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      const pauseBlocks = 10
      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause half way through the order (0->1, delegate withdraw at expiry block) [PR-SS-024]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      const pauseBlocks = 10
      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - 1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause half way through the order (1->0, owner withdraw at expiry block) [PR-SS-025]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      const pauseBlocks = 10
      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1.mul(pauseBlocks)
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause half way through the order (1->0, delegate withdraw at expiry block) [PR-SS-026]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T1.mul(tradeBlocks)
      const swap = swapMgr.newSwap1To0()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause 1/2 way through the order:
      //
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = Math.floor((orderInfo.orderExpiry - blockNumber) / 2) - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(orderInfo.orderExpiry.sub(blocksToMine), 1)

      const pauseBlocks = 10
      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Mine to the order expiry and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner 
      )
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T1.mul(pauseBlocks)
      expect(balChange.T1, 'Should get 1 sales rate of T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${tradeBlocks - 1} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, fiveTenThousandthsSlip)
    })

    it ("should handle a 10 block pause in the last 10 blocks (0->1, owner withdraw) [PR-SS-027]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause in the last ten blocks of the order:
      //
      const pauseBlocks = 10
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - pauseBlocks - 1
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last ten blocks').to.eq(orderInfo.orderExpiry.sub(pauseBlocks))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks(pauseBlocks)

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltOwner).exitPool(
        poolHelper.getPoolId(),
        ltOwner.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - pauseBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the first and last block (0->1, owner withdraw) [PR-SS-028]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )
      
      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      await mineBlocks()

      // Pause in the last block of the order:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      let blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      let blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltOwner).exitPool(
        poolHelper.getPoolId(),
        ltOwner.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const pauseBlocks = 2
      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - pauseBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle a 1 block pause in the first, middle, and last block (0->1, owner withdraw) [PR-SS-029]", async function() {

      // Issue an order:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )
      
      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      await mineBlocks()

      // Pause 1/2 way through the order:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      const middleBlock = Math.floor(orderInfo.orderStart.add((orderInfo.orderExpiry.sub(orderInfo.orderStart)).div(2)))
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = middleBlock - blockNumber - 1
      await mineBlocks(blocksToMine)
      
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block')
            .to.be.closeTo(middleBlock, 1)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Resume the order in the next block:
      //
      await poolContract.connect(ltOwner).resumeOrder(orderId)


      // Pause in the last block of the order:
      //
      blockNumber = await getLastBlockNumber()
      // Note: We subtract 2 to mine from the current block (which is 1 + getLastBlockNumber)
      //       to the block right before expiry.  If it were subtracing 1, we would mine 
      //       right into the expiry block.
      blocksToMine = orderInfo.orderExpiry - blockNumber - 2
      await mineBlocks(blocksToMine)
      
      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be the order\'s last block').to.eq(orderInfo.orderExpiry.sub(1))
      
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should NOT be paused').to.eq(false)

      await poolContract.connect(ltOwner).pauseOrder(orderId)
      await mineBlocks()

      // Check to see if the order is paused:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // In the final block:
      //   - Get previous balances to confirm amounts
      //   - Attempt to resume the order (and catch the expected failure)
      //   - Withdraw the order
      //   - Confirm this is the expiry block
      //
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      const txn = await poolContract.connect(ltOwner).resumeOrder(orderId)
      
      const exitRequest = await swap.withdrawLongTerm(
        orderId,
        ltOwner,
        ltOwner,
        false // doWithdraw
      )
      const vaultContract = poolHelper.getVaultContract()
      await vaultContract.connect(ltOwner).exitPool(
        poolHelper.getPoolId(),
        ltOwner.address,
        ltOwner.address,
        exitRequest
      )

      blockNumber = await getLastBlockNumber() + 1
      expect(blockNumber, 'This block should be order expiry')
            .to.eq(orderInfo.orderExpiry)

      await mineBlocks()

      // Catch the expected failure:
      //
      expectFailure(txn, 'Should not resume an expired order', 'CFI#229')

      // Check amounts received:
      //
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const pauseBlocks = 3
      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, 'Should get 1 sales rate of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${tradeBlocks - pauseBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })
    
    it ("should handle pausing the whole order (0->1, owner withdraw) [PR-SS-030]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Check to see if the order is paused:
      //
      const orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      // Mine to the order expiry, confirm, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      const currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(tradeBlocks)
      expect(balChange.T0, 'Should get entire deposit of T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = ZERO
      expect(balChange.T1, `Should get 0 sales rates of T1 proceeds`) .to.eq(expectedProceeds)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })
    
    it ("should handle pausing all but the first block (0->1, owner withdraw) [PR-SS-031]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const orderId = swap.getOrderId()

      // Now pause the order:
      //
      let currBlock = await getLastBlockNumber() + 1
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(currBlock, 'Should be 2nd order block').to.eq(orderInfo.orderStart.add(1))
      
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Mine to the order expiry, confirm paused and block, and withdraw:
      //
      const blockNumber = await getLastBlockNumber()
      const blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(tradeBlocks - 1)
      expect(balChange.T0, `Should get ${tradeBlocks - 1} sales rate of T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0)
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0)

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle pausing after the 1st half of the order (0->1, owner withdraw) [PR-SS-032]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const orderId = swap.getOrderId()

      // Mine half way through the order:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      const middleBlock = Math.floor(orderInfo.orderStart.add((orderInfo.orderExpiry.sub(orderInfo.orderStart)).div(2)))
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = middleBlock - blockNumber - 1
      await mineBlocks(blocksToMine)

      // Confirm we're in the middle of the order and then pause it:
      //
      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block').be.eq(middleBlock)
      
      await poolContract.connect(ltOwner).pauseOrder(orderId)
      const pauseBlocks = orderInfo.orderExpiry.sub(currBlock)

      // Mine to the order expiry, confirm paused and block, and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, `Should get ${pauseBlocks} sales rate of T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle being paused the 1st half of the order (0->1, owner withdraw) [PR-SS-033]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        false,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
      await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      
      const orderId = getNextOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Mine half way through the order:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      const middleBlock = Math.floor(orderInfo.orderStart.add((orderInfo.orderExpiry.sub(orderInfo.orderStart)).div(2)))
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = middleBlock - blockNumber - 1
      await mineBlocks(blocksToMine)

      // Confirm we're in the middle of the order and that it's paused, then resume it:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block').be.eq(middleBlock)
      
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      const pauseBlocks = currBlock - orderInfo.orderStart

      // Mine to the order expiry, confirm NOT paused, expiry block, and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should NOT be paused').to.eq(false)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, `Should get ${pauseBlocks} sales rate of T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })

    it ("should handle being paused the 1st half of the order after block 1 (0->1, owner withdraw) [PR-SS-034]", async function() {

      // Issue an order and pause it IN THE SAME BLOCK:
      //
      const intervals = 1
      const tradeBlocks = await getNumTradeBlocks(intervals, BLOCK_INTERVAL)
      const swapAmt = SALES_RATE_T0.mul(tradeBlocks)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )

      // Pause the order after the initial block:
      //
      const orderId = swap.getOrderId()
      swap.setOrderId(orderId)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      await mineBlocks()

      // Mine half way through the order:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      const middleBlock = Math.floor(orderInfo.orderStart.add((orderInfo.orderExpiry.sub(orderInfo.orderStart)).div(2)))
      let blockNumber = await getLastBlockNumber()
      let blocksToMine = middleBlock - blockNumber - 1
      await mineBlocks(blocksToMine)

      // Confirm we're in the middle of the order and that it's paused, then resume it:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should be paused').to.eq(true)

      let currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be close to 1/2 way to expiry block').be.eq(middleBlock)
      
      await poolContract.connect(ltOwner).resumeOrder(orderId)
      const pauseBlocks = currBlock - (orderInfo.orderStart.add(1))

      // Mine to the order expiry, confirm NOT paused, expiry block, and withdraw:
      //
      blockNumber = await getLastBlockNumber()
      blocksToMine = orderInfo.orderExpiry - blockNumber - 1
      await mineBlocks(blocksToMine)

      orderInfo = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfo.paused, 'Order should NOT be paused').to.eq(false)

      currBlock = await getLastBlockNumber() + 1
      expect(currBlock, 'Should be expiry block').to.eq(orderInfo.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(orderId)
      const balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      const balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      const expectedRefund = SALES_RATE_T0.mul(pauseBlocks)
      expect(balChange.T0, `Should get ${pauseBlocks} sales rate of T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(tradeBlocks - pauseBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${1} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      const orders = await poolContract.getOrderAmounts()
      const proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(tradeBlocks - pauseBlocks))

      const fiveTenThousandthsSlip = (SALES_RATE_T0.mul(5)).div(10000)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, fiveTenThousandthsSlip)
    })
  })
})
