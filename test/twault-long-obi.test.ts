import { expect } from "chai"

import { ethers, waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import { BigNumber, utils } from "ethers";

import { SwapObjects,
         TokenPairAmtType,
         HistoricalBalance } from "./helpers/types"
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
         getCurrentBlockNumber,
         seekToBlock,
         mineBlocks,
         dumpContractAccounting,
         ZERO,
         JSONBI,
         getNumTradeBlocks,
         BalanceTracker,
         expectWithinMillionths,
         expectWithinBillionths,
         expectWithinTrillionths,
         LTSwapTxnIngredients,
         sumSwapAmts,
         sumSwapAmtsFromOrders,
         UnminedTxnBuilder,
         getScaledProceedsAtBlock } from "./helpers/misc"
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { CronV1PoolExposed } from "typechain/contracts/twault/exposed/CronV1PoolExposed";
import { CronV1PoolFactoryExposed } from "typechain/contracts/twault/exposed/CronV1PoolFactoryExposed";

import { deployCommonContracts } from './common';

// IMPORTANT: The tests in this file are described/designed in a draw.io (PauseResumeExtend.drawio)

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-long-obi");

// Equal initial liquidity for both token 0 & 1 of 10M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;

const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000_000n, TOKEN1_DECIMALS);

const SALES_RATE_T0 = scaleUp(10n, TOKEN0_DECIMALS)
const SALES_RATE_T1 = scaleUp(10n, TOKEN1_DECIMALS)



