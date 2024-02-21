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
         expectWithinTrillionths } from "./helpers/misc"
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-pause-resume-advanced-simplified");

// Equal initial liquidity for both token 0 & 1 of 10M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000_000n, TOKEN1_DECIMALS);


// NOTE:  Focus of this suite is concurrent orders that have been
//        paused/resumed/cancelled/withdrawn to ensure there are no
//        side-effects introduced by new extend/pause/resume functionality.
//

describe("TWAULT (TWAMM Balancer Vault) Pause & Resume Advanced Simplified Suite", function ()
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
    it ("should allow order pause without affecting other order withdraws (opposing) [PR-AT-001]", async function() {

      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtA = SALES_RATE_T0.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtB = SALES_RATE_T1.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      //
      // Perform periodic withdraws of Order A
      //
      let lastWithdraw = orderA.orderStart
      for (const blockNum of [20, 40, 80]) {
        await seekToBlock(blockNum)
      
        const balPrev = {
          T0: await token0AssetContract.balanceOf(ltOwner.address),
          T1: await token1AssetContract.balanceOf(ltOwner.address)
        }

        const withdrawBlock = await getCurrentBlockNumber()
        await swapA.withdrawLongTerm(
          orderIdA,
          ltDelegate,
          ltOwner
        )

        const balNew = {
          T0: await token0AssetContract.balanceOf(ltOwner.address),
          T1: await token1AssetContract.balanceOf(ltOwner.address)
        }
        const balChange = {
          T0: balNew.T0.sub(balPrev.T0),
          T1: balNew.T1.sub(balPrev.T1)
        }

        // Check the pool accounting:
        //
        let lastBlockNum = await getLastBlockNumber()
        let elapsedBlocksA = lastBlockNum - Number(orderA.orderStart)
        let elapsedBlocksB = lastBlockNum - Number(orderB.orderStart)

        let expectedSalesA = SALES_RATE_T0.mul(elapsedBlocksA)
        let expectedSalesB = SALES_RATE_T1.mul(elapsedBlocksB)
        orders = await poolContract.getOrderAmounts()
        expect(orders.orders0U112, `Reduced by T0 sales at block ${lastBlockNum}`).to.eq(swapAmtA.sub(expectedSalesA))
        expect(orders.orders1U112, `Reduced by T1 sales at block ${lastBlockNum}`).to.eq(swapAmtB.sub(expectedSalesB))
        
        let expectedProceedsB = SALES_RATE_T1.mul(elapsedBlocksB)
        proceeds = await poolContract.getProceedAmounts()

        expect( proceeds.proceeds1U112,
                `Zero proceeds, all withdrawn at block ${lastBlockNum}` )
              .to.eq(ZERO)
        expect( proceeds.proceeds0U112,
                `Increased by T0 ${elapsedBlocksB} sales rates at block ${lastBlockNum}` )
              .to.eq(expectedProceedsB)

        // Check to ensure owner received swap A proceeds:
        //
        let expectedProceedsA = SALES_RATE_T0.mul(lastBlockNum - lastWithdraw)
        expect(balChange.T1).to.eq(expectedProceedsA)
        expect(balChange.T0).to.eq(ZERO)

        lastWithdraw = withdrawBlock
      }

      //
      // Seek to block 100 and pause order B:
      //
      const pauseBlockOrderB = 100
      await seekToBlock(pauseBlockOrderB)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdB)
      
      await mineBlocks()

      orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)
      expect(orderB.paused).to.eq(true)


      //
      // Seek to block 160; withdraw order A and cancel order B
      // NOTE: To check remitted amounts, we withdraw to the owner 
      //       and cancel to the delegate (separates where Balancer 
      //       sends the funds for each Tx so we can inspect them 
      //       individually).
      //
      await seekToBlock(160)

      let ownerBalPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      const delegateBalPrev= {
        T0: await token0AssetContract.balanceOf(ltDelegate.address),
        T1: await token1AssetContract.balanceOf(ltDelegate.address)
      }

      const withdrawBlock = await getCurrentBlockNumber()
      const exitRequest = await swapA.withdrawLongTerm(
        orderIdA,
        ltDelegate,
        ltOwner,
        false     // doWithdraw
      )
      poolHelper.getVaultContract().connect(ltDelegate).exitPool(
        poolHelper.getPoolId(),
        ltDelegate.address,
        ltOwner.address,
        exitRequest
      )

      await swapB.cancelLongTerm(
        orderIdB,
        ltOwner,
        ltDelegate
      )

      let ownerBalNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      let ownerBalChange = {
        T0: ownerBalNew.T0.sub(ownerBalPrev.T0),
        T1: ownerBalNew.T1.sub(ownerBalPrev.T1)
      }

      const delegateBalNew = {
        T0: await token0AssetContract.balanceOf(ltDelegate.address),
        T1: await token1AssetContract.balanceOf(ltDelegate.address)
      }
      const delegateBalChange = {
        T0: delegateBalNew.T0.sub(delegateBalPrev.T0),
        T1: delegateBalNew.T1.sub(delegateBalPrev.T1)
      }
        
      // Check to ensure owner received swap A proceeds:
      //
      let lastBlockNum = await getLastBlockNumber()
      let expectedProceedsA = SALES_RATE_T0.mul(lastBlockNum - lastWithdraw)
      expectWithinMillionths(ownerBalChange.T1, expectedProceedsA)
      expect(ownerBalChange.T0).to.eq(ZERO)

      lastWithdraw = withdrawBlock

      // Check to ensure delegate received proceeds and refund of cancellation of 
      // swap B:
      //
      const expectedProceedsB = SALES_RATE_T1.mul(pauseBlockOrderB - orderB.orderStart)
      const expectedRefundB = SALES_RATE_T1.mul(orderB.orderExpiry - pauseBlockOrderB)
      expectWithinMillionths(delegateBalChange.T0, expectedProceedsB)
      expect(delegateBalChange.T1).to.eq(expectedRefundB)

      // Check that the order pool selling token 1 is empty after cancelling order B:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(ZERO)

      // Check that the proceeds pool of token 0 is empty after canelling order B:
      //
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)

      //
      // Seek to order A expiry block, withdraw order A and check amounts and pool
      // accounting:
      //
      await seekToBlock(orderA.orderExpiry)

      ownerBalPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      await swapA.withdrawLongTerm()
      
      ownerBalNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      ownerBalChange = {
        T0: ownerBalNew.T0.sub(ownerBalPrev.T0),
        T1: ownerBalNew.T1.sub(ownerBalPrev.T1)
      }
      
      // Check to ensure owner received swap A proceeds:
      //
      expectedProceedsA = SALES_RATE_T0.mul(orderA.orderExpiry - lastWithdraw)
      expectWithinMillionths(ownerBalChange.T1, expectedProceedsA, 10)
      expect(ownerBalChange.T0).to.eq(ZERO)
      
      // Check that the order pool selling token 0 is empty after the final withdraw of order A:
      //
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)

      // Check that the proceeds pool of token 1 is empty after the final withdraw of order A:
      //
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      // Check that the vault and TWAMM pool have correct reserves:
      //
      const totalSoldOrderA = SALES_RATE_T0.mul(orderA.orderExpiry - orderA.orderStart)
      const expectedVaultT0 = INITIAL_LIQUIDITY_0
                              .add(totalSoldOrderA)
                              .sub(expectedProceedsB)

      const totalBoughtOrderA = SALES_RATE_T0.mul(orderA.orderExpiry - orderA.orderStart)
      const totalSoldOrderB = SALES_RATE_T1.mul(orderB.orderExpiry - orderB.orderStart)
                                           .sub(expectedRefundB)
      const expectedVaultT1 = INITIAL_LIQUIDITY_1
                              .add(totalSoldOrderB)
                              .sub(totalBoughtOrderA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultT1, 2)

      // The vault and TWAMM reserves should be the same in this case:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedVaultT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultT1, 2)
    })

  it ("should allow order pause without affecting other order withdraws (non-opposing) [PR-AT-002]", async function() {

      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtA = SALES_RATE_T0.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateB = SALES_RATE_T0.mul(2)
      const swapAmtB = salesRateB.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap0To1()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA.add(swapAmtB))
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA.add(swapAmtB))
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0.add(salesRateB))
      expect(salesRates.salesRate1U112).to.eq(ZERO)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      //
      // Withdraw Order B at Block 15, check amounts
      //
      await seekToBlock(15)
      
      await balTracker.saveBalance(ltOwner)

      await swapB.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)

      // Expect owner to get correct amount:
      //
      let lastWithdraw = orderB.orderStart  // Not withdrawn yet
      let lastBlockNum = await getLastBlockNumber()
      let expectedProceedsB = salesRateB.mul(lastBlockNum - lastWithdraw)
      expect(ownerBalChg.token0).to.eq(ZERO)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsB)

      lastWithdraw = lastBlockNum

      //
      // Withdraw Order B at block 20, check amounts
      //
      await seekToBlock(20)

      await balTracker.saveBalance(ltOwner)

      await swapB.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)

      // Expect owner to get correct amount:
      //
      lastBlockNum = await getLastBlockNumber()
      expectedProceedsB = salesRateB.mul(lastBlockNum - lastWithdraw)
      expect(ownerBalChg.token0).to.eq(ZERO)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsB)
      
      lastWithdraw = lastBlockNum

      //
      // Pause order B at block 30, check amounts
      //
      await seekToBlock(30)
      await poolContract.connect(ltOwner).pauseOrder(orderIdB)
      await mineBlocks()

      // Check order B deposit and proceeds to match theoretical amounts:
      //
      orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)
      expect(orderB.paused).to.eq(true)

      let expectedDepositOrderB = salesRateB.mul(orderB.orderExpiry - 30)
      expect(orderB.deposit).to.eq(expectedDepositOrderB)
      
      expectedProceedsB = salesRateB.mul(30 - lastWithdraw)
      expectWithinMillionths(orderB.proceeds, expectedProceedsB)

      // Expect sales rate to be reduced:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      //
      // Pause order A at block 40, check amounts
      //
      await seekToBlock(40)
      await poolContract.connect(ltOwner).pauseOrder(orderIdA)
      await mineBlocks()

      // Check order A deposit and proceeds match theoretical amounts:
      //
      orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      expect(orderA.paused).to.eq(true)

      let expectedDepositOrderA = SALES_RATE_T0.mul(orderA.orderExpiry - 40)
      expect(orderA.deposit).to.eq(expectedDepositOrderA)
      
      let expectedProceedsA = SALES_RATE_T0.mul(40 - orderA.orderStart)
      expectWithinMillionths(orderA.proceeds, expectedProceedsA)
      
      // Expect sales rate to be zero:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      //
      // Resume order B at block 50, check amounts
      //
      await seekToBlock(50)
      await poolContract.connect(ltOwner).resumeOrder(orderIdB)
      await mineBlocks()
      
      // Check order B deposit and proceeds to match theoretical amounts:
      //
      orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)
      expect(orderB.paused).to.eq(false)

      expectedDepositOrderB = salesRateB.mul(50 - 30)
      expect(orderB.deposit).to.eq(expectedDepositOrderB)

      expectedProceedsB = salesRateB.mul(30 - lastWithdraw)
      expectWithinMillionths(orderB.proceeds, expectedProceedsB)
      
      // Expect sales rate to be increased:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateB)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      //
      // Cancel order B at block 70, check amounts
      //
      await seekToBlock(70)

      await balTracker.saveBalance(ltOwner)

      await swapB.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)

      // Expect proceeds since last withdraw, considering pause/resume 
      // and refund of remaining, considering pause/resume:
      //
      const pausedBlocksB = 50 - 30
      lastBlockNum = await getLastBlockNumber()
      expectedProceedsB = salesRateB.mul(lastBlockNum - lastWithdraw - pausedBlocksB)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsB, 2)

      const inactiveBlocksOrderB = (orderB.orderExpiry - 70) + pausedBlocksB
      const expectedRefundB = salesRateB.mul(inactiveBlocksOrderB)
      expect(ownerBalChg.token0).to.eq(expectedRefundB)

      //
      // Resume order A at block 80, check amounts
      //
      await seekToBlock(80)
      await poolContract.connect(ltOwner).resumeOrder(orderIdA)
      await mineBlocks()

      // Check order A deposit and proceeds match theoretical amounts:
      //
      orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      expect(orderA.paused).to.eq(false)

      expectedDepositOrderA = SALES_RATE_T0.mul(80 - 40)
      expect(orderA.deposit).to.eq(expectedDepositOrderA)
      
      expectedProceedsA = SALES_RATE_T0.mul(40 - orderA.orderStart)
      expectWithinMillionths(orderA.proceeds, expectedProceedsA)
      
      // Expect sales rate to be zero:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      //
      // Withdraw order A at expiry, check amounts, check vault and twamm reserves
      //
      await seekToBlock(orderA.orderExpiry)
      
      await balTracker.saveBalance(ltOwner)

      await swapA.withdrawLongTerm()
      
      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)

      // Check proceeds and refund on withdraw match theoretical expectation:
      //
      const pausedBlocksA = 80 - 40
      const activeBlocksOrderA = orderA.orderExpiry - orderA.orderStart - pausedBlocksA
      expectedProceedsA = SALES_RATE_T0.mul(activeBlocksOrderA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA, 4)

      let expectedRefundA = expectedDepositOrderA
      expect(ownerBalChg.token0).to.eq(expectedRefundA)

      // Check expected vault and twamm reserves:
      //
      const activeBlocksOrderB = tradeBlocksB - inactiveBlocksOrderB
      const depositedT0 = (SALES_RATE_T0.mul(activeBlocksOrderA))
                          .add(salesRateB.mul(activeBlocksOrderB))
      const removedT1 = depositedT0
      
      const expectedReservesT0 = INITIAL_LIQUIDITY_0.add(depositedT0)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)

      const expectedReservesT1 = INITIAL_LIQUIDITY_1.sub(removedT1)
      expectWithinTrillionths(vaultReserves.reserve1, expectedReservesT1, 7)

      // The vault and TWAMM reserves should be the same in this case:
      twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedReservesT1, 7)
    })

    it ("should allow order cancel without affecting another order undergoing pause-resume-withdraw (opposing) [PR-AT-003]", async function() {

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtA = SALES_RATE_T0.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtB = SALES_RATE_T1.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0)
      expect(salesRates.salesRate1U112).to.eq(SALES_RATE_T1)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 15
      //
      await seekToBlock(15)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order B at block 20
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(20)
      await swapB.cancelLongTerm(
        orderIdB,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)

      // Check that owner received expected proceeds and refund:
      //
      const activeBlocksB = 20 - orderB.orderStart
      const expectedProceedsB = SALES_RATE_T1.mul(activeBlocksB)
      expectWithinMillionths(ownerBalChg.token0, expectedProceedsB)
      
      const inactiveBlocksB = tradeBlocksB - activeBlocksB
      const expectedRefundB = SALES_RATE_T1.mul(inactiveBlocksB)
      expect(ownerBalChg.token1).to.eq(expectedRefundB)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      let activeBlocksA = 15 - orderA.orderStart
      let expectedOrdersT0 = swapAmtA.sub(SALES_RATE_T0.mul(activeBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      let expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA)
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(activeBlocksB))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)
      
      twammReserves = await poolHelper.getPoolReserves()
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(SALES_RATE_T0.mul(activeBlocksA))
                               .sub(expectedProceedsB)
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(SALES_RATE_T1.mul(activeBlocksB))
                               .sub(expectedProceedsT1)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 100
      //
      await seekToBlock(100)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at expiry
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(orderA.orderExpiry)

      await swapA.withdrawLongTerm(
        orderIdA,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      const pauseBlocksA = 100 - 15
      activeBlocksA = orderA.orderExpiry - orderA.orderStart - pauseBlocksA
      const expectedProceedsA = SALES_RATE_T0.mul(activeBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA, 2)

      const expectedRefundA = SALES_RATE_T0.mul(pauseBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundA)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(activeBlocksA))
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(activeBlocksB))
                           .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 2)
      
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1, 2)
    })

    it ("should allow order cancel without affecting another order undergoing pause-resume-withdraw (non-opposing) [PR-AT-004]", async function() {

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtA = SALES_RATE_T0.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtB = SALES_RATE_T0.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap0To1()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA.add(swapAmtB))
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA.add(swapAmtB))
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0.mul(2))
      expect(salesRates.salesRate1U112).to.eq(ZERO)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 15
      //
      await seekToBlock(15)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order B at block 20
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(20)
      await swapB.cancelLongTerm(
        orderIdB,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)

      // Check that owner received expected proceeds and refund:
      //
      const activeBlocksB = 20 - orderB.orderStart
      const expectedProceedsB = SALES_RATE_T0.mul(activeBlocksB)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsB)
      
      const inactiveBlocksB = tradeBlocksB - activeBlocksB
      const expectedRefundB = SALES_RATE_T0.mul(inactiveBlocksB)
      expect(ownerBalChg.token0).to.eq(expectedRefundB)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      let activeBlocksA = 15 - orderA.orderStart
      let expectedOrdersT0 = swapAmtA.sub(SALES_RATE_T0.mul(activeBlocksA))
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      let expectedProceedsT1 = SALES_RATE_T0.mul(activeBlocksA)
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .add(SALES_RATE_T0.mul(activeBlocksB))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .sub(expectedProceedsB)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      twammReserves = await poolHelper.getPoolReserves()
      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(SALES_RATE_T0.mul(activeBlocksA))
                               .add(SALES_RATE_T0.mul(activeBlocksB))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .sub(expectedProceedsT1)
                               .sub(expectedProceedsB)
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 100
      //
      await seekToBlock(100)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at expiry
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(orderA.orderExpiry)

      await swapA.withdrawLongTerm(
        orderIdA,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      const pauseBlocksA = 100 - 15
      activeBlocksA = orderA.orderExpiry - orderA.orderStart - pauseBlocksA
      const expectedProceedsA = SALES_RATE_T0.mul(activeBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA, 2)

      const expectedRefundA = SALES_RATE_T0.mul(pauseBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundA)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.be.closeTo(ZERO, 1)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(activeBlocksA))
                           .add(SALES_RATE_T1.mul(activeBlocksB))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .sub(expectedProceedsA)
                           .sub(expectedProceedsB)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 2)
      
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1, 2)
    })

    it ("should allow order cancel without affecting another order undergoing pause-withdraw (opposing) [PR-AT-005]", async function() {

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtA = SALES_RATE_T0.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const swapAmtB = SALES_RATE_T1.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(SALES_RATE_T0)
      expect(salesRates.salesRate1U112).to.eq(SALES_RATE_T1)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 20
      //
      await seekToBlock(20)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 30
      //
      await seekToBlock(30)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order A at block 100
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(100)
      await swapA.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)

      // Check that owner received expected proceeds and refund:
      //
      const pauseBlocksA = 30 - 20
      const activeBlocksA = 100 - orderA.orderStart - pauseBlocksA
      const inactiveBlocksA = tradeBlocksA - activeBlocksA

      const expectedProceedsAT1 = SALES_RATE_T0.mul(activeBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsAT1)

      const expectedRefundAT0 = SALES_RATE_T0.mul(inactiveBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundAT0)

      // Check sales rate and order / proceed pools:
      //
      let activeBlocksB = 100 - orderB.orderStart
      let remainingBlocksB = tradeBlocksB - activeBlocksB

      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(SALES_RATE_T1)

      let expectedOrdersT1 = SALES_RATE_T1.mul(remainingBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      let expectedProceedsT0 = SALES_RATE_T1.mul(activeBlocksB)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(activeBlocksA))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(expectedProceedsAT1)

      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)
      
      twammReserves = await poolHelper.getPoolReserves()
      const expectedTwammResT0 = INITIAL_LIQUIDITY_0
                                 .add(SALES_RATE_T0.mul(activeBlocksA))
                                 .sub(SALES_RATE_T1.mul(activeBlocksB))
      const expectedTwammResT1 = INITIAL_LIQUIDITY_1
                                 .add(SALES_RATE_T1.mul(activeBlocksB))
                                 .sub(SALES_RATE_T0.mul(activeBlocksA))
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 110
      //
      await seekToBlock(110)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdB)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order B at expiry
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(orderB.orderExpiry)

      await swapB.withdrawLongTerm(
        orderIdB,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      const pauseBlocksB = orderB.orderExpiry - 110
      activeBlocksB = orderB.orderExpiry - orderB.orderStart - pauseBlocksB
      const inactiveBlocksB = tradeBlocksB - activeBlocksB

      const expectedProceedsBT0 = SALES_RATE_T1.mul(activeBlocksB)
      expectWithinMillionths(ownerBalChg.token0, expectedProceedsBT0)

      const expectedRefundBT1 = SALES_RATE_T1.mul(inactiveBlocksB)
      expect(ownerBalChg.token1).to.eq(expectedRefundBT1)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(SALES_RATE_T0.mul(activeBlocksA))
                           .sub(expectedProceedsBT0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(SALES_RATE_T1.mul(activeBlocksB))
                           .sub(expectedProceedsAT1)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedVaultResT1)
    })

    it ("should allow withdraw of multiple orders undergoing pause/resume (opposing) [PR-AT-006]", async function() {
      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue two DIFFERENT LENGTH orders in the same block:
      //
      const intervalsA = 2
      const intervalsB = 3
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervalsA, BLOCK_INTERVAL, doApprovals)
      const salesRateA = SALES_RATE_T0
      const swapAmtA = salesRateA.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervalsA,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervalsB, BLOCK_INTERVAL, doApprovals)
      const salesRateB = SALES_RATE_T1
      const swapAmtB = salesRateB.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervalsB,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 30
      //
      await seekToBlock(30)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 40
      //
      await seekToBlock(40)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdB)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at block 60
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(60)
      await swapA.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)

      // Check that owner received expected proceeds and refund:
      //
      let pauseBlocksA = 60 - 30
      let activeBlocksA = 30 - orderA.orderStart
      let inactiveBlocksA = tradeBlocksA - activeBlocksA

      let expectedProceedsAT1 = salesRateA.mul(activeBlocksA)
      expect(ownerBalChg.token1).to.eq(expectedProceedsAT1)

      let expectedRefundAT0 = ZERO
      expect(ownerBalChg.token0).to.eq(expectedRefundAT0)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      let pauseBlocksB = 60 - 40
      let activeBlocksB = 40 - orderB.orderStart
      let inactiveBlocksB = tradeBlocksB - activeBlocksB

      let expectedOrdersT0 = salesRateA.mul(inactiveBlocksA)
      let expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      let expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      let expectedProceedsT1 = ZERO
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(expectedProceedsAT1)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(salesRateA.mul(activeBlocksA))
                               .sub(salesRateB.mul(activeBlocksB))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(salesRateB.mul(activeBlocksB))
                               .sub(salesRateA.mul(activeBlocksA))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expect(twammReserves.reserve1).to.eq(expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 70
      //
      await seekToBlock(70)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order B at block 80
      //
      await seekToBlock(80)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdB)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at expiry
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(orderA.orderExpiry)

      await swapA.withdrawLongTerm(
        orderIdA,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      pauseBlocksA = 70 - 30
      activeBlocksA = orderA.orderExpiry - 70

      expectedProceedsAT1 = salesRateA.mul(activeBlocksA)
      expectWithinBillionths(ownerBalChg.token1, expectedProceedsAT1, 10)

      expectedRefundAT0 = salesRateA.mul(pauseBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundAT0)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      pauseBlocksB = 80 - 40
      activeBlocksB = (orderA.orderExpiry - 80) + (40 - orderB.orderStart)
      inactiveBlocksB = tradeBlocksB - activeBlocksB

      expectedOrdersT0 = ZERO
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = ZERO
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expect(proceeds.proceeds1U112).to.eq(expectedProceedsT1)

      // Check that vault balances and twamm reserves are correct:
      //
      const allActiveBlocksA = activeBlocksA + (30 - orderA.orderStart)
      const allInactiveBlocksA = tradeBlocksA - allActiveBlocksA
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(salesRateA.mul(allInactiveBlocksA))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(salesRateA.mul(allActiveBlocksA))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateB.mul(activeBlocksB))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(activeBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order B at expiry
      //
      await balTracker.saveBalance(ltOwner)

      await seekToBlock(orderB.orderExpiry)

      await swapB.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      activeBlocksB = tradeBlocksB - pauseBlocksB

      let expectedProceedsBT0 = salesRateB.mul(activeBlocksB)
      expectWithinMillionths(ownerBalChg.token0, expectedProceedsBT0)

      let expectedRefundBT1 = salesRateB.mul(pauseBlocksB)
      expect(ownerBalChg.token1).to.eq(expectedRefundBT1)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)

      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(salesRateA.mul(allInactiveBlocksA))
                           .sub(expectedProceedsBT0)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(salesRateB.mul(pauseBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(expectedProceedsBT0)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(activeBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
    })
    
    it ("should allow overlapping pause cancel withdraw activity on multiple orders (opposing) [PR-AT-007]", async function() {

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue three orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateA = SALES_RATE_T0
      const swapAmtA = salesRateA.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateB = SALES_RATE_T1
      const swapAmtB = salesRateB.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      const tradeBlocksC = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateC = SALES_RATE_T0.mul(2)
      const swapAmtC = salesRateC.mul(tradeBlocksC)
      const swapC = swapMgr.newSwap0To1()
      const swapObjectsC = await swapC.longTerm(
        swapAmtC,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtC)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtC)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsC
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdC = getNextOrderId()
      swapC.setOrderId(orderIdC)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA.add(swapAmtC))
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA.add(swapAmtC))
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA.add(salesRateC))
      expect(salesRates.salesRate1U112).to.eq(salesRateB)

      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)
      let orderC = await poolContract.connect(ltOwner).getOrder(orderIdC)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 15
      //
      await seekToBlock(15)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateC)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)

      let activeBlocksA = 15 - orderA.orderStart
      let inactiveBlocksA = tradeBlocksA - activeBlocksA
      let activeBlocksB = 15 - orderB.orderStart
      let inactiveBlocksB = tradeBlocksB - activeBlocksB
      let activeBlocksC = 15 - orderC.orderStart
      let inactiveBlocksC = tradeBlocksC - activeBlocksC

      let expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      let expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      let expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      let expectedProceedsT1 = salesRateA.mul(activeBlocksA).add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw orders B & C at block 20
      //
      await seekToBlock(20)
      
      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)    // Withdraw B, to the delegate so 
                                                  // we can independently confirm order proceeds.

      {
        const exitRequest = await swapB.withdrawLongTerm(
          orderIdB,
          ltOwner,
          ltDelegate,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltDelegate.address,
          exitRequest
        )
      }

      await swapC.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)
      let ownerBalChg = balTracker.getDiff(ltOwner)
      let delegateBalChg = balTracker.getDiff(ltDelegate)

      // Check that owner/recipient(s) received expected proceeds and refund:
      //
      activeBlocksB = 20 - orderB.orderStart
      activeBlocksC = 20 - orderC.orderStart
      inactiveBlocksB = tradeBlocksB - activeBlocksB
      inactiveBlocksC = tradeBlocksC - activeBlocksC

      let expectedProceedsB = salesRateB.mul(activeBlocksB)
      expectWithinMillionths(delegateBalChg.token0, expectedProceedsB)
      expect(delegateBalChg.token1).to.eq(ZERO)

      let expectedProceedsC = salesRateC.mul(activeBlocksC)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsC)
      expect(ownerBalChg.token0).to.eq(ZERO)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateC)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)

      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = ZERO
      expectedProceedsT1 = salesRateA.mul(activeBlocksA)
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA.add(swapAmtC))
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(expectedProceedsC)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(salesRateA.mul(activeBlocksA))
                               .add(salesRateC.mul(activeBlocksC))
                               .sub(expectedProceedsB)
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(salesRateB.mul(activeBlocksB))
                               .sub(expectedProceedsC)
                               .sub(salesRateA.mul(activeBlocksA))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 25
      //
      await seekToBlock(25)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdB)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateC)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      activeBlocksB = 25 - 20     // last withdraw at 20
      activeBlocksC = 25 - 20     // last withdraw at 20
      let allActiveBlocksB = 25 - orderB.orderStart
      let allActiveBlocksC = 25 - orderC.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC

      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(activeBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 30
      //
      await seekToBlock(30)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateC.add(salesRateA))
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      activeBlocksC = 30 - 20     // last withdraw at 20
      allActiveBlocksC = 30 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC
      
      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(activeBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order C at block 35
      //
      await seekToBlock(35)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdC)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      let allActiveBlocksA = 35 - 30 + 15 - orderA.orderStart
      activeBlocksC = 35 - 20     // last withdraw at 20
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      allActiveBlocksC = 35 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC
      
      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(allActiveBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
            
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume orders B & C at block 45
      //
      await seekToBlock(45)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdB)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdC)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA.add(salesRateC))
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      activeBlocksA = 45 - 30
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      activeBlocksB = 25 - 20
      allActiveBlocksB = activeBlocksB + 20 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB
      activeBlocksC = 35 - 20
      allActiveBlocksC = activeBlocksC + 20 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC
      
      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(allActiveBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 55
      //
      await seekToBlock(55)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateC)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      activeBlocksA = 55 - 30
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      activeBlocksB = 55 - 45 + 25 - 20
      allActiveBlocksB = activeBlocksB + 20 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB
      activeBlocksC = 55 - 45 + 35 - 20
      allActiveBlocksC = activeBlocksC + 20 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC
      
      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(allActiveBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 65
      //
      await seekToBlock(65)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA.add(salesRateC))
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      activeBlocksA = 55 - 30
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      activeBlocksB = 65 - 45 + 25 - 20
      allActiveBlocksB = activeBlocksB + 20 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB
      activeBlocksC = 65 - 45 + 35 - 20
      allActiveBlocksC = activeBlocksC + 20 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC
      
      expectedOrdersT0 = salesRateA.mul(inactiveBlocksA).add(salesRateC.mul(inactiveBlocksC))
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)

      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateA.mul(allActiveBlocksA)
                           .add(salesRateC.mul(activeBlocksC))
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0, 2)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at expiry
      //
      await seekToBlock(orderA.orderExpiry)
      
      await balTracker.saveBalance(ltOwner)
      
      await swapA.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that owner received expected proceeds and refund:
      //
      let lastBlockNum = await getLastBlockNumber()
      activeBlocksA = lastBlockNum - 65 + 55 - 30
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      activeBlocksB = lastBlockNum - 45 + 25 - 20
      allActiveBlocksB = activeBlocksB + 20 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB
      activeBlocksC = lastBlockNum - 45 + 35 - 20
      allActiveBlocksC = activeBlocksC + 20 - orderC.orderStart
      inactiveBlocksC = tradeBlocksC - allActiveBlocksC

      const expectedProceedsA = salesRateA.mul(allActiveBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA, 5)

      const expectedRefundA = salesRateA.mul(inactiveBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundA)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      expectedOrdersT0 = salesRateC.mul(inactiveBlocksC)
      expectedOrdersT1 = salesRateB.mul(inactiveBlocksB)
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(expectedOrdersT0)
      expect(orders.orders1U112).to.eq(expectedOrdersT1)
      
      expectedProceedsT0 = salesRateB.mul(activeBlocksB)
      expectedProceedsT1 = salesRateC.mul(activeBlocksC)
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, expectedProceedsT0, 5)
      expectWithinMillionths(proceeds.proceeds1U112, expectedProceedsT1, 5)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtC)
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(expectedProceedsC)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 9)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .add(salesRateC.mul(allActiveBlocksC))
                           .sub(salesRateB.mul(allActiveBlocksB))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateC.mul(allActiveBlocksC))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 9)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 25)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw orders B & C after expiry
      //
      await seekToBlock(orderB.orderExpiry.add(100))

      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)    // Withdraw B, to the delegate so 
                                                  // we can independently confirm order proceeds.
      {
        const exitRequest = await swapB.withdrawLongTerm(
          orderIdB,
          ltOwner,
          ltDelegate,
          false       // doWithdraw
        )
        await poolHelper.getVaultContract().connect(ltOwner).exitPool(
          poolHelper.getPoolId(),
          ltOwner.address,
          ltDelegate.address,
          exitRequest
        )
      }

      await swapC.withdrawLongTerm()

      await balTracker.saveBalance(ltOwner)
      await balTracker.saveBalance(ltDelegate)
      ownerBalChg = balTracker.getDiff(ltOwner)
      delegateBalChg = balTracker.getDiff(ltDelegate)
      
      // Check that owner received expected proceeds and refund:
      //
      activeBlocksB = orderB.orderExpiry - 45 + 25 - 20
      expectedProceedsB = salesRateB.mul(activeBlocksB)
      expectWithinMillionths(delegateBalChg.token0, expectedProceedsB, 5)

      const pauseBlocksB = 45 - 25
      const expectedRefundB = salesRateB.mul(pauseBlocksB)
      expect(delegateBalChg.token1).to.eq(expectedRefundB)

      activeBlocksC = orderC.orderExpiry - 45 + 35 - 20
      expectedProceedsC = salesRateC.mul(activeBlocksC)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsC, 5)

      const pauseBlocksC = 45 - 35
      const expectedRefundC = salesRateC.mul(pauseBlocksC)
      expect(ownerBalChg.token0).to.eq(expectedRefundC)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.be.closeTo(ZERO, 8)

      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .add(salesRateC.mul(allActiveBlocksC))
                           .sub(salesRateB.mul(allActiveBlocksB))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateC.mul(allActiveBlocksC))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0, 9)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 25)

      expectedTwammResT0 = expectedVaultResT0
      expectedTwammResT1 = expectedVaultResT1
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0, 9)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 25)
    })

    it ("should allow order pause amidst short term swaps [PR-AT-008]", async function() {

      //
      // Issue an LT order:
      //
      const intervals = 2
      const doApprovals = true

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateA = SALES_RATE_T0
      const swapAmtA = salesRateA.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        true,   /* doSwap */
        true,   /* doApprovals */
        ltDelegate
      )
      const orderIdA = swapA.getOrderId()
      
      // Check the pool accounting:
      //
      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)

      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(ZERO)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(ZERO)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      
      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Perform a swap 1->0 of 10*SR10 at block 15
      //
      await seekToBlock(14)   // We seek to 14 (15-1) b/c the shortTerm method 
                              // mines two blocks:
                              //   - one for approvals
                              //   - one for the swaps
      
      await balTracker.saveBalance(shortTermSam)

      const amount10SR10 = SALES_RATE_T1.mul(10)
      const swapS0 = swapMgr.newSwap1To0()
      await swapS0.shortTerm(amount10SR10, shortTermSam)
      
      await balTracker.saveBalance(shortTermSam)
      let shortTermSamBalChg = balTracker.getDiff(shortTermSam)

      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token0, amount10SR10)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      let activeBlocksA = 15 - orderA.orderStart
      let inactiveBlocksA = tradeBlocksA - activeBlocksA

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(activeBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(amount10SR10)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(salesRateA.mul(activeBlocksA))
                               .sub(amount10SR10)
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .sub(salesRateA.mul(activeBlocksA))
                               .add(amount10SR10)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Perform a swap 1->0 of 10*SR10 at block 25
      // Pause LT Order A
      //
      await seekToBlock(24)   // We seek to 24 (25-1) b/c the shortTerm method 
                              // mines two blocks:
                              //   - one for approvals
                              //   - one for the swaps
      
      await balTracker.saveBalance(shortTermSam)

      const swapS1 = swapMgr.newSwap1To0()
      const swapObjectsS1 = await swapS1.shortTerm(
        amount10SR10,
        shortTermSam,
        false,        // doSwap
        true          // doApprovals
      )

      // Now we're in block 25 b/c of the approval mine implicit in shortTerm call above,
      // do the swap and pause order A:
      //
      {
        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsS1
        await poolHelper.getVaultContract()
                        .connect(shortTermSam)
                        .swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }

      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      await mineBlocks()

      
      await balTracker.saveBalance(shortTermSam)
      shortTermSamBalChg = balTracker.getDiff(shortTermSam)

      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token0, amount10SR10)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      activeBlocksA = 25 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - activeBlocksA

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(activeBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(amount10SR10.mul(2))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10.mul(2))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(activeBlocksA))
                           .sub(amount10SR10.mul(2))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .sub(salesRateA.mul(activeBlocksA))
                           .add(amount10SR10.mul(2))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Perform a swap 1->0 of 10*SR10 at block 35
      //
      await seekToBlock(34)   // We seek to 34 (35-1) b/c the shortTerm method 
                              // mines two blocks:
                              //   - one for approvals
                              //   - one for the swaps
      
      await balTracker.saveBalance(shortTermSam)

      const swapS2 = swapMgr.newSwap1To0()
      await swapS2.shortTerm(amount10SR10, shortTermSam)
      
      await balTracker.saveBalance(shortTermSam)
      shortTermSamBalChg = balTracker.getDiff(shortTermSam)

      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token0, amount10SR10)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(activeBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(amount10SR10.mul(3))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10.mul(3))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(activeBlocksA))
                           .sub(amount10SR10.mul(3))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .sub(salesRateA.mul(activeBlocksA))
                           .add(amount10SR10.mul(3))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume LT Order A at block 40
      //
      await seekToBlock(40)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      activeBlocksA = 0
      let allActiveBlocksA = activeBlocksA + 25 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(allActiveBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(amount10SR10.mul(3))
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10.mul(3))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(amount10SR10.mul(3))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .add(amount10SR10.mul(3))
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Perform a swap 0->1 of 10*SR10 at block 50
      //
      await seekToBlock(49)   // We seek to 49 (50-1) b/c the shortTerm method 
                              // mines two blocks:
                              //   - one for approvals
                              //   - one for the swaps
      
      await balTracker.saveBalance(shortTermSam)

      const swapS3 = swapMgr.newSwap0To1()
      await swapS3.shortTerm(amount10SR10, shortTermSam)
      
      await balTracker.saveBalance(shortTermSam)
      shortTermSamBalChg = balTracker.getDiff(shortTermSam)
      
      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token1, amount10SR10)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      activeBlocksA = 50 - 40
      allActiveBlocksA = activeBlocksA + 25 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(allActiveBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .sub(amount10SR10.mul(3))
                           .add(amount10SR10)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10.mul(3))
                           .sub(amount10SR10)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(amount10SR10.mul(3))
                           .add(amount10SR10)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .add(amount10SR10.mul(3))
                           .sub(amount10SR10)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Withdraw order A at expiry
      //
      await seekToBlock(orderA.orderExpiry)

      await balTracker.saveBalance(ltOwner)
      
      await swapA.withdrawLongTerm(
        orderIdA,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      const ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that lt swapper received expected proceeds and refund:
      //
      activeBlocksA = orderA.orderExpiry - 40
      allActiveBlocksA = activeBlocksA + 25 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA

      const expectedProceedsA = salesRateA.mul(allActiveBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA, 2)

      const expectedRefundA = salesRateA.mul(inactiveBlocksA)
      expectWithinBillionths(ownerBalChg.token0, expectedRefundA)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(amount10SR10.mul(3))
                           .add(amount10SR10)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(amount10SR10.mul(3))
                           .sub(amount10SR10)
                           .sub(salesRateA.mul(allActiveBlocksA))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1, 4)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(amount10SR10.mul(3))
                           .add(amount10SR10)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .add(amount10SR10.mul(3))
                           .sub(amount10SR10)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1, 4)
    })

    it ("should have multiple opposing LT swaps undergoing pause/resume/cancel unaffected by ST swaps [PR-AT-009]", async function() {

      ////////////////////////////////////////////////////////////////////////////
      //
      // Issue two orders in the same block:
      //
      const intervals = 2
      const doApprovals = false

      const tradeBlocksA = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateA = SALES_RATE_T0
      const swapAmtA = salesRateA.mul(tradeBlocksA)
      const swapA = swapMgr.newSwap0To1()
      const swapObjectsA = await swapA.longTerm(
        swapAmtA,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken0Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtA)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtA)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsA
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdA = getNextOrderId()
      swapA.setOrderId(orderIdA)
      
      const tradeBlocksB = await getNumTradeBlocks(intervals, BLOCK_INTERVAL, doApprovals)
      const salesRateB = SALES_RATE_T1.mul(3)
      const swapAmtB = salesRateB.mul(tradeBlocksB)
      const swapB = swapMgr.newSwap1To0()
      const swapObjectsB = await swapB.longTerm(
        swapAmtB,
        intervals,
        ltOwner,
        false,   /* doSwap */
        false,   /* doApprovals */
        ltDelegate
      )
      {
        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        await tokenContract.connect(globalOwner).transfer(ltOwner.address, swapAmtB)
        await tokenContract.connect(ltOwner).approve(vaultContract.address, swapAmtB)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsB
        await balancerVaultContract.connect(ltOwner).swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }
      const orderIdB = getNextOrderId()
      swapB.setOrderId(orderIdB)

      await mineBlocks()
        
      // Check the pool accounting:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(swapAmtA)
      expect(orders.orders1U112).to.eq(swapAmtB)
      
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      
      let twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)
      expect(twammReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      let expectedVaultResT0 = INITIAL_LIQUIDITY_0.add(swapAmtA)
      let expectedVaultResT1 = INITIAL_LIQUIDITY_1.add(swapAmtB)
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedVaultResT0)
      expect(vaultReserves.reserve1).to.eq(expectedVaultResT1)

      let salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)


      let orderA = await poolContract.connect(ltOwner).getOrder(orderIdA)
      let orderB = await poolContract.connect(ltOwner).getOrder(orderIdB)

      const balTracker = new BalanceTracker(poolHelper)

      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order A at block 15
      //
      await seekToBlock(15)
      await poolContract.connect(ltDelegate).pauseOrder(orderIdA)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Perform a swap 0->1 of 20*SR30 at block 20
      //
      await seekToBlock(19)   // We seek to 19 (20-1) b/c the shortTerm method 
                              // mines two blocks:
                              //   - one for approvals
                              //   - one for the swaps
      
      await balTracker.saveBalance(shortTermSam)

      const amount20SR30 = SALES_RATE_T0.mul(3).mul(20)
      const swapS1 = swapMgr.newSwap0To1()
      const swapObjectsS1 = await swapS1.shortTerm(amount20SR30, shortTermSam)

      // NOTE: now in block 20

      await balTracker.saveBalance(shortTermSam)
      let shortTermSamBalChg = balTracker.getDiff(shortTermSam)

      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token1, amount20SR30)
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      let activeBlocksA = 15 - orderA.orderStart
      let inactiveBlocksA = tradeBlocksA - activeBlocksA
      let activeBlocksB = 20 - orderB.orderStart
      let inactiveBlocksB = tradeBlocksB - activeBlocksB

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(salesRateB.mul(inactiveBlocksB))
      
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, salesRateB.mul(activeBlocksB))
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(activeBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .add(amount20SR30)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(amount20SR30)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      let expectedTwammResT0 = INITIAL_LIQUIDITY_0
                               .add(salesRateA.mul(activeBlocksA))
                               .add(amount20SR30)
                               .sub(salesRateB.mul(activeBlocksB))
      let expectedTwammResT1 = INITIAL_LIQUIDITY_1
                               .add(salesRateB.mul(activeBlocksB))
                               .sub(salesRateA.mul(activeBlocksA))
                               .sub(amount20SR30)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Resume order A at block 30
      //
      await seekToBlock(30)
      await poolContract.connect(ltDelegate).resumeOrder(orderIdA)
      await mineBlocks()
      
      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(salesRateB)
      
      activeBlocksA = 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - activeBlocksA
      activeBlocksB = 30 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - activeBlocksB

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(salesRateB.mul(inactiveBlocksB))
      
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, salesRateB.mul(activeBlocksB))
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(activeBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .add(amount20SR30)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(amount20SR30)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(activeBlocksA))
                           .add(amount20SR30)
                           .sub(salesRateB.mul(activeBlocksB))
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(activeBlocksB))
                           .sub(salesRateA.mul(activeBlocksA))
                           .sub(amount20SR30)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Pause order B at block 50
      // Perform a swap 1->0 of 20*SR30 at block 50
      //
      await seekToBlock(50)

      await balTracker.saveBalance(shortTermSam)

      await poolContract.connect(ltDelegate).pauseOrder(orderIdB)
      
      {
        const swapS2 = swapMgr.newSwap1To0()
        const swapObjectsS2 = await swapS2.shortTerm(
          amount20SR30,
          shortTermSam,
          false,        // doSwap
          false         // doApprovals
        )

        const vaultContract = poolHelper.getVaultContract()
        const tokenContract = poolHelper.getToken1Contract()
        const tokenOwner = globalOwner

        await tokenContract.connect(tokenOwner).transfer(shortTermSam.address, amount20SR30)
        await tokenContract.connect(shortTermSam).approve(vaultContract.address, amount20SR30)

        const { swapStruct, fundStruct, limitOutAmt, deadlineSec } = swapObjectsS2
        await vaultContract.connect(shortTermSam)
                           .swap(swapStruct, fundStruct, limitOutAmt, deadlineSec)
      }

      await mineBlocks()
      
      await balTracker.saveBalance(shortTermSam)
      shortTermSamBalChg = balTracker.getDiff(shortTermSam)

      // Check that swapper received expected proceeds for sold amount:
      // NOTE: we don't check the sold amount given b/c they seller doesn't have it (
      //       the shortTerm call transfers them the amount).
      //
      expectWithinMillionths(shortTermSamBalChg.token0, amount20SR30, 2)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      activeBlocksA = 50 - 30 
      let allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA
      activeBlocksB = 50 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - activeBlocksB

      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(salesRateB.mul(inactiveBlocksB))
      
      proceeds = await poolContract.getProceedAmounts()
      expectWithinMillionths(proceeds.proceeds0U112, salesRateB.mul(activeBlocksB))
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(allActiveBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .add(amount20SR30)
                           .sub(amount20SR30)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(swapAmtB)
                           .sub(amount20SR30)
                           .add(amount20SR30)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateB.mul(activeBlocksB))
                           .add(amount20SR30)
                           .sub(amount20SR30)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(activeBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(amount20SR30)
                           .add(amount20SR30)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order B at block 80
      //
      await seekToBlock(80)

      await balTracker.saveBalance(ltOwner)

      await swapB.cancelLongTerm(
        orderIdB,
        ltDelegate,
        ltOwner
      )

      await balTracker.saveBalance(ltOwner)
      let ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that LT swapper received expected proceeds and refund:
      //
      activeBlocksA = 80 - 30 
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA

      activeBlocksB = 0
      let allActiveBlocksB = activeBlocksB + 50 - orderB.orderStart
      inactiveBlocksB = tradeBlocksB - allActiveBlocksB

      const expectedProceedsB = salesRateB.mul(allActiveBlocksB)
      expectWithinMillionths(ownerBalChg.token0, expectedProceedsB)

      const expectedRefundB = salesRateB.mul(inactiveBlocksB)
      expect(ownerBalChg.token1).to.eq(expectedRefundB)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(salesRateA)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(salesRateA.mul(inactiveBlocksA))
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.be.closeTo(ZERO, 4)
      expectWithinMillionths(proceeds.proceeds1U112, salesRateA.mul(allActiveBlocksA))
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(swapAmtA)
                           .add(amount20SR30)
                           .sub(amount20SR30)
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(amount20SR30)
                           .add(amount20SR30)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateB.mul(allActiveBlocksB))
                           .add(amount20SR30)
                           .sub(amount20SR30)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(amount20SR30)
                           .add(amount20SR30)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
      
      ////////////////////////////////////////////////////////////////////////////
      //
      // Cancel order A at block 90
      //
      await seekToBlock(90)

      await balTracker.saveBalance(ltOwner)

      await swapA.cancelLongTerm()

      await balTracker.saveBalance(ltOwner)
      ownerBalChg = balTracker.getDiff(ltOwner)
      
      // Check that LT swapper received expected proceeds and refund:
      //
      activeBlocksA = 90 - 30 
      allActiveBlocksA = activeBlocksA + 15 - orderA.orderStart
      inactiveBlocksA = tradeBlocksA - allActiveBlocksA

      const expectedProceedsA = salesRateA.mul(allActiveBlocksA)
      expectWithinMillionths(ownerBalChg.token1, expectedProceedsA)

      const expectedRefundA = salesRateA.mul(inactiveBlocksA)
      expect(ownerBalChg.token0).to.eq(expectedRefundA)

      // Check sales rate and order / proceed pools:
      //
      salesRates = await poolContract.getSalesRates()
      expect(salesRates.salesRate0U112).to.eq(ZERO)
      expect(salesRates.salesRate1U112).to.eq(ZERO)
      
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(ZERO)
      expect(orders.orders1U112).to.eq(ZERO)
      
      proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.be.closeTo(ZERO, 4)
      expect(proceeds.proceeds1U112).to.be.closeTo(ZERO, 0)
      
      // Check that vault balances and twamm reserves are correct:
      //
      expectedVaultResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .add(amount20SR30)
                           .sub(amount20SR30)
                           .sub(expectedProceedsB)
      expectedVaultResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(amount20SR30)
                           .add(amount20SR30)
                           .sub(expectedProceedsA)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expectWithinTrillionths(vaultReserves.reserve0, expectedVaultResT0)
      expectWithinTrillionths(vaultReserves.reserve1, expectedVaultResT1)

      expectedTwammResT0 = INITIAL_LIQUIDITY_0
                           .add(salesRateA.mul(allActiveBlocksA))
                           .sub(salesRateB.mul(allActiveBlocksB))
                           .add(amount20SR30)
                           .sub(amount20SR30)
      expectedTwammResT1 = INITIAL_LIQUIDITY_1
                           .add(salesRateB.mul(allActiveBlocksB))
                           .sub(salesRateA.mul(allActiveBlocksA))
                           .sub(amount20SR30)
                           .add(amount20SR30)
      twammReserves = await poolHelper.getPoolReserves()
      expectWithinTrillionths(twammReserves.reserve0, expectedTwammResT0)
      expectWithinTrillionths(twammReserves.reserve1, expectedTwammResT1)
    })
  })
})
