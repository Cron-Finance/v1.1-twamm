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
         getScaledProceedsAtBlock, 
         NULL_ADDR} from "./helpers/misc"
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { CronV1PoolExposed } from "typechain/contracts/twault/exposed/CronV1PoolExposed";
import { CronV1PoolFactoryExposed } from "typechain/contracts/twault/exposed/CronV1PoolFactoryExposed";

import { deployCommonContracts } from './common';

// IMPORTANT: The tests in this file are described/designed in a draw.io (PauseResumeExtend.drawio)

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("pool-pause-order-pause-test");

// Equal initial liquidity for both token 0 & 1 of 10M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;

const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000_000n, TOKEN1_DECIMALS);

const SALES_RATE_T0 = scaleUp(10n, TOKEN0_DECIMALS)
const SALES_RATE_T1 = scaleUp(10n, TOKEN1_DECIMALS)



describe("TWAULT (TWAMM Balancer Vault) Pool Pause Order Pause Test Suite", function ()
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

    it ("should refund a paused order in a paused pool (0->1, owner) [PP-T-001]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should refund a paused order in a paused pool (0->1, delegate) [PP-T-002]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltDelegate).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltDelegate).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should refund a paused order in a paused pool (1->0, owner) [PP-T-003]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))

      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
    })
    
    it ("should refund a paused order in a paused pool (1->0, delegate) [PP-T-004]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltDelegate).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltDelegate).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))

      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
    })
    
    it ("should refund a paused cycled order in a paused pool (0->1, owner) [PP-T-005]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })
    
    it ("should refund a paused cycled order in a paused pool (0->1, delegate) [PP-T-006]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })
    
    it ("should refund a paused cycled order in a paused pool (1->0, owner) [PP-T-007]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("should refund a paused cycled order in a paused pool (1->0, delegate) [PP-T-008]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("should cancel after withdraw a paused cycled order in a paused pool (0->1, owner) [PP-T-009]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      let balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(ZERO)  // Refund only happens on cancel
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order deposit ot match the refund:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(expectedRefundA)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(true)

      // Check the pool values:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedRefundA)
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.swapAmt)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 150.
      // Check expected amounts.
      //
      await seekToBlock(150)

      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      expect(balChange.token0).to.eq(expectedRefundA)  // Refund only happens on cancel
      expect(balChange.token1).to.eq(ZERO)  // Already withdrew active blocks

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // No change since pool paused:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
    })
    
    it ("should cancel after withdraw a paused cycled order in a paused pool (0->1, delegate) [PP-T-010]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      let balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(ZERO)  // Refund only happens on cancel
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order deposit ot match the refund:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(expectedRefundA)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(true)

      // Check the pool values:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedRefundA)
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.swapAmt)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 150.
      // Check expected amounts.
      //
      await seekToBlock(150)

      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      expect(balChange.token0).to.eq(expectedRefundA)  // Refund only happens on cancel
      expect(balChange.token1).to.eq(ZERO)  // Already withdrew active blocks

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // No change since pool paused:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
    })
    
    it ("should cancel after withdraw a paused cycled order in a paused pool (1->0, owner) [PP-T-011]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      let balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(ZERO)  // Refund only happens on cancel
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order deposit ot match the refund:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(expectedRefundA)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(true)

      // Check the pool values:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(expectedRefundA)
      expect(orders.orders0U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.swapAmt)
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 150.
      // Check expected amounts.
      //
      await seekToBlock(150)

      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      expect(balChange.token1).to.eq(expectedRefundA)  // Refund only happens on cancel
      expect(balChange.token0).to.eq(ZERO)  // Already withdrew active blocks

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // No change since pool paused:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
    })

    it ("should cancel after withdraw a paused cycled order in a paused pool (1->0, delegate) [PP-T-012]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at block 125.
      // Check expected amounts.
      //
      await seekToBlock(125)

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      let balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(ZERO)  // Refund only happens on cancel
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order deposit ot match the refund:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(expectedRefundA)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(true)

      // Check the pool values:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(expectedRefundA)
      expect(orders.orders0U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.swapAmt)
      let expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel the order at block 150.
      // Check expected amounts.
      //
      await seekToBlock(150)

      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.cancelLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      expect(balChange.token1).to.eq(expectedRefundA)  // Refund only happens on cancel
      expect(balChange.token0).to.eq(ZERO)  // Already withdrew active blocks

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(activeBlocks))
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // No change since pool paused:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
    })

    it ("should withdraw a paused order in a paused pool at expiry (0->1, owner) [PP-T-013]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Seek to the order expiry and withdraw the order
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should withdraw a paused order in a paused pool at expiry (0->1, delegate) [PP-T-014]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Seek to the order expiry and withdraw the order
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should withdraw a paused order in a paused pool at expiry (1->0, owner) [PP-T-015]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Seek to the order expiry and withdraw the order
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("should withdraw a paused order in a paused pool at expiry (1->0, delegate) [PP-T-016]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Seek to the order expiry and withdraw the order
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back 50 blocks of proceeds and 
      // trade blocks minus 50 blocks of deposits:
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const expectedProceedsA = ltTradeA.salesRate.mul(50 - orderStart)
      const expectedRefundA = ltTradeA.salesRate.mul(orderExpiry - 50)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("should withdraw a paused cycled order in a paused pool at expiry (0->1, owner) [PP-T-017]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at expiry.
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should withdraw a paused cycled order in a paused pool at expiry (0->1, delegate) [PP-T-018]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at expiry.
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token0).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token1, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .sub(expectedProceedsA)
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should withdraw a paused cycled order in a paused pool at expiry (1->0, owner) [PP-T-019]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at expiry.
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("should withdraw a paused cycled order in a paused pool at expiry (1->0, delegate) [PP-T-020]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap1To0(intervals, SALES_RATE_T1)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 25:
      //
      await seekToBlock(25)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks()

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 75:
      //
      await seekToBlock(75)

      await poolContract.connect(ltDelegate).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw the order at expiry.
      // Check expected amounts.
      //
      await seekToBlock(Number(orderInfoA.orderExpiry))

      const balTracker = new BalanceTracker(poolHelper)
      await balTracker.saveBalance(ltOwner)
      
      await ltTradeA.swap.withdrawLongTerm(
        ltTradeA.orderId,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const balChange = balTracker.getDiff(ltOwner)

      // Expect the LT trader to get back some proceeds: (25-start) + (75-50) blocks
      // and some deposit: (trade_blocks - 75) + (50 - 25) blocks
      //
      const orderStart = Number(orderInfoA.orderStart)
      const orderExpiry = Number(orderInfoA.orderExpiry)

      const activeBlocks = (75 - 50) + (25 - orderStart)
      const refundBlocks = (orderExpiry - 75) + (50 - 25)
      const expectedProceedsA = ltTradeA.salesRate.mul(activeBlocks)
      const expectedRefundA = ltTradeA.salesRate.mul(refundBlocks)

      expect(balChange.token1).to.eq(expectedRefundA)
      expectWithinMillionths(balChange.token0, expectedProceedsA)

      // Expect the order to be cleared:
      //
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)

      expect(orderInfoA.deposit).to.eq(ZERO)
      expect(orderInfoA.proceeds).to.eq(ZERO)
      expect(orderInfoA.salesRate).to.eq(ZERO)
      expect(orderInfoA.orderStart).to.eq(ZERO)
      expect(orderInfoA.orderExpiry).to.eq(ZERO)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.owner).to.eq(NULL_ADDR)
      expect(orderInfoA.delegate).to.eq(NULL_ADDR)

      // Check the pool values:
      //
      const orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      const proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      const expectedVaultResT0 = INITIAL_LIQUIDITY_0
                                 .sub(expectedProceedsA)
      const expectedVaultResT1 = INITIAL_LIQUIDITY_1
                                 .add(ltTradeA.salesRate.mul(50-orderStart))
      const vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      
      // In this case, TWAMM reserves mimic the vault:
      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedVaultResT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
    })

    it ("shouldn't resume a paused order in a paused pool (owner) [PP-T-021]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to resume the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const txn = await poolContract.connect(ltOwner).resumeOrder(ltTradeA.orderId)
      await mineBlocks();
      
      // The pool is paused, which means that pauseOrder should fail (requires 
      // pool not paused).
      await expectFailure(txn, 'Resume order in paused pool.', 'CFI#100')
      
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(true)
    })
    
    it ("shouldn't resume a paused order in a paused pool (owner) [PP-T-022]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the order at block 50:
      //
      await seekToBlock(50)

      await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks()

      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to pause the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const txn = await poolContract.connect(ltDelegate).resumeOrder(ltTradeA.orderId)
      await mineBlocks();
      
      // The pool is paused, which means that pauseOrder should fail (requires 
      // pool not paused).
      await expectFailure(txn, 'Resume order in paused pool.', 'CFI#100')
      
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(true)
    })

    it ("shouldn't pause an active order in a paused pool (owner) [PP-T-023]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to pause the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const txn = await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks();
      
      // The pool is paused, which means that pauseOrder should fail (requires 
      // pool not paused).
      await expectFailure(txn, 'Pause order in paused pool.', 'CFI#100')
      
      orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
    })

    it ("shouldn't pause an active order in a paused pool (delegate) [PP-T-024]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      let orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to pause the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const txn = await poolContract.connect(ltOwner).pauseOrder(ltTradeA.orderId)
      await mineBlocks();
      
      // The pool is paused, which means that pauseOrder should fail (requires 
      // pool not paused).
      await expectFailure(txn, 'Pause order in paused pool.', 'CFI#100')
      
      orderInfoA = await poolContract.connect(ltDelegate).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
    })

    it ("shouldn't extend an active order in a paused pool (owner) [PP-T-025]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      const origOrderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(origOrderInfoA.paused).to.eq(false)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to pause the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const extendAmt = SALES_RATE_T0.mul(2*BLOCK_INTERVAL)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, ltTradeA.orderId);
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()

      // The pool is paused, which means that extending should fail:
      //
      await expect( balancerVaultContract.connect(ltOwner)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltOwner.address,
                                           ltOwner.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#100')
      
      
      const orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.orderExpiry).to.eq(origOrderInfoA.orderExpiry)
    })

    it ("shouldn't extend an active order in a paused pool (delegate) [PP-T-026]", async function() {
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
      // Issue an order for 2 intervals (3 will be the actual order):
      //
      const intervals = 2
      const ltTradeA = await utb.issueLTSwap0To1(intervals, SALES_RATE_T0)
      await mineBlocks()
      
      const origOrderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(origOrderInfoA.paused).to.eq(false)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause the pool at block 100:
      //
      await seekToBlock(100)

      await poolContract.connect(admin2).setPause(true)
      await mineBlocks()

      expect(await poolContract.isPaused()).to.eq(true)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Try to pause the order at block 125. Expect failure.
      //
      await seekToBlock(125)

      const extendAmt = SALES_RATE_T0.mul(2*BLOCK_INTERVAL)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, ltTradeA.orderId);
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()

      // The pool is paused, which means that extending should fail:
      //
      await expect( balancerVaultContract.connect(ltDelegate)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltDelegate.address,
                                           ltDelegate.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#100')
      
      
      const orderInfoA = await poolContract.connect(ltOwner).getOrder(ltTradeA.orderId)
      expect(orderInfoA.paused).to.eq(false)
      expect(orderInfoA.orderExpiry).to.eq(origOrderInfoA.orderExpiry)
    })
  })
})