describe("TWAULT (TWAMM Balancer Vault) Long OBI Suite", function ()
{
  let globalOwner: SignerWithAddress,
      ltOwner: SignerWithAddress,
      ltDelegate: SignerWithAddress,
      shortTermSam: SignerWithAddress,
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
  let poolContract: CronV1PoolExposed;
  let arbitrageListContract: any;
  let arbitrageListContract2: any;
  let balTwammFactoryContract: CronV1PoolFactoryExposed;

  let BLOCK_INTERVAL: number


  beforeEach(async function () 
  {
    clearNextOrderId()
    await createSnapshot(waffle.provider);
    const result = await deployCommonContracts(PoolType.Daily);
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
    shortTermSam = result.arbitrageur5
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
    balTwammFactoryContract = result.balTwammFactoryContract

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
//    await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
//    await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
//    await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
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
    poolModel = new PoolModel(PoolType.Daily)
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

  describe("Daily OBI Basic Tests", function() {
    const dailyOrderIntervalBlocks = 7200
    const maxOrderIntervals = 1825

    it ("should allow setting daily OBI on instantiation [OBI-T-001]", async function() {
      // Check the order intervals set in the pool and max order intervals:
      //
      expect(BLOCK_INTERVAL).to.eq(dailyOrderIntervalBlocks)

      const poolOBI = await poolContract.getOrderInterval()
      expect(poolOBI).to.eq(dailyOrderIntervalBlocks)

      const poolMOI = await poolContract.getMaxOrderIntervals()
      expect(maxOrderIntervals).to.eq(poolMOI)

      // Check that the rates are initialized correctly:
      //
      expect(await poolContract.getShortTermFeePoints()).to.eq(10)
      expect(await poolContract.getPartnerFeePoints()).to.eq(5)
      expect(await poolContract.getLongTermFeePoints()).to.eq(30)
    })

    it ("executes virtual orders in LT trades on block interval boundaries (0->1) [OBI-T-002]", async function() {
      // NOTE: This test will break if the virtual orders loop writing data un-necessarily is changed
      //       to be more optimal.
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 3 intervals (4 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Mine to one block after the second interval and check values and state 
      // written (should all be zero):
      //
      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)
      const thirdInterval = orderExpiry - dailyOrderIntervalBlocks
      const secondInterval = thirdInterval - dailyOrderIntervalBlocks
      const firstInterval = secondInterval - dailyOrderIntervalBlocks
      
      await seekToBlock(secondInterval+1)

      // Check proceeds at interval blocks before current block:
      //
      const poolAddress = poolContract.address
      let proceedsAtFirstInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(firstInterval))
      let proceedsAtSecondInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(secondInterval))
      let proceedsAtThirdInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(thirdInterval))

      expect(proceedsAtFirstInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtFirstInterval.scaledProceeds1).to.eq(ZERO)

      expect(proceedsAtSecondInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtSecondInterval.scaledProceeds1).to.eq(ZERO)

      expect(proceedsAtThirdInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtThirdInterval.scaledProceeds1).to.eq(ZERO)
      
      // Check orders & proceeds math:
      //
      const ltOrders0To1 = [ltTradeA]
      let sumOrders0To1 = sumSwapAmts(ltOrders0To1)
      let sumOrders1To0 = ZERO

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Execute virtual orders at the current block. Check values and state 
      // written:
      //
      await poolContract.connect(ltOwner).executeVirtualOrdersToBlock(secondInterval+1)
      await mineBlocks()

      const orderPoolScaling0 = 10n**(BigInt(TOKEN0_DECIMALS) + 1n)

      // Check proceeds at interval blocks:
      //

      // First Interval:
      let k = INITIAL_LIQUIDITY_0.mul(INITIAL_LIQUIDITY_1)
      const saleFirstIval = ltTradeA.salesRate.mul(firstInterval - orderStart)
      let reserve0 = INITIAL_LIQUIDITY_0.add(saleFirstIval)
      const procFirstIval = INITIAL_LIQUIDITY_1.sub(k.div(reserve0))
      let reserve1 = INITIAL_LIQUIDITY_1.sub(procFirstIval)
      const scaledProcFirstIval = procFirstIval.mul(orderPoolScaling0)
                                               .div(ltTradeA.salesRate)
      
      proceedsAtFirstInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(firstInterval))
      expect(proceedsAtFirstInterval.scaledProceeds0).to.be.closeTo(scaledProcFirstIval, 1)
      expect(proceedsAtFirstInterval.scaledProceeds1).to.eq(ZERO)

      // Second Interval:
      const saleSecondIval = ltTradeA.salesRate.mul(secondInterval - firstInterval)
      reserve0 = reserve0.add(saleSecondIval)
      const procSecondIval = reserve1.sub(k.div(reserve0))
      reserve1 = reserve1.sub(procSecondIval)
      const scaledProcSecondIval = procFirstIval
                                   .add(procSecondIval.mul(orderPoolScaling0)
                                                      .div(ltTradeA.salesRate))
      
      proceedsAtSecondInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(secondInterval))
      expect(proceedsAtSecondInterval.scaledProceeds0).to.be.closeTo(scaledProcSecondIval, 2)
      expect(proceedsAtSecondInterval.scaledProceeds1).to.eq(ZERO)
      
      // Check orders & proceeds math:
      //
      const expectOrdersT0 = ltTradeA.salesRate.mul(orderExpiry - (secondInterval+1))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectOrdersT0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const t0Sales = ltTradeA.salesRate.mul((secondInterval+1) - orderStart)
      const expectProceedsT1 = INITIAL_LIQUIDITY_1.sub(k.div(INITIAL_LIQUIDITY_0.add(t0Sales)))
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectProceedsT1, 3)
    })

    it ("executes virtual orders in LT trades on block interval boundaries (1->0) [OBI-T-003]", async function() {
      // NOTE: This test will break if the virtual orders loop writing data un-necessarily is changed
      //       to be more optimal.
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 3 intervals (4 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Mine to one block after the second interval and check values and state 
      // written (should all be zero):
      //
      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)
      const thirdInterval = orderExpiry - dailyOrderIntervalBlocks
      const secondInterval = thirdInterval - dailyOrderIntervalBlocks
      const firstInterval = secondInterval - dailyOrderIntervalBlocks
      
      await seekToBlock(secondInterval+1)

      // Check proceeds at interval blocks before current block:
      //
      const poolAddress = poolContract.address
      let proceedsAtFirstInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(firstInterval))
      let proceedsAtSecondInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(secondInterval))
      let proceedsAtThirdInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(thirdInterval))

      expect(proceedsAtFirstInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtFirstInterval.scaledProceeds1).to.eq(ZERO)

      expect(proceedsAtSecondInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtSecondInterval.scaledProceeds1).to.eq(ZERO)

      expect(proceedsAtThirdInterval.scaledProceeds0).to.eq(ZERO)
      expect(proceedsAtThirdInterval.scaledProceeds1).to.eq(ZERO)
      
      // Check orders & proceeds math:
      //
      const ltOrders1To0 = [ltTradeA]
      let sumOrders1To0= sumSwapAmts(ltOrders1To0)
      let sumOrders0To1 = ZERO

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Execute virtual orders at the current block. Check values and state 
      // written:
      //
      await poolContract.connect(ltOwner).executeVirtualOrdersToBlock(secondInterval+1)
      await mineBlocks()

      const orderPoolScaling1 = 10n**(BigInt(TOKEN1_DECIMALS) + 1n)

      // Check proceeds at interval blocks:
      //

      // First Interval:
      let k = INITIAL_LIQUIDITY_0.mul(INITIAL_LIQUIDITY_1)
      const saleFirstIval = ltTradeA.salesRate.mul(firstInterval - orderStart)
      let reserve1 = INITIAL_LIQUIDITY_1.add(saleFirstIval)
      const procFirstIval = INITIAL_LIQUIDITY_0.sub(k.div(reserve1))
      let reserve0 = INITIAL_LIQUIDITY_0.sub(procFirstIval)
      const scaledProcFirstIval = procFirstIval.mul(orderPoolScaling1)
                                               .div(ltTradeA.salesRate)
      
      proceedsAtFirstInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(firstInterval))
      expect(proceedsAtFirstInterval.scaledProceeds1).to.be.closeTo(scaledProcFirstIval, 1)
      expect(proceedsAtFirstInterval.scaledProceeds0).to.eq(ZERO)

      // Second Interval:
      const saleSecondIval = ltTradeA.salesRate.mul(secondInterval - firstInterval)
      reserve1 = reserve1.add(saleSecondIval)
      const procSecondIval = reserve0.sub(k.div(reserve1))
      reserve0 = reserve0.sub(procSecondIval)
      const scaledProcSecondIval = procFirstIval
                                   .add(procSecondIval.mul(orderPoolScaling1)
                                                      .div(ltTradeA.salesRate))
      
      proceedsAtSecondInterval = await getScaledProceedsAtBlock(poolAddress, BigInt(secondInterval))
      expect(proceedsAtSecondInterval.scaledProceeds1).to.be.closeTo(scaledProcSecondIval, 2)
      expect(proceedsAtSecondInterval.scaledProceeds0).to.eq(ZERO)
      
      // Check orders & proceeds math:
      //
      const expectOrdersT1 = ltTradeA.salesRate.mul(orderExpiry - (secondInterval+1))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(expectOrdersT1)
      expect(orders.orders0U112).to.eq(ZERO)
      
      const t1Sales = ltTradeA.salesRate.mul((secondInterval+1) - orderStart)
      const expectProceedsT0 = INITIAL_LIQUIDITY_0.sub(k.div(INITIAL_LIQUIDITY_1.add(t1Sales)))
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectProceedsT0, 3)
    })

    it ("Extends an LT order from supplied capital (0->1) [OBI-T-004]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = orderInfoA.orderStart
      const origOrderExpiry = orderInfoA.orderExpiry

      // Check pool accounting:
      //
      let sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders.token0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
      let vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Mine to one block before expiry and extend the order one interval.
      // Check order and pool accounting:
      //
      await seekToBlock(Number(origOrderExpiry) - 1)

      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check order expiry:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(BLOCK_INTERVAL))
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(dailyOrderIntervalBlocks))

      // Check pool accounting (extend does not run an evo):
      //
      const origSumOrders = sumOrders
      sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      expect(sumOrders.token0).to.eq(origSumOrders.token0.add(ltTradeA.salesRate.mul(BLOCK_INTERVAL)))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders.token0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
    })

    it ("Extends an LT order from supplied/paused capital (0->1) [OBI-T-005]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = orderInfoA.orderStart
      const origOrderExpiry = orderInfoA.orderExpiry

      // Check pool accounting:
      //
      let sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders.token0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
      let vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order for 1/2 a block interval at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      // Check that the deposit and proceeds accumulated are correct:
      //
      let activeBlocksA = 100 - Number(orderStart)
      let allActiveBlocksA = activeBlocksA
      let totalBlocksA = Number(orderInfoA.orderExpiry.sub(orderStart))
      let inactiveBlocksA = totalBlocksA - allActiveBlocksA

      let expectedDepositA = ltTradeA.salesRate.mul(inactiveBlocksA)
      let expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.deposit).to.eq(expectedDepositA)
      expectWithinMillionths(orderInfoA.proceeds, expectedProceedsA)

      await seekToBlock(100 + (BLOCK_INTERVAL / 2))
      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      // Check that the deposit accumulated is half an interval at the sales rate:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      const halfIntervalSales = ltTradeA.salesRate.mul(BLOCK_INTERVAL / 2)
      expect(orderInfoA.deposit).to.eq(halfIntervalSales)
      expectWithinMillionths(orderInfoA.proceeds, expectedProceedsA)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend the order one interval using the funds accumulated during the 
      // pause and added funds. Check order and pool accounting:
      //
      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals, halfIntervalSales)
      await mineBlocks()
      
      // Check order expiry and that accumulated deposit is gone:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(BLOCK_INTERVAL))
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(dailyOrderIntervalBlocks))
      expect(orderInfoA.deposit).to.eq(ZERO)

      // Check pool accounting (extend does not run an evo):
      //
      // NOTE: sumOrders is misleading here b/c it counts BLOCK_INTERVAL/2 blocks that 
      //       were paused and then redeposited as liquidity:
      const origSumOrders = sumOrders
      sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      expect(sumOrders.token0).to.eq(origSumOrders.token0.add(ltTradeA.salesRate.mul(BLOCK_INTERVAL)))

      // The orders should now reflect the original capital provided by the 
      // trader plus 1/2 an order interval of capital. You can't just compute 
      // this using active and inactive blocks because that will make it appear
      // as though their should be more capital in the system. Hence the following
      // accounting:
      const resumeBlockA = 100 + (BLOCK_INTERVAL / 2)
      const remainingOrderBlocksA = orderInfoA.orderExpiry.sub(resumeBlockA)
      const expectedOrdersT0 = ltTradeA.salesRate.mul(remainingOrderBlocksA)

      // Calculated a second way:
      totalBlocksA = Number(orderInfoA.orderExpiry.sub(orderStart))
      activeBlocksA = 0
      allActiveBlocksA = activeBlocksA +
                         (100 - Number(orderStart))
      const nonDepositBlocksA = (100 + (BLOCK_INTERVAL / 2)) - 100
      const depositInactiveBlocksA = totalBlocksA - allActiveBlocksA - nonDepositBlocksA
      const expectedOrdersT0_ = ltTradeA.salesRate.mul(depositInactiveBlocksA)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders0U112).to.eq(expectedOrdersT0_)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const expectedProceedsT1 = ltTradeA.salesRate.mul(100 - Number(orderStart))
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      // Account for the 1/2 a block interval that was paused and then re-dposited:
      const actualOrderDepositT0 = sumOrders.token0.sub(ltTradeA.salesRate.mul(BLOCK_INTERVAL / 2))

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(actualOrderDepositT0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
    })

    it ("Extends an LT order from supplied capital (1->0) [OBI-T-006]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = orderInfoA.orderStart
      const origOrderExpiry = orderInfoA.orderExpiry

      // Check pool accounting:
      //
      let sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(sumOrders.token1)
      expect(orders.orders0U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      let vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Mine to one block before expiry and extend the order one interval.
      // Check order and pool accounting:
      //
      await seekToBlock(Number(origOrderExpiry) - 1)

      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check order expiry:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(BLOCK_INTERVAL))
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(dailyOrderIntervalBlocks))

      // Check pool accounting (extend does not run an evo):
      //
      const origSumOrders = sumOrders
      sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      expect(sumOrders.token1).to.eq(origSumOrders.token1.add(ltTradeA.salesRate.mul(BLOCK_INTERVAL)))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(sumOrders.token1)
      expect(orders.orders0U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
    })

    it ("Extends an LT order from supplied/paused capital (1->0) [OBI-T-007]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      // Zero fees to make the math easier to match:
      //
      await poolContract.connect(admin2).setParameter(ParamType.SwapFeeBP, 0)   // Short term fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.PartnerFeeBP, 0)   // Partner fee --> 0%
      await poolContract.connect(admin2).setParameter(ParamType.LongSwapFeeBP, 0)   // Long term fee --> 0%
      await mineBlocks();
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 3
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      const orderStart = orderInfoA.orderStart
      const origOrderExpiry = orderInfoA.orderExpiry

      // Check pool accounting:
      //
      let sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(sumOrders.token1)
      expect(orders.orders0U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      let vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order for 1/2 a block interval at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      // Check that the deposit and proceeds accumulated are correct:
      //
      let activeBlocksA = 100 - Number(orderStart)
      let allActiveBlocksA = activeBlocksA
      let totalBlocksA = Number(orderInfoA.orderExpiry.sub(orderStart))
      let inactiveBlocksA = totalBlocksA - allActiveBlocksA

      let expectedDepositA = ltTradeA.salesRate.mul(inactiveBlocksA)
      let expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.deposit).to.eq(expectedDepositA)
      expectWithinMillionths(orderInfoA.proceeds, expectedProceedsA)

      await seekToBlock(100 + (BLOCK_INTERVAL / 2))
      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      // Check that the deposit accumulated is half an interval at the sales rate:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      const halfIntervalSales = ltTradeA.salesRate.mul(BLOCK_INTERVAL / 2)
      expect(orderInfoA.deposit).to.eq(halfIntervalSales)
      expectWithinMillionths(orderInfoA.proceeds, expectedProceedsA)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend the order one interval using the funds accumulated during the 
      // pause and added funds. Check order and pool accounting:
      //
      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals, halfIntervalSales)
      await mineBlocks()
      
      // Check order expiry and that accumulated deposit is gone:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(BLOCK_INTERVAL))
      expect(orderInfoA.orderExpiry).to.eq(origOrderExpiry.add(dailyOrderIntervalBlocks))
      expect(orderInfoA.deposit).to.eq(ZERO)

      // Check pool accounting (extend does not run an evo):
      //
      // NOTE: sumOrders is misleading here b/c it counts BLOCK_INTERVAL/2 blocks that 
      //       were paused and then redeposited as liquidity:
      const origSumOrders = sumOrders
      sumOrders = await sumSwapAmtsFromOrders([orderInfoA])

      expect(sumOrders.token1).to.eq(origSumOrders.token1.add(ltTradeA.salesRate.mul(BLOCK_INTERVAL)))

      // The orders should now reflect the original capital provided by the 
      // trader plus 1/2 an order interval of capital. You can't just compute 
      // this using active and inactive blocks because that will make it appear
      // as though their should be more capital in the system. Hence the following
      // accounting:
      const resumeBlockA = 100 + (BLOCK_INTERVAL / 2)
      const remainingOrderBlocksA = orderInfoA.orderExpiry.sub(resumeBlockA)
      const expectedOrdersT1 = ltTradeA.salesRate.mul(remainingOrderBlocksA)

      // Calculated a second way:
      totalBlocksA = Number(orderInfoA.orderExpiry.sub(orderStart))
      activeBlocksA = 0
      allActiveBlocksA = activeBlocksA +
                         (100 - Number(orderStart))
      const nonDepositBlocksA = (100 + (BLOCK_INTERVAL / 2)) - 100
      const depositInactiveBlocksA = totalBlocksA - allActiveBlocksA - nonDepositBlocksA
      const expectedOrdersT1_ = ltTradeA.salesRate.mul(depositInactiveBlocksA)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      expect(orders.orders1U112).to.eq(expectedOrdersT1_)
      expect(orders.orders0U112).to.eq(ZERO)
      
      const expectedProceedsT0 = ltTradeA.salesRate.mul(100 - Number(orderStart))
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      
      // Account for the 1/2 a block interval that was paused and then re-dposited:
      const actualOrderDepositT1 = sumOrders.token1.sub(ltTradeA.salesRate.mul(BLOCK_INTERVAL / 2))

      expectedVaultResT0 = INITIAL_LIQUIDITY_0
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(actualOrderDepositT1)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
    })
    
    it ("Shouldn't allow orders beyond the max length [OBI-T-008]", async function() {
      const intervals = 1826

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue a 0->1 order that is too long:
      //
      const swapAmtT0 = SALES_RATE_T0.mul(intervals*BLOCK_INTERVAL)
      
      {
        const swap = swapMgr.newSwap0To1()
        const swapObjects = await swap.longTerm(
          swapAmtT0,
          intervals,
          ltOwner,
          false,   /* doSwap */
          true,   /* doApprovals */
          ltDelegate
        )
        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
        await expect( balancerVaultContract.connect(ltOwner)
                                           .swap(
                                             swapStruct,
                                             fundStruct,
                                             limitOutAmt,
                                             deadlineSec
                                           )
                    ).to.be.revertedWith('CFI#223')
      }

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue a 1->0 order that is too long:
      //
      const swapAmtT1 = SALES_RATE_T1.mul(intervals*BLOCK_INTERVAL)

      {
        const swap = swapMgr.newSwap1To0()
        const swapObjects = await swap.longTerm(
          swapAmtT1,
          intervals,
          ltOwner,
          false,   /* doSwap */
          true,   /* doApprovals */
          ltDelegate
        )
        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjects
        await expect( balancerVaultContract.connect(ltOwner)
                                           .swap(
                                             swapStruct,
                                             fundStruct,
                                             limitOutAmt,
                                             deadlineSec
                                           )
                    ).to.be.revertedWith('CFI#223')
      }
    })
  })
})
