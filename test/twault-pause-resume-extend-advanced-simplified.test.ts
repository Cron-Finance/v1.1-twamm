import { expect } from "chai"

import { ethers, waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers";

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
         UnminedTxnBuilder } from "./helpers/misc"
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// IMPORTANT: The tests in this file are described/designed in a draw.io (PauseResumeExtend.drawio)

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-pause-resume-extend-advanced-simplified");

// Equal initial liquidity for both token 0 & 1 of 10M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;

const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000_000n, TOKEN1_DECIMALS);

const SALES_RATE_T0 = scaleUp(10n, TOKEN0_DECIMALS)
const SALES_RATE_T1 = scaleUp(10n, TOKEN1_DECIMALS)


// NOTE:  Focus of this suite is concurrent orders that have been
//        paused/resumed/cancelled/withdrawn to ensure there are no
//        side-effects introduced by new extend/pause/resume functionality.
//

describe("TWAULT (TWAMM Balancer Vault) Pause, Resume, & Extend Advanced Simplified Suite", function ()
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
  let poolContract: any;
  let arbitrageListContract: any;
  let arbitrageListContract2: any;

  let BLOCK_INTERVAL: number


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

  describe("LT Order Pause / Resume Advanced Quantity Tests", function() {
    it ("should allow variations of pause-extend-resume for multiple opposing orders [PRE-AT-001A]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue four orders in the same block:
      //
      const intervals = 2
      
      // 0->1 Orders:
      //
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltTradeB = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltOrders0To1 = [ltTradeA, ltTradeB]

      // 1->0 Orders:
      //
      const ltTradeC = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltTradeD = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltOrders1To0 = [ltTradeC, ltTradeD]

      const allOrders = [...ltOrders0To1, ...ltOrders1To0]

      await mineBlocks()

      const orderStart = await getLastBlockNumber()
      
      // Check the pool accounting:
      //
      let sumOrders0To1 = sumSwapAmts(ltOrders0To1)
      let sumOrders1To0 = sumSwapAmts(ltOrders1To0)

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A 1 interval at block 15
      //
      await seekToBlock(15)
      
      // Capture prev order data:
      //
      let orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()

      // Check orders expiries:
      //
      let orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      let totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      let totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      sumOrders0To1 = sumOrders0To1.add(SALES_RATE_T0.mul(extendIntervals*BLOCK_INTERVAL))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // Order is balanced at this point; no net change:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order C at block 20
      //
      await seekToBlock(20)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      let orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)

      let activeBlocksC = 20 - orderStart
      let allActiveBlocksC = activeBlocksC
      let orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      let expectedDepositC = ltTradeC.salesRate.mul(orderBlocksC - allActiveBlocksC)

      expect(orderInfoAfterC.paused).to.eq(true)
      expect(orderInfoAfterC.proceeds).to.eq(expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      sumOrders0To1 = sumOrders0To1.sub(SALES_RATE_T0.mul(activeBlocksC * 2))
      sumOrders1To0 = sumOrders1To0.sub(SALES_RATE_T1.mul(activeBlocksC * 2))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let expectedProceedsT0 = SALES_RATE_T0.mul(2 * activeBlocksC)
      let expectedProceedsT1 = SALES_RATE_T1.mul(2 * activeBlocksC)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      let orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))
      let expectedOrdersT0 = SALES_RATE_T0.mul(orderBlocksA + orderBlocksC)
      let expectedOrdersT1 = SALES_RATE_T1.mul(2*orderBlocksC)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(expectedOrdersT0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(expectedOrdersT1)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at block 30
      //
      await seekToBlock(30)
      
      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)

      // Check that withdrawn proceeds are correct
      //
      let activeBlocksA = 30 - orderStart
      let expectedProceedsA = SALES_RATE_T0.mul(activeBlocksA)
      let balChange = balTracker.getDiff(ltOwner)
      expectWithinBillionths(balChange.token1, expectedProceedsA, 55)
      expect(balChange.token0).to.eq(ZERO)

      // Check pool accounting:
      //
      let allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      let sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(2 * activeBlocksA))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(activeBlocksC + activeBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      expectedProceedsT0 = SALES_RATE_T0.mul(activeBlocksC + activeBlocksA)
      expectedProceedsT1 = SALES_RATE_T1.mul(activeBlocksA)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinBillionths(proceeds.proceeds0U112, expectedProceedsT0, 36)
      expectWithinBillionths(proceeds.proceeds1U112, expectedProceedsT1, 53)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(SALES_RATE_T0.mul(2 * activeBlocksA))
                               .sub(SALES_RATE_T0.mul(activeBlocksA + activeBlocksC))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(SALES_RATE_T1.mul(activeBlocksA + activeBlocksC))
                               .sub(SALES_RATE_T1.mul(2 * activeBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order D at block 40
      //
      await seekToBlock(40)
      
      // Capture prev order data:
      //
      let orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)

      extendIntervals = 2
      await utb.issueLTSwapExtend(ltTradeD, extendIntervals)
      await mineBlocks()

      // Check orders expiries:
      //
      let orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      expect(orderInfoAfterD.orderExpiry)
      .to.eq(orderInfoBeforeD.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(2 * activeBlocksA))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(activeBlocksC + activeBlocksA))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      proceeds = await poolContract.getProceedAmounts()
      expectWithinBillionths(proceeds.proceeds0U112, expectedProceedsT0, 36)
      expectWithinBillionths(proceeds.proceeds1U112, expectedProceedsT1, 53)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
 
      // Updating active blocks here to match the virtual block (40), not the LVOB (30), which
      // is the convention in this test by block 105:
      activeBlocksA = 40 - orderStart
      activeBlocksC = 20 - orderStart
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(2 * activeBlocksA))
                           .sub(SALES_RATE_T0.mul(activeBlocksA + activeBlocksC))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(activeBlocksA + activeBlocksC))
                           .sub(SALES_RATE_T1.mul(2 * activeBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 50
      //
      await seekToBlock(50)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      activeBlocksA = 50 - 30
      let allActiveBlocksA = activeBlocksA +
                             (30 - orderStart)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      let expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(2 * allActiveBlocksA))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(activeBlocksC + allActiveBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      let activeBlocksB = 50 - orderStart
      expectedProceedsT0 = SALES_RATE_T0.mul(activeBlocksC + allActiveBlocksA)
      expectedProceedsT1 = SALES_RATE_T1.mul(activeBlocksA + activeBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      let withdrawnProceedsA = SALES_RATE_T0.mul(30 - orderStart)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(2 * allActiveBlocksA))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + activeBlocksC))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + activeBlocksC))
                           .sub(SALES_RATE_T1.mul(2 * allActiveBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order D at block 60
      //
      await seekToBlock(60)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeD.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 60 - orderStart
      activeBlocksC = 20 - orderStart
      let activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      let allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      let allActiveBlocksD = activeBlocksD
      
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      let orderBlocksD = Number(orderInfoAfterD.orderExpiry.sub(orderInfoAfterD.orderStart))

      let expectedProceedsD = ltTradeD.salesRate.mul(activeBlocksD)
      let expectedDepositD = ltTradeD.salesRate.mul(orderBlocksD - allActiveBlocksD)

      expect(orderInfoAfterD.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterD.proceeds, expectedProceedsD)
      expect(orderInfoAfterD.deposit).to.eq(expectedDepositD)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 70
      //
      await seekToBlock(70)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeB.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 70 - orderStart
      activeBlocksC = 20 - orderStart
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      let orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      let orderBlocksB = Number(orderInfoAfterB.orderExpiry.sub(orderInfoAfterB.orderStart))

      let expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      let expectedDepositB = ltTradeB.salesRate.mul(orderBlocksB - allActiveBlocksB)

      expect(orderInfoAfterB.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 80
      //
      await seekToBlock(80)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 70 - orderStart
      activeBlocksC = 20 - orderStart
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      let pauseBlocksA = 80 - 50
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order C at block 90
      //
      await seekToBlock(90)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (90 - 80) + (50 - 30)
      activeBlocksB = 70 - orderStart
      activeBlocksC = (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let pauseBlocksC = 90 - 20
      expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      expectedDepositC = ltTradeC.salesRate.mul(pauseBlocksC)

      expect(orderInfoAfterC.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterC.proceeds, expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A and resume order B at block 100
      //
      await seekToBlock(100)

      await balTracker.saveBalance(ltOwner)

      {
        const { swap, orderId } = ltTradeA
        const exitRequest = await swap.withdrawLongTerm(
          orderId,
          ltOwner,
          ltOwner,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltOwner.address,
          exitRequest
        )
      }

      await poolContract.connect(ltOwner).resumeOrder(ltTradeB.orderId)

      await mineBlocks()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (100 - 80) + (50 - 30)
      activeBlocksB = 70 - orderStart
      activeBlocksC = (100 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      expectedProceedsA = SALES_RATE_T0.mul(activeBlocksA)
      balChange = balTracker.getDiff(ltOwner)
      expectWithinMillionths(balChange.token1, expectedProceedsA)
      expect(balChange.token0).to.eq(ZERO)

      // Check order deposit and proceeds
      //
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderBlocksB = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let pauseBlocksB = 100 - 70
      expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      expectedDepositB = ltTradeB.salesRate.mul(pauseBlocksB)

      expect(orderInfoAfterB.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      withdrawnProceedsA = withdrawnProceedsA.add(expectedProceedsA)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A, 1 interval and orders B and C, 4 intervals at block 105
      //
      await seekToBlock(105)

      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)
      let orderInfoBeforeB = await poolContract.getOrder(ltTradeB.orderId)
      let orderInfoBeforeC = await poolContract.getOrder(ltTradeC.orderId)

      let extendIntervalsA = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervalsA)

      let extendIntervalsBC = 4
      await utb.issueLTSwapExtend(ltTradeB, extendIntervalsBC)
      await utb.issueLTSwapExtend(ltTradeC, extendIntervalsBC)
      
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervalsA*BLOCK_INTERVAL))
      expect(orderInfoAfterB.orderExpiry)
      .to.eq(orderInfoBeforeB.orderExpiry.add(extendIntervalsBC*BLOCK_INTERVAL))
      expect(orderInfoAfterC.orderExpiry)
      .to.eq(orderInfoBeforeC.orderExpiry.add(extendIntervalsBC*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      activeBlocksA = 0
      activeBlocksB = (70 - orderStart)
      activeBlocksC = (100 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      let allActiveVirtualBlocksA = (105 - 100) +
                                    (100 - 80) +
                                    (50 - 30) +
                                    (30 - orderStart)
      let allActiveVirtualBlocksB = (105 - 100) +
                                    (70 - orderStart)
      let allActiveVirtualBlocksC = (105 - 90) +
                                    (20- orderStart)
      let allActiveVirtualBlocksD = (60- orderStart)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order D at block 110
      //
      await seekToBlock(110)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeD.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (110 - 100)
      activeBlocksB = (110 - 100) + 70 - orderStart
      activeBlocksC = (110 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      orderBlocksD = Number(orderInfoAfterD.orderExpiry.sub(orderInfoAfterD.orderStart))

      let pauseBlocksD = 110 - 60
      expectedProceedsD = ltTradeD.salesRate.mul(activeBlocksD)
      expectedDepositD = ltTradeD.salesRate.mul(pauseBlocksD)

      expect(orderInfoAfterD.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterD.proceeds, expectedProceedsD)
      expect(orderInfoAfterD.deposit).to.eq(expectedDepositD)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (110 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (110 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (110 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 115
      //
      await seekToBlock(115)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (115 - 100)
      activeBlocksB = (115 - 100) + 70 - orderStart
      activeBlocksC = (115 - 90) + (20 - orderStart)
      activeBlocksD = (115 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA, 2)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (115 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (115 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (115 - 110) + 60 - orderStart
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 125
      //
      await seekToBlock(125)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (125 - 125) + (115 - 100)
      activeBlocksB = (125 - 100) + 70 - orderStart
      activeBlocksC = (125 - 90) + (20 - orderStart)
      activeBlocksD = (125 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      pauseBlocksA = (125 - 115) + (80 - 50)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA, 2)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (125 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (125 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (125 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (125 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order D at block 140
      //
      await seekToBlock(140)
      
      // Capture prev order data:
      //
      orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)

      extendIntervals = 2
      await utb.issueLTSwapExtend(ltTradeD, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      
      expect(orderInfoAfterD.orderExpiry)
      .to.eq(orderInfoBeforeD.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (140 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (140 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (140 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (140 - 110) +
                                (60- orderStart)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A at block 160
      //
      await seekToBlock(160)
      
      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (160 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (160 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (160 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (160 - 110) +
                                (60- orderStart)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at block 170
      //
      await seekToBlock(170)

      await balTracker.saveBalance(ltOwner)

      await ltTradeA.swap.withdrawLongTerm()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (170 - 125) + (115 - 100)
      activeBlocksB = (170 - 100) + 70 - orderStart
      activeBlocksC = (170 - 90) + (20 - orderStart)
      activeBlocksD = (170 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      expectedProceedsA = SALES_RATE_T0.mul(activeBlocksA)
      balChange = balTracker.getDiff(ltOwner)
      expectWithinMillionths(balChange.token1, expectedProceedsA, 2)
      expect(balChange.token0).to.eq(ZERO)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      withdrawnProceedsA = withdrawnProceedsA.add(expectedProceedsA)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (170 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (170 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (170 - 110) +
                                (60- orderStart)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 175
      //
      await seekToBlock(175)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 175 - 170
      activeBlocksB = (175 - 100) + 70 - orderStart
      activeBlocksC = (175 - 90) + (20 - orderStart)
      activeBlocksD = (175 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (175 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (175 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (175 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 180
      //
      await seekToBlock(180)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (180 - 180) + (175 - 170)
      activeBlocksB = (180 - 100) + 70 - orderStart
      activeBlocksC = (180 - 90) + (20 - orderStart)
      activeBlocksD = (180 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      pauseBlocksA = (180 - 175) + (125 - 115) + (80 - 50)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (180 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (180 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (180 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (180 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A at block 185
      //
      await seekToBlock(185)
      
      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (185 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (185 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (185 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (185 - 110) +
                                (60- orderStart)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order C at block 190
      //
      await seekToBlock(190)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (190 - 180) + (175 - 170)
      activeBlocksB = (190 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (190 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      expectedDepositC = ltTradeC.salesRate.mul(orderBlocksC - allActiveBlocksC)

      expect(orderInfoAfterC.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterC.proceeds, expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (190 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (190 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (190 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B and cancel order D at block 200
      //
      await seekToBlock(200)
      
      await balTracker.saveBalance(ltOwner)
      orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeB.orderId)
      await ltTradeD.swap.cancelLongTerm()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (200 - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksD = Number(orderInfoBeforeD.orderExpiry.sub(orderInfoBeforeD.orderStart))

      expectedProceedsD = SALES_RATE_T1.mul(allActiveBlocksD)
      const expectedRefundD = SALES_RATE_T1.mul(orderBlocksD - allActiveBlocksD)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token0, expectedProceedsD)
      expect(balChange.token1).to.eq(expectedRefundD)

      // Check order deposit and proceeds
      //
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderBlocksB = Number(orderInfoAfterB.orderExpiry.sub(orderInfoAfterB.orderStart))

      expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      expectedDepositB = ltTradeB.salesRate.mul(orderBlocksB - allActiveBlocksB)

      expect(orderInfoAfterB.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeD chain state data is zeroed.
      //       Do not use sumOrders henceforth!
      //
      let abcOrderInfo = await Promise.all([ltTradeA, ltTradeB, ltTradeC].map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      let sumOrdersABC = await sumSwapAmtsFromOrders(abcOrderInfo)

      expectedOrdersT0 = sumOrdersABC.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = sumOrdersABC.token1.sub(SALES_RATE_T1.mul(allActiveBlocksC))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksC)
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrdersABC.token0)
                                              .sub(expectedProceedsD)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrdersABC.token1)
                                              .add(SALES_RATE_T1.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0, 2)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (200 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order C at expiry block minus 1
      //
      orderInfoBeforeC = await poolContract.getOrder(ltTradeC.orderId)
      await seekToBlock(Number(orderInfoAfterC.orderExpiry.sub(1)))
      
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeC.swap.cancelLongTerm()
      
      await balTracker.saveBalance(ltOwner)

      let lastBlockNum = await getLastBlockNumber()
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (lastBlockNum - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksC = Number(orderInfoBeforeC.orderExpiry.sub(orderInfoBeforeC.orderStart))

      expectedProceedsC = SALES_RATE_T1.mul(allActiveBlocksC)
      const expectedRefundC = SALES_RATE_T1.mul(orderBlocksC - allActiveBlocksC)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token0, expectedProceedsC)
      expect(balChange.token1).to.eq(expectedRefundC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeC and ltTradeD chain state data is zeroed.
      //       Do not use sumOrdersABC and sumOrders henceforth!
      //
      let abOrderInfo = await Promise.all([ltTradeA, ltTradeB].map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      let sumOrdersAB = await sumSwapAmtsFromOrders(abOrderInfo)

      expectedOrdersT0 = sumOrdersAB.token0.sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT1 = ZERO
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = ZERO
      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceedsT0, 5)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1, 4)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrdersAB.token0)
                                              .sub(expectedProceedsC)
                                              .sub(expectedProceedsD)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrdersAB.token1)
                                              .add(SALES_RATE_T1.mul(allActiveBlocksC))
                                              .add(SALES_RATE_T1.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0, 3)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      allActiveVirtualBlocksA = (lastBlockNum - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 17)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A and B at expiry block
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)
      orderInfoBeforeB = await poolContract.getOrder(ltTradeB.orderId)

      expect(await getCurrentBlockNumber()).to.eq(orderInfoBeforeA.orderExpiry)
      
      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)
      
      {
        const { swap, orderId } = ltTradeA
        const exitRequest = await swap.withdrawLongTerm(
          orderId,
          ltOwner,
          ltOwner,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltOwner.address,
          exitRequest
        )
      }

      await ltTradeB.swap.withdrawLongTerm(
        ltTradeB.orderId,
        ltOwner,
        ltDelegate
      )

      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)

      lastBlockNum = await getLastBlockNumber()
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (lastBlockNum - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksA = Number(orderInfoBeforeA.orderExpiry.sub(orderInfoBeforeA.orderStart))
      orderBlocksB = Number(orderInfoBeforeB.orderExpiry.sub(orderInfoBeforeB.orderStart))

      expectedProceedsA = SALES_RATE_T0.mul(allActiveBlocksA).sub(withdrawnProceedsA)
      const expectedRefundA = SALES_RATE_T0.mul(orderBlocksA - allActiveBlocksA)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token1, expectedProceedsA, 5)
      expect(balChange.token0).to.eq(expectedRefundA)
      
      expectedProceedsB = SALES_RATE_T0.mul(allActiveBlocksB)
      const expectedRefundB = SALES_RATE_T0.mul(orderBlocksB - allActiveBlocksB)
      balChange = balTracker.getDiff(ltDelegate)

      expectWithinMillionths(balChange.token1, expectedProceedsB)
      expect(balChange.token0).to.eq(expectedRefundB)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeC and ltTradeD chain state data is zeroed.
      //       Do not use sumOrdersABC and sumOrders henceforth!
      //
      expectedOrdersT0 = ZERO
      expectedOrdersT1 = ZERO
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = ZERO
      expectedProceedsT1 = ZERO
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceedsT0, 5)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceedsT1, 5)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(allActiveBlocksA))
                                              .add(SALES_RATE_T0.mul(allActiveBlocksB))
                                              .sub(expectedProceedsC)
                                              .sub(expectedProceedsD)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(allActiveBlocksC))
                                              .add(SALES_RATE_T1.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
                                              .sub(expectedProceedsA)
                                              .sub(expectedProceedsB)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0, 3)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 17)
      
      allActiveVirtualBlocksA = (lastBlockNum - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 17)
    })

    it ("should allow variations of pause-extend-resume for multiple opposing orders (0->1 switched) [PRE-AT-001B]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue four orders in the same block:
      //
      const intervals = 2
      
      // 0->1 Orders:
      //
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltTradeB = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltOrders1To0 = [ltTradeA, ltTradeB]

      // 1->0 Orders:
      //
      const ltTradeC = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltTradeD = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltOrders0To1 = [ltTradeC, ltTradeD]

      const allOrders = [...ltOrders0To1, ...ltOrders1To0]

      await mineBlocks()

      const orderStart = await getLastBlockNumber()
      
      // Check the pool accounting:
      //
      let sumOrders0To1 = sumSwapAmts(ltOrders0To1)
      let sumOrders1To0 = sumSwapAmts(ltOrders1To0)

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A 1 interval at block 15
      //
      await seekToBlock(15)
      
      // Capture prev order data:
      //
      let orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      let extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()

      // Check orders expiries:
      //
      let orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      let totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      let totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      sumOrders1To0 = sumOrders1To0.add(SALES_RATE_T1.mul(extendIntervals*BLOCK_INTERVAL))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // Order is balanced at this point; no net change:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order C at block 20
      //
      await seekToBlock(20)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      let orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)

      let activeBlocksC = 20 - orderStart
      let allActiveBlocksC = activeBlocksC
      let orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      let expectedDepositC = ltTradeC.salesRate.mul(orderBlocksC - allActiveBlocksC)

      expect(orderInfoAfterC.paused).to.eq(true)
      expect(orderInfoAfterC.proceeds).to.eq(expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      sumOrders0To1 = sumOrders0To1.sub(SALES_RATE_T0.mul(activeBlocksC * 2))
      sumOrders1To0 = sumOrders1To0.sub(SALES_RATE_T1.mul(activeBlocksC * 2))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let expectedProceedsT0 = SALES_RATE_T0.mul(2 * activeBlocksC)
      let expectedProceedsT1 = SALES_RATE_T1.mul(2 * activeBlocksC)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      let orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))
      let expectedOrdersT1 = SALES_RATE_T1.mul(orderBlocksA + orderBlocksC)
      let expectedOrdersT0 = SALES_RATE_T0.mul(2*orderBlocksC)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(expectedOrdersT0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(expectedOrdersT1)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at block 30
      //
      await seekToBlock(30)
      
      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)

      // Check that withdrawn proceeds are correct
      //
      let activeBlocksA = 30 - orderStart
      let expectedProceedsA = SALES_RATE_T1.mul(activeBlocksA)
      let balChange = balTracker.getDiff(ltOwner)
      expectWithinBillionths(balChange.token0, expectedProceedsA, 55)
      expect(balChange.token1).to.eq(ZERO)

      // Check pool accounting:
      //
      let allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      let sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(2 * activeBlocksA))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(activeBlocksC + activeBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      expectedProceedsT1 = SALES_RATE_T1.mul(activeBlocksC + activeBlocksA)
      expectedProceedsT0 = SALES_RATE_T0.mul(activeBlocksA)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinBillionths(proceeds.proceeds1U112, expectedProceedsT1, 36)
      expectWithinBillionths(proceeds.proceeds0U112, expectedProceedsT0, 53)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(SALES_RATE_T1.mul(2 * activeBlocksA))
                               .sub(SALES_RATE_T1.mul(activeBlocksA + activeBlocksC))
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(SALES_RATE_T0.mul(activeBlocksA + activeBlocksC))
                               .sub(SALES_RATE_T0.mul(2 * activeBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order D at block 40
      //
      await seekToBlock(40)
      
      // Capture prev order data:
      //
      let orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)

      extendIntervals = 2
      await utb.issueLTSwapExtend(ltTradeD, extendIntervals)
      await mineBlocks()

      // Check orders expiries:
      //
      let orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      expect(orderInfoAfterD.orderExpiry)
      .to.eq(orderInfoBeforeD.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(2 * activeBlocksA))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(activeBlocksC + activeBlocksA))

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      proceeds = await poolContract.getProceedAmounts()
      expectWithinBillionths(proceeds.proceeds1U112, expectedProceedsT1, 36)
      expectWithinBillionths(proceeds.proceeds0U112, expectedProceedsT0, 53)

      // Orders B, C, & D are the same length, hence orderBlocksC re-used below:
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
 
      // Updating active blocks here to match the virtual block (40), not the LVOB (30), which
      // is the convention in this test by block 105:
      activeBlocksA = 40 - orderStart
      activeBlocksC = 20 - orderStart
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(2 * activeBlocksA))
                           .sub(SALES_RATE_T1.mul(activeBlocksA + activeBlocksC))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(activeBlocksA + activeBlocksC))
                           .sub(SALES_RATE_T0.mul(2 * activeBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 50
      //
      await seekToBlock(50)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      activeBlocksA = 50 - 30
      let allActiveBlocksA = activeBlocksA +
                             (30 - orderStart)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      let expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)
      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(2 * allActiveBlocksA))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(activeBlocksC + allActiveBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      let activeBlocksB = 50 - orderStart
      expectedProceedsT1 = SALES_RATE_T1.mul(activeBlocksC + allActiveBlocksA)
      expectedProceedsT0 = SALES_RATE_T0.mul(activeBlocksA + activeBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      let withdrawnProceedsA = SALES_RATE_T1.mul(30 - orderStart)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(2 * allActiveBlocksA))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksA + activeBlocksC))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksA + activeBlocksC))
                           .sub(SALES_RATE_T0.mul(2 * allActiveBlocksA))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order D at block 60
      //
      await seekToBlock(60)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeD.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 60 - orderStart
      activeBlocksC = 20 - orderStart
      let activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      let allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      let allActiveBlocksD = activeBlocksD
      
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      let orderBlocksD = Number(orderInfoAfterD.orderExpiry.sub(orderInfoAfterD.orderStart))

      let expectedProceedsD = ltTradeD.salesRate.mul(activeBlocksD)
      let expectedDepositD = ltTradeD.salesRate.mul(orderBlocksD - allActiveBlocksD)

      expect(orderInfoAfterD.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterD.proceeds, expectedProceedsD)
      expect(orderInfoAfterD.deposit).to.eq(expectedDepositD)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 70
      //
      await seekToBlock(70)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeB.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 70 - orderStart
      activeBlocksC = 20 - orderStart
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      let orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      let orderBlocksB = Number(orderInfoAfterB.orderExpiry.sub(orderInfoAfterB.orderStart))

      let expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      let expectedDepositB = ltTradeB.salesRate.mul(orderBlocksB - allActiveBlocksB)

      expect(orderInfoAfterB.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 80
      //
      await seekToBlock(80)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 50 - 30
      activeBlocksB = 70 - orderStart
      activeBlocksC = 20 - orderStart
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      let pauseBlocksA = 80 - 50
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order C at block 90
      //
      await seekToBlock(90)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (90 - 80) + (50 - 30)
      activeBlocksB = 70 - orderStart
      activeBlocksC = (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let pauseBlocksC = 90 - 20
      expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      expectedDepositC = ltTradeC.salesRate.mul(pauseBlocksC)

      expect(orderInfoAfterC.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterC.proceeds, expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A and resume order B at block 100
      //
      await seekToBlock(100)

      await balTracker.saveBalance(ltOwner)

      {
        const { swap, orderId } = ltTradeA
        const exitRequest = await swap.withdrawLongTerm(
          orderId,
          ltOwner,
          ltOwner,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltOwner.address,
          exitRequest
        )
      }

      await poolContract.connect(ltOwner).resumeOrder(ltTradeB.orderId)

      await mineBlocks()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (100 - 80) + (50 - 30)
      activeBlocksB = 70 - orderStart
      activeBlocksC = (100 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      expectedProceedsA = SALES_RATE_T1.mul(activeBlocksA)
      balChange = balTracker.getDiff(ltOwner)
      expectWithinMillionths(balChange.token0, expectedProceedsA)
      expect(balChange.token1).to.eq(ZERO)

      // Check order deposit and proceeds
      //
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderBlocksB = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      let pauseBlocksB = 100 - 70
      expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      expectedDepositB = ltTradeB.salesRate.mul(pauseBlocksB)

      expect(orderInfoAfterB.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      withdrawnProceedsA = withdrawnProceedsA.add(expectedProceedsA)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveBlocksC + allActiveBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveBlocksA + allActiveBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A, 1 interval and orders B and C, 4 intervals at block 105
      //
      await seekToBlock(105)

      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)
      let orderInfoBeforeB = await poolContract.getOrder(ltTradeB.orderId)
      let orderInfoBeforeC = await poolContract.getOrder(ltTradeC.orderId)

      let extendIntervalsA = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervalsA)

      let extendIntervalsBC = 4
      await utb.issueLTSwapExtend(ltTradeB, extendIntervalsBC)
      await utb.issueLTSwapExtend(ltTradeC, extendIntervalsBC)
      
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervalsA*BLOCK_INTERVAL))
      expect(orderInfoAfterB.orderExpiry)
      .to.eq(orderInfoBeforeB.orderExpiry.add(extendIntervalsBC*BLOCK_INTERVAL))
      expect(orderInfoAfterC.orderExpiry)
      .to.eq(orderInfoBeforeC.orderExpiry.add(extendIntervalsBC*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      activeBlocksA = 0
      activeBlocksB = (70 - orderStart)
      activeBlocksC = (100 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      let allActiveVirtualBlocksA = (105 - 100) +
                                    (100 - 80) +
                                    (50 - 30) +
                                    (30 - orderStart)
      let allActiveVirtualBlocksB = (105 - 100) +
                                    (70 - orderStart)
      let allActiveVirtualBlocksC = (105 - 90) +
                                    (20- orderStart)
      let allActiveVirtualBlocksD = (60- orderStart)

      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order D at block 110
      //
      await seekToBlock(110)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeD.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (110 - 100)
      activeBlocksB = (110 - 100) + 70 - orderStart
      activeBlocksC = (110 - 90) + (20 - orderStart)
      activeBlocksD = 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      orderBlocksD = Number(orderInfoAfterD.orderExpiry.sub(orderInfoAfterD.orderStart))

      let pauseBlocksD = 110 - 60
      expectedProceedsD = ltTradeD.salesRate.mul(activeBlocksD)
      expectedDepositD = ltTradeD.salesRate.mul(pauseBlocksD)

      expect(orderInfoAfterD.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterD.proceeds, expectedProceedsD)
      expect(orderInfoAfterD.deposit).to.eq(expectedDepositD)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (110 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (110 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (110 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 115
      //
      await seekToBlock(115)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (115 - 100)
      activeBlocksB = (115 - 100) + 70 - orderStart
      activeBlocksC = (115 - 90) + (20 - orderStart)
      activeBlocksD = (115 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA, 2)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (115 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (115 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (115 - 110) + 60 - orderStart
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 125
      //
      await seekToBlock(125)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (125 - 125) + (115 - 100)
      activeBlocksB = (125 - 100) + 70 - orderStart
      activeBlocksC = (125 - 90) + (20 - orderStart)
      activeBlocksD = (125 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      pauseBlocksA = (125 - 115) + (80 - 50)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA, 2)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (125 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (125 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (125 - 90) +
                                (20- orderStart)
      allActiveVirtualBlocksD = (125 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order D at block 140
      //
      await seekToBlock(140)
      
      // Capture prev order data:
      //
      orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)

      extendIntervals = 2
      await utb.issueLTSwapExtend(ltTradeD, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterD = await poolContract.getOrder(ltTradeD.orderId)
      
      expect(orderInfoAfterD.orderExpiry)
      .to.eq(orderInfoBeforeD.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (140 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (140 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (140 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (140 - 110) +
                                (60- orderStart)

      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A at block 160
      //
      await seekToBlock(160)
      
      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (160 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (160 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (160 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (160 - 110) +
                                (60- orderStart)

      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at block 170
      //
      await seekToBlock(170)

      await balTracker.saveBalance(ltOwner)

      await ltTradeA.swap.withdrawLongTerm()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (170 - 125) + (115 - 100)
      activeBlocksB = (170 - 100) + 70 - orderStart
      activeBlocksC = (170 - 90) + (20 - orderStart)
      activeBlocksD = (170 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      expectedProceedsA = SALES_RATE_T1.mul(activeBlocksA)
      balChange = balTracker.getDiff(ltOwner)
      expectWithinMillionths(balChange.token0, expectedProceedsA, 2)
      expect(balChange.token1).to.eq(ZERO)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      withdrawnProceedsA = withdrawnProceedsA.add(expectedProceedsA)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (170 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (170 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (170 - 110) +
                                (60- orderStart)

      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 175
      //
      await seekToBlock(175)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = 175 - 170
      activeBlocksB = (175 - 100) + 70 - orderStart
      activeBlocksC = (175 - 90) + (20 - orderStart)
      activeBlocksD = (175 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(orderBlocksA - allActiveBlocksA)

      expect(orderInfoAfterA.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (175 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (175 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (175 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 180
      //
      await seekToBlock(180)
      
      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (180 - 180) + (175 - 170)
      activeBlocksB = (180 - 100) + 70 - orderStart
      activeBlocksC = (180 - 90) + (20 - orderStart)
      activeBlocksD = (180 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      orderBlocksA = Number(orderInfoAfterA.orderExpiry.sub(orderInfoAfterA.orderStart))

      pauseBlocksA = (180 - 175) + (125 - 115) + (80 - 50)
      expectedProceedsA = ltTradeA.salesRate.mul(activeBlocksA)
      expectedDepositA = ltTradeA.salesRate.mul(pauseBlocksA)

      expect(orderInfoAfterA.paused).to.eq(false)
      expectWithinMillionths(orderInfoAfterA.proceeds, expectedProceedsA)
      expect(orderInfoAfterA.deposit).to.eq(expectedDepositA)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (180 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (180 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (180 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (180 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 2)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend order A at block 185
      //
      await seekToBlock(185)
      
      // Capture prev order data:
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)

      extendIntervals = 1
      await utb.issueLTSwapExtend(ltTradeA, extendIntervals)
      await mineBlocks()
      
      // Check orders expiries:
      //
      orderInfoAfterA = await poolContract.getOrder(ltTradeA.orderId)
      
      expect(orderInfoAfterA.orderExpiry)
      .to.eq(orderInfoBeforeA.orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      
      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0.mul(2)
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check pool accounting:
      //
      
      // Note: No EVO on extend, no need to update active/all active blocks.

      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (185 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (185 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (185 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (185 - 110) +
                                (60- orderStart)

      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order C at block 190
      //
      await seekToBlock(190)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeC.orderId)
      await mineBlocks()
      
      // Check order deposit and proceeds
      //
      activeBlocksA = (190 - 180) + (175 - 170)
      activeBlocksB = (190 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (190 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderInfoAfterC = await poolContract.getOrder(ltTradeC.orderId)
      orderBlocksC = Number(orderInfoAfterC.orderExpiry.sub(orderInfoAfterC.orderStart))

      expectedProceedsC = ltTradeC.salesRate.mul(activeBlocksC)
      expectedDepositC = ltTradeC.salesRate.mul(orderBlocksC - allActiveBlocksC)

      expect(orderInfoAfterC.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterC.proceeds, expectedProceedsC)
      expect(orderInfoAfterC.deposit).to.eq(expectedDepositC)

      // Check sales rates:
      //
      totalSalesRates0To1 = SALES_RATE_T0
      totalSalesRates1To0 = SALES_RATE_T1.mul(2)
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      allOrderInfo = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      sumOrders = await sumSwapAmtsFromOrders(allOrderInfo)

      expectedOrdersT1 = sumOrders.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrders.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC + allActiveBlocksD)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders.token1)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders.token0).sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (190 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (190 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (190 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 2)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B and cancel order D at block 200
      //
      await seekToBlock(200)
      
      await balTracker.saveBalance(ltOwner)
      orderInfoBeforeD = await poolContract.getOrder(ltTradeD.orderId)
      
      await poolContract.connect(ltOwner).pauseOrder(ltTradeB.orderId)
      await ltTradeD.swap.cancelLongTerm()
      
      await balTracker.saveBalance(ltOwner)
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (200 - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksD = Number(orderInfoBeforeD.orderExpiry.sub(orderInfoBeforeD.orderStart))

      expectedProceedsD = SALES_RATE_T0.mul(allActiveBlocksD)
      const expectedRefundD = SALES_RATE_T0.mul(orderBlocksD - allActiveBlocksD)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token1, expectedProceedsD)
      expect(balChange.token0).to.eq(expectedRefundD)

      // Check order deposit and proceeds
      //
      orderInfoAfterB = await poolContract.getOrder(ltTradeB.orderId)
      orderBlocksB = Number(orderInfoAfterB.orderExpiry.sub(orderInfoAfterB.orderStart))

      expectedProceedsB = ltTradeB.salesRate.mul(activeBlocksB)
      expectedDepositB = ltTradeB.salesRate.mul(orderBlocksB - allActiveBlocksB)

      expect(orderInfoAfterB.paused).to.eq(true)
      expectWithinMillionths(orderInfoAfterB.proceeds, expectedProceedsB)
      expect(orderInfoAfterB.deposit).to.eq(expectedDepositB)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeD chain state data is zeroed.
      //       Do not use sumOrders henceforth!
      //
      let abcOrderInfo = await Promise.all([ltTradeA, ltTradeB, ltTradeC].map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      let sumOrdersABC = await sumSwapAmtsFromOrders(abcOrderInfo)

      expectedOrdersT1 = sumOrdersABC.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = sumOrdersABC.token0.sub(SALES_RATE_T0.mul(allActiveBlocksC))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = SALES_RATE_T0.mul(allActiveBlocksC)
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrdersABC.token1)
                                              .sub(expectedProceedsD)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrdersABC.token0)
                                              .add(SALES_RATE_T0.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 2)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (200 - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 3)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order C at expiry block minus 1
      //
      orderInfoBeforeC = await poolContract.getOrder(ltTradeC.orderId)
      await seekToBlock(Number(orderInfoAfterC.orderExpiry.sub(1)))
      
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeC.swap.cancelLongTerm()
      
      await balTracker.saveBalance(ltOwner)

      let lastBlockNum = await getLastBlockNumber()
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (lastBlockNum - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksC = Number(orderInfoBeforeC.orderExpiry.sub(orderInfoBeforeC.orderStart))

      expectedProceedsC = SALES_RATE_T0.mul(allActiveBlocksC)
      const expectedRefundC = SALES_RATE_T0.mul(orderBlocksC - allActiveBlocksC)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token1, expectedProceedsC)
      expect(balChange.token0).to.eq(expectedRefundC)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = SALES_RATE_T1
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeC and ltTradeD chain state data is zeroed.
      //       Do not use sumOrdersABC and sumOrders henceforth!
      //
      let abOrderInfo = await Promise.all([ltTradeA, ltTradeB].map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      let sumOrdersAB = await sumSwapAmtsFromOrders(abOrderInfo)

      expectedOrdersT1 = sumOrdersAB.token1.sub(SALES_RATE_T1.mul(allActiveBlocksA + allActiveBlocksB))
      expectedOrdersT0 = ZERO
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT1 = ZERO
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksA + allActiveBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceedsT1, 5)
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0, 4)
      
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrdersAB.token1)
                                              .sub(expectedProceedsC)
                                              .sub(expectedProceedsD)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrdersAB.token0)
                                              .add(SALES_RATE_T0.mul(allActiveBlocksC))
                                              .add(SALES_RATE_T0.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 3)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      allActiveVirtualBlocksA = (lastBlockNum - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 17)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A and B at expiry block
      //
      orderInfoBeforeA = await poolContract.getOrder(ltTradeA.orderId)
      orderInfoBeforeB = await poolContract.getOrder(ltTradeB.orderId)

      expect(await getCurrentBlockNumber()).to.eq(orderInfoBeforeA.orderExpiry)
      
      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)
      
      {
        const { swap, orderId } = ltTradeA
        const exitRequest = await swap.withdrawLongTerm(
          orderId,
          ltOwner,
          ltOwner,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltOwner.address,
          exitRequest
        )
      }

      await ltTradeB.swap.withdrawLongTerm(
        ltTradeB.orderId,
        ltOwner,
        ltDelegate
      )

      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)

      lastBlockNum = await getLastBlockNumber()
      
      // Check that withdrawn proceeds are correct
      //
      activeBlocksA = (lastBlockNum - 180) + (175 - 170)
      activeBlocksB = (200 - 100) + 70 - orderStart
      activeBlocksC = (190 - 90) + (20 - orderStart)
      activeBlocksD = (200 - 110) + 60 - orderStart
      allActiveBlocksA = activeBlocksA +
                         (170 - 125) +
                         (115 - 100) +
                         (100 - 80) +
                         (50 - 30) +
                         (30 - orderStart)
      allActiveBlocksB = activeBlocksB
      allActiveBlocksC = activeBlocksC
      allActiveBlocksD = activeBlocksD
      
      orderBlocksA = Number(orderInfoBeforeA.orderExpiry.sub(orderInfoBeforeA.orderStart))
      orderBlocksB = Number(orderInfoBeforeB.orderExpiry.sub(orderInfoBeforeB.orderStart))

      expectedProceedsA = SALES_RATE_T1.mul(allActiveBlocksA).sub(withdrawnProceedsA)
      const expectedRefundA = SALES_RATE_T1.mul(orderBlocksA - allActiveBlocksA)
      balChange = balTracker.getDiff(ltOwner)

      expectWithinMillionths(balChange.token0, expectedProceedsA, 5)
      expect(balChange.token1).to.eq(expectedRefundA)
      
      expectedProceedsB = SALES_RATE_T1.mul(allActiveBlocksB)
      const expectedRefundB = SALES_RATE_T1.mul(orderBlocksB - allActiveBlocksB)
      balChange = balTracker.getDiff(ltDelegate)

      expectWithinMillionths(balChange.token0, expectedProceedsB)
      expect(balChange.token1).to.eq(expectedRefundB)

      // Check sales rates:
      //
      totalSalesRates0To1 = ZERO
      totalSalesRates1To0 = ZERO
      salesRates = await poolContract.getSalesRates()

      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)
      
      // Check pool accounting:
      //
      // NOTE: At this point ltTradeC and ltTradeD chain state data is zeroed.
      //       Do not use sumOrdersABC and sumOrders henceforth!
      //
      expectedOrdersT0 = ZERO
      expectedOrdersT1 = ZERO
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = ZERO
      expectedProceedsT1 = ZERO
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceedsT0, 5)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceedsT1, 5)
      
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(allActiveBlocksA))
                                              .add(SALES_RATE_T1.mul(allActiveBlocksB))
                                              .sub(expectedProceedsC)
                                              .sub(expectedProceedsD)
      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(allActiveBlocksC))
                                              .add(SALES_RATE_T0.mul(allActiveBlocksD))
                                              .sub(withdrawnProceedsA)
                                              .sub(expectedProceedsA)
                                              .sub(expectedProceedsB)
      vaultReserves = await poolHelper.getVaultPoolReserves()

      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 3)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0, 17)
      
      allActiveVirtualBlocksA = (lastBlockNum - 180) +
                                (175 - 170) +
                                (170 - 125) +
                                (115 - 100) +
                                (100 - 80) +
                                (50 - 30) +
                                (30 - orderStart)
      allActiveVirtualBlocksB = (200 - 100) +
                                (70 - orderStart)
      allActiveVirtualBlocksC = (190 - 90) +
                                (20 - orderStart)
      allActiveVirtualBlocksD = (200 - 110) +
                                (60- orderStart)
      
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))
                           .sub(SALES_RATE_T1.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(allActiveVirtualBlocksC + allActiveVirtualBlocksD))
                           .sub(SALES_RATE_T0.mul(allActiveVirtualBlocksA + allActiveVirtualBlocksB))

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 3)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 17)
    })

    it ("should allow variations of pause-extend-resume for multiple opposing orders [PRE-AT-002]", async function() {
      const utb = new UnminedTxnBuilder(
        poolHelper,
        swapMgr,
        BLOCK_INTERVAL,
        globalOwner,
        ltOwner,
        ltDelegate
      )

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue eight orders in the same block:
      //
      const intervals = 2

      // 0->1 Orders:
      //
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltTradeB = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltTradeC = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltTradeD = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      const ltOrders0To1 = [ltTradeA, ltTradeB, ltTradeC, ltTradeD]

      // 1->0 Orders:
      //
      const ltTradeE = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltTradeF = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltTradeG = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltTradeH = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      const ltOrders1To0 = [ltTradeE, ltTradeF, ltTradeG, ltTradeH]

      const allOrders = [...ltOrders0To1, ...ltOrders1To0]

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let sumOrders0To1 = sumSwapAmts(ltOrders0To1)
      let sumOrders1To0 = sumSwapAmts(ltOrders1To0)

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend all orders one interval at block 20
      //
      await seekToBlock(20)

      // Capture prev order data:
      //
      let orderInfoBefore = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      let extendIntervals = 1
      for (const ltTrade of allOrders) {
        await utb.issueLTSwapExtend(ltTrade, extendIntervals)
      }
      await mineBlocks()

      // Check orders expiries:
      //
      let orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoBefore.length; index++) {
        expect(orderInfoAfter[index].orderExpiry)
        .to.eq(orderInfoBefore[index].orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
      }

      // Check pool accounting:
      // NOTE: Next line works for all 4 orders in each direction b/c they have identical length rn.
      sumOrders0To1 = SALES_RATE_T0.mul(4).mul(ltTradeA.tradeBlocks+BLOCK_INTERVAL)
      sumOrders1To0 = SALES_RATE_T1.mul(4).mul(ltTradeE.tradeBlocks+BLOCK_INTERVAL)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(sumOrders0To1)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(sumOrders1To0)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      let totalSalesRates0To1 = SALES_RATE_T0.mul(4)
      let totalSalesRates1To0 = SALES_RATE_T1.mul(4)
      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw all orders at block 40
      //
      await seekToBlock(40)
      
      // Break the withdrawls out into 8 individually named addresses (by swap letter)
      // to be able to independently ensure correct values:
      //   - Addresses map from order A..H by indexes of destAddrs, 0..7
      //
      const destAddrs = [admin1, admin2, partnerBloxRoute, partnerX,
                         arbitrageur1, arbitrageur2, arbitrageur3, arbitrageur4]
      const balTracker = new BalanceTracker(poolHelper)
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.withdrawLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doWithdraw
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Check the balances to ensure approximately correct amounts:
      //
      let activeBlocks = 40 - orderInfoAfter[0].orderStart
      for (let index = 0; index < 8; index++) {
        const expectedProceeds = (index <= 3) ?
                                 SALES_RATE_T0.mul(activeBlocks) :
                                 SALES_RATE_T1.mul(activeBlocks)
        const balChange = balTracker.getDiff(destAddrs[index])
        const actualProceeds = (index <= 3) ? balChange.token1 : balChange.token0

        expect(actualProceeds).to.eq(expectedProceeds)
      }

      // Check pool accounting:
      let totalSoldT0 = SALES_RATE_T0.mul(4).mul(activeBlocks)
      let totalSoldT1 = SALES_RATE_T1.mul(4).mul(activeBlocks)
      let sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      let totalWithdrawnT0 = SALES_RATE_T1.mul(4).mul(activeBlocks)
      let totalWithdrawnT1 = SALES_RATE_T0.mul(4).mul(activeBlocks)
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)


      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause all orders at block 60
      //
      await seekToBlock(60)
      
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients) => {
          await poolContract.connect(ltOwner).pauseOrder(value.orderId)
        })
      )
      await mineBlocks()
      
      // Check sales rate
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      // Check individual order accounting
      let expectedProceedsT1 = SALES_RATE_T0.mul(60 - 40)
      let expectedDepositT0 = SALES_RATE_T0.mul(orderInfoAfter[0].orderExpiry.sub(60))
      
      let expectedProceedsT0 = SALES_RATE_T1.mul(60 - 40)
      let expectedDepositT1 = SALES_RATE_T1.mul(orderInfoAfter[0].orderExpiry.sub(60))

      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoAfter.length; index++) {
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume all orders at block 80
      //
      await seekToBlock(80)
      
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients) => {
          await poolContract.connect(ltDelegate).resumeOrder(value.orderId)
        })
      )
      await mineBlocks()

      // Check sales rate
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check individual order accounting
      expectedDepositT0 = SALES_RATE_T0.mul(80 - 60)
      expectedDepositT1 = SALES_RATE_T1.mul(80 - 60)

      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoAfter.length; index++) {
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend all orders two intervals at block 100
      //
      await seekToBlock(100)

      // Capture prev order data:
      //
      orderInfoBefore = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      extendIntervals = 2
      for (const ltTrade of allOrders) {
        await utb.issueLTSwapExtend(ltTrade, extendIntervals)
      }
      await mineBlocks()

      // Check orders expiries:
      //
      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoBefore.length; index++) {
        expect(orderInfoAfter[index].orderExpiry)
        .to.eq(orderInfoBefore[index].orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
        
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      // Check pool accounting:
      // NOTE: Extend doesn't EVO so LVOB unchanged from 80 (the last resume operation)
      activeBlocks = 60 - 40
      let allActiveBlocks = activeBlocks + 40 - orderInfoAfter[0].orderStart
      totalSoldT0 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      totalSoldT1 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expectedProceedsT0 = SALES_RATE_T1.mul(4).mul(activeBlocks)
      expectedProceedsT1 = SALES_RATE_T0.mul(4).mul(activeBlocks)
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)
      
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw all orders at block 120
      //
      await seekToBlock(120)

      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.withdrawLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doWithdraw
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Check the balances to ensure approximately correct amounts:
      //
      activeBlocks = 120 - 80 + 60 - 40
      allActiveBlocks = activeBlocks + 40 - orderInfoAfter[0].orderStart
      for (let index = 0; index < 8; index++) {
        const expectedProceeds = (index <= 3) ?
                                 SALES_RATE_T0.mul(activeBlocks) :
                                 SALES_RATE_T1.mul(activeBlocks)
        const balChange = balTracker.getDiff(destAddrs[index])
        const actualProceeds = (index <= 3) ? balChange.token1 : balChange.token0

        expect(actualProceeds).to.eq(expectedProceeds)
      }
      
      // Check pool accounting:
      totalSoldT0 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      totalSoldT1 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      totalWithdrawnT0 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      totalWithdrawnT1 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause all orders at block 140
      //
      await seekToBlock(140)

      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients) => {
          await poolContract.connect(ltOwner).pauseOrder(value.orderId)
        })
      )
      await mineBlocks()
      
      // Check sales rate
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      // Check individual order accounting
      activeBlocks = 140 - 120
      allActiveBlocks = activeBlocks +
                        120 - 80 +
                        60 - 40 + 
                        40 - orderInfoAfter[0].orderStart
      let orderBlocks = orderInfoAfter[0].orderExpiry - orderInfoAfter[0].orderStart
      let remainingBlocks = orderBlocks - allActiveBlocks

      expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocks)
      expectedDepositT0 = SALES_RATE_T0.mul(remainingBlocks)
      
      expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocks)
      expectedDepositT1 = SALES_RATE_T1.mul(remainingBlocks)

      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoAfter.length; index++) {
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume all orders at block 160
      //
      await seekToBlock(160)
      
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients) => {
          await poolContract.connect(ltDelegate).resumeOrder(value.orderId)
        })
      )
      await mineBlocks()

      // Check sales rate
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(totalSalesRates0To1)
      expect(salesRates.salesRate1U112).to.eq(totalSalesRates1To0)

      // Check individual order accounting
      let inactiveBlocks = 160 - 140 + 80 - 60

      expectedDepositT0 = SALES_RATE_T0.mul(inactiveBlocks)
      expectedDepositT1 = SALES_RATE_T1.mul(inactiveBlocks)

      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoAfter.length; index++) {
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw all orders at block 180
      //
      await seekToBlock(180)

      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      await Promise.all(
        allOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.withdrawLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doWithdraw
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Check the balances to ensure approximately correct amounts:
      //
      activeBlocks = 180 - 160 + 140 - 120
      allActiveBlocks = activeBlocks +
                        120 - 80 +
                        60 - 40 +
                        40 - orderInfoAfter[0].orderStart
      for (let index = 0; index < 8; index++) {
        const expectedProceeds = (index <= 3) ?
                                 SALES_RATE_T0.mul(activeBlocks) :
                                 SALES_RATE_T1.mul(activeBlocks)
        const balChange = balTracker.getDiff(destAddrs[index])
        const actualProceeds = (index <= 3) ? balChange.token1 : balChange.token0

        expect(actualProceeds).to.eq(expectedProceeds)
      }
      
      // Check pool accounting:
      totalSoldT0 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      totalSoldT1 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      totalWithdrawnT0 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      totalWithdrawnT1 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Extend all orders one interval at block 200
      //
      await seekToBlock(200)

      // Capture prev order data:
      //
      orderInfoBefore = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))

      extendIntervals = 1
      for (const ltTrade of allOrders) {
        await utb.issueLTSwapExtend(ltTrade, extendIntervals)
      }
      await mineBlocks()

      // Check orders expiries:
      //
      expectedProceedsT0 = ZERO   // Proceeds cleared in the withdraw at 180
      expectedProceedsT1 = ZERO

      orderInfoAfter = await Promise.all(allOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < orderInfoBefore.length; index++) {
        expect(orderInfoAfter[index].orderExpiry)
        .to.eq(orderInfoBefore[index].orderExpiry.add(extendIntervals*BLOCK_INTERVAL))
        
        if (index <= 3) {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(orderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(orderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }
      
      // Check pool accounting:
      // NOTE: Extend doesn't EVO so LVOB unchanged from 80 (the last resume operation)
      activeBlocks =  0     // Actually 200 - 180, but LVOB=180
      allActiveBlocks = activeBlocks +
                        (180 - 160) +
                        (140 - 120) +
                        (120 - 80) +
                        (60 - 40) +
                        (40 - orderInfoAfter[0].orderStart)
      totalSoldT0 = SALES_RATE_T0.mul(4).mul(allActiveBlocks)
      totalSoldT1 = SALES_RATE_T1.mul(4).mul(allActiveBlocks)
      sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()

      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expectedProceedsT0 = SALES_RATE_T1.mul(4).mul(activeBlocks)
      expectedProceedsT1 = SALES_RATE_T0.mul(4).mul(activeBlocks)
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)
      
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause orders B, D, F, & H at block 220
      //
      await seekToBlock(220)

      const bdfhOrders = [ltTradeB, ltTradeD, ltTradeF, ltTradeH]
      await Promise.all(
        bdfhOrders.map(async (value: LTSwapTxnIngredients) => {
          await poolContract.connect(ltOwner).pauseOrder(value.orderId)
        })
      )
      await mineBlocks()
      
      // Check sales rate
      salesRates = await poolContract.getSalesRates()
      let expectedSaleRateT0 = SALES_RATE_T0.mul(2)
      let expectedSaleRateT1 = SALES_RATE_T1.mul(2)
      expect(salesRates.salesRate0U112).to.eq(expectedSaleRateT0)
      expect(salesRates.salesRate1U112).to.eq(expectedSaleRateT1)

      // Check individual order accounting
      let bdfhActiveBlocks = 220 - 180
      let bdfhAllActiveBlocks = bdfhActiveBlocks +
                                (180 - 160) +
                                (140 - 120) +
                                (120 - 80) +
                                (60 - 40) + 
                                (40 - orderInfoAfter[0].orderStart)
      
      // Update orderBlocks to new expiry after extend at 200:
      orderBlocks = orderInfoAfter[0].orderExpiry - orderInfoAfter[0].orderStart
      let bdfhRemainingBlocks = orderBlocks - bdfhAllActiveBlocks

      expectedProceedsT1 = SALES_RATE_T0.mul(bdfhActiveBlocks)
      expectedDepositT0 = SALES_RATE_T0.mul(bdfhRemainingBlocks)
      
      expectedProceedsT0 = SALES_RATE_T1.mul(bdfhActiveBlocks)
      expectedDepositT1 = SALES_RATE_T1.mul(bdfhRemainingBlocks)

      let bdfhOrderInfoAfter = await Promise.all(bdfhOrders.map(
        async (value: LTSwapTxnIngredients) => { return await poolContract.getOrder(value.orderId) }
      ))
      for (let index = 0; index < bdfhOrderInfoAfter.length; index++) {
        if (index <= 1) {
          expect(bdfhOrderInfoAfter[index].deposit).to.eq(expectedDepositT0)
          expect(bdfhOrderInfoAfter[index].proceeds).to.eq(expectedProceedsT1)
        } else {
          expect(bdfhOrderInfoAfter[index].deposit).to.eq(expectedDepositT1)
          expect(bdfhOrderInfoAfter[index].proceeds).to.eq(expectedProceedsT0)
        }
      }

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw orders B, D, F, & H at block 230
      //
      await seekToBlock(230)

      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      await Promise.all(
        bdfhOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.withdrawLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doWithdraw
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Check the balances to ensure approximately correct amounts:
      // NOTE: we've changed indices and comparisons to a set of 4 addresses, b/c 
      //       only 4 orders are withdrawn.
      for (let index = 0; index < 4; index++) {
        const expectedProceeds = (index <= 1) ?
                                 SALES_RATE_T0.mul(bdfhActiveBlocks) :
                                 SALES_RATE_T1.mul(bdfhActiveBlocks)
        const balChange = balTracker.getDiff(destAddrs[index])
        const actualProceeds = (index <= 1) ? balChange.token1 : balChange.token0

        expect(actualProceeds).to.eq(expectedProceeds)
      }
      
      // Check pool accounting:
      activeBlocks = 230 - 180
      allActiveBlocks = activeBlocks +
                        (180 - 160) +
                        (140 - 120) +
                        (120 - 80) +
                        (60 - 40) +
                        (40 - orderInfoAfter[0].orderStart)

      totalSoldT0 = SALES_RATE_T0.mul(2*bdfhAllActiveBlocks + 2*allActiveBlocks)
      totalSoldT1 = SALES_RATE_T1.mul(2*bdfhAllActiveBlocks + 2*allActiveBlocks)
      sumOrders = sumSwapAmtsFromOrders(orderInfoAfter)
      sumOrders0To1 = sumOrders.token0.sub(totalSoldT0)
      sumOrders1To0 = sumOrders.token1.sub(totalSoldT1)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(sumOrders0To1)
      expect(orders.orders1U112).to.eq(sumOrders1To0)
      
      proceeds = await poolContract.getProceedAmounts()
      expectedProceedsT0 = SALES_RATE_T1.mul(2).mul(activeBlocks)
      expectedProceedsT1 = SALES_RATE_T0.mul(2).mul(activeBlocks)
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)
      
      let withdrawnBlocks = 2*(allActiveBlocks - activeBlocks) +
                            2*(bdfhAllActiveBlocks)
      totalWithdrawnT0 = SALES_RATE_T1.mul(withdrawnBlocks)
      totalWithdrawnT1 = SALES_RATE_T0.mul(withdrawnBlocks)
      expectedVaultResT0 = (INITIAL_LIQUIDITY_0).add(sumOrders.token0.sub(totalWithdrawnT0))
      expectedVaultResT1 = (INITIAL_LIQUIDITY_1).add(sumOrders.token1.sub(totalWithdrawnT1))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel orders C, D, G, & H at block 250
      //
      await seekToBlock(250)

      const cdghOrders = [ltTradeC, ltTradeD, ltTradeG, ltTradeH]
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      await Promise.all(
        cdghOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.cancelLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doCancel
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Check the balances to ensure approximately correct amounts:
      //
      const idxDestOrderC = 0
      const idxDestOrderD = 1
      const idxDestOrderG = 2
      const idxDestOrderH = 3

      const cgActiveBlocks = 250 -180
      const cgAllActiveBlocks = cgActiveBlocks +
                                (180 - 160) +
                                (140 - 120) +
                                (120 - 80) +
                                (60 - 40) + 
                                (40 - orderInfoAfter[0].orderStart)

      const expectedProceedsC = SALES_RATE_T0.mul(cgActiveBlocks)
      const expectedRefundC = SALES_RATE_T0.mul(orderBlocks - cgAllActiveBlocks)
      let balChange = balTracker.getDiff(destAddrs[idxDestOrderC])
      expect(balChange.token0).to.eq(expectedRefundC)
      expect(balChange.token1).to.eq(expectedProceedsC)

      const expectedProceedsG = SALES_RATE_T1.mul(cgActiveBlocks)
      const expectedRefundG = SALES_RATE_T1.mul(orderBlocks - cgAllActiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderG])
      expect(balChange.token1).to.eq(expectedRefundG)
      expect(balChange.token0).to.eq(expectedProceedsG)

      const dhActiveBlocks = 0
      const dhAllActiveBlocks = (220 - 180) +
                                (180 - 160) +
                                (140 - 120) +
                                (120 - 80) +
                                (60 - 40) + 
                                (40 - orderInfoAfter[0].orderStart)

      const expectedProceedsD = SALES_RATE_T0.mul(dhActiveBlocks)
      const expectedRefundD = SALES_RATE_T0.mul(orderBlocks - dhAllActiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderD])
      expect(balChange.token0).to.eq(expectedRefundD)
      expect(balChange.token1).to.eq(expectedProceedsD)

      const expectedProceedsH = SALES_RATE_T1.mul(dhActiveBlocks)
      const expectedRefundH = SALES_RATE_T1.mul(orderBlocks - dhAllActiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderH])
      expect(balChange.token1).to.eq(expectedRefundH)
      expect(balChange.token0).to.eq(expectedProceedsH)

      // Check pool accounting:
      //
      let aeActiveBlocks = 250 - 180
      let aeAllActiveBlocks = aeActiveBlocks +
                              (180 - 160) +
                              (140 - 120) +
                              (120 - 80) +
                              (60 - 40) +
                              (40 - orderInfoAfter[0].orderStart)

      let bfActiveBlocks = 0
      let bfAllActiveBlocks = bfActiveBlocks +
                              (220 - 180) +
                              (180 - 160) +
                              (140 - 120) +
                              (120 - 80) +
                              (60 - 40) +
                              (40 - orderInfoAfter[0].orderStart)

      let abInactiveBlocks = (orderBlocks - aeAllActiveBlocks) +
                             (orderBlocks - bfAllActiveBlocks)
      let efInactiveBlocks = (orderBlocks - aeAllActiveBlocks) +
                             (orderBlocks - bfAllActiveBlocks)
      let expectedOrdersT0 = SALES_RATE_T0.mul(abInactiveBlocks)
      let expectedOrdersT1 = SALES_RATE_T1.mul(efInactiveBlocks)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      expectedProceedsT0 = SALES_RATE_T0.mul(aeActiveBlocks + bfActiveBlocks)
      expectedProceedsT1 = SALES_RATE_T1.mul(aeActiveBlocks + bfActiveBlocks)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)
      
      let refundedBlocksT0 = 0 +                                      // Order A
                             0 +                                      // Order B
                             (orderBlocks - cgAllActiveBlocks) +      // Order C
                             (orderBlocks - dhAllActiveBlocks)        // Order D
      let withdrawnBlocksT1 = (aeAllActiveBlocks - aeActiveBlocks) +  // Order A
                              (bfAllActiveBlocks) +                   // Order B
                              (cgAllActiveBlocks) +                   // Order C
                              (dhAllActiveBlocks)                     // Order D
      // The opposing direction orders mirror the above:
      let refundedBlocksT1 = refundedBlocksT0
      let withdrawnBlocksT0 = withdrawnBlocksT1

      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(4*orderBlocks - (refundedBlocksT0 + withdrawnBlocksT0)))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(4*orderBlocks - (refundedBlocksT1 + withdrawnBlocksT1)))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw orders A, B, E, & F at block expiry
      //
      const orderExpiry = orderInfoAfter[0].orderExpiry
      await seekToBlock(orderExpiry)

      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )

      // Perform the withdraws to the individual addresses:
      //
      const abefOrders = [ltTradeA, ltTradeB, ltTradeE, ltTradeF]
      await Promise.all(
        abefOrders.map(async (value: LTSwapTxnIngredients, index: number) => {
          const { swap, orderId } = value
          const exitRequest = await swap.withdrawLongTerm(
            orderId,
            ltOwner,
            destAddrs[index],
            false       // doWithdraw
          )
          await poolHelper.getVaultContract().connect(ltOwner).exitPool(
            poolHelper.getPoolId(),
            ltOwner.address,
            destAddrs[index].address,
            exitRequest
          )
        })
      )
      await mineBlocks()

      // Save the new balances to perform diffs
      //
      await Promise.all(
        destAddrs.map(async (value: SignerWithAddress) => {
          await balTracker.saveBalance(value)
        })
      )
      
      // Check the balances to ensure approximately correct amounts:
      //
      const idxDestOrderA = 0
      const idxDestOrderB = 1
      const idxDestOrderE = 2
      const idxDestOrderF = 3

      aeActiveBlocks = orderExpiry - 180
      aeAllActiveBlocks = aeActiveBlocks +
                          (180 - 160) +
                          (140 - 120) +
                          (120 - 80) +
                          (60 - 40) +
                          (40 - orderInfoAfter[0].orderStart)
      const aeInactiveBlocks = orderBlocks - aeAllActiveBlocks

      const expectedProceedsA = SALES_RATE_T0.mul(aeActiveBlocks)
      const expectedRefundA = SALES_RATE_T0.mul(aeInactiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderA])
      expect(balChange.token0).to.eq(expectedRefundA)
      expect(balChange.token1).to.eq(expectedProceedsA)
      
      const expectedProceedsE = SALES_RATE_T1.mul(aeActiveBlocks)
      const expectedRefundE = SALES_RATE_T1.mul(aeInactiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderE])
      expect(balChange.token1).to.eq(expectedRefundE)
      expect(balChange.token0).to.eq(expectedProceedsE)

      const bfInactiveBlocks = orderBlocks - bfAllActiveBlocks

      const expectedProceedsB = SALES_RATE_T0.mul(bfActiveBlocks)
      const expectedRefundB = SALES_RATE_T0.mul(bfInactiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderB])
      expect(balChange.token0).to.eq(expectedRefundB)
      expect(balChange.token1).to.eq(expectedProceedsB)
      
      const expectedProceedsF = SALES_RATE_T1.mul(bfActiveBlocks)
      const expectedRefundF = SALES_RATE_T1.mul(bfInactiveBlocks)
      balChange = balTracker.getDiff(destAddrs[idxDestOrderF])
      expect(balChange.token1).to.eq(expectedRefundF)
      expect(balChange.token0).to.eq(expectedProceedsF)
      
      // Check pool accounting:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      expectedProceedsT0 = SALES_RATE_T0.mul(ZERO)
      expectedProceedsT1 = SALES_RATE_T1.mul(ZERO)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)
      
      refundedBlocksT0 = (orderBlocks - aeAllActiveBlocks) +      // Order A
                         (orderBlocks - bfAllActiveBlocks) +      // Order B
                         (orderBlocks - cgAllActiveBlocks) +      // Order C
                         (orderBlocks - dhAllActiveBlocks)        // Order D
      withdrawnBlocksT1 = (aeAllActiveBlocks) +                   // Order A
                          (bfAllActiveBlocks) +                   // Order B
                          (cgAllActiveBlocks) +                   // Order C
                          (dhAllActiveBlocks)                     // Order D
      // The opposing direction orders mirror the above:
      refundedBlocksT1 = refundedBlocksT0
      withdrawnBlocksT0 = withdrawnBlocksT1

      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(4*orderBlocks - (refundedBlocksT0 + withdrawnBlocksT0)))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(4*orderBlocks - (refundedBlocksT1 + withdrawnBlocksT1)))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // The orders are balanced so this will approximately be the same (i.e. same in / out 
      // in both directions, so nearly no change):
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)
    })
  })
})
