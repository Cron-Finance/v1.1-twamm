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
         getCurrentBlockNumber,
         seekToBlock,
         mineBlocks,
         dumpContractAccounting,
         ZERO,
         JSONBI } from "./helpers/misc"      
import { ParamType, PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-extend-basic-simplified");

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

describe("TWAULT (TWAMM Balancer Vault) Extend Basic Simplified Suite", function ()
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

  describe("LT Order Extend Basic Tests", function() {
    it ("should allow LT order extended 2 intervals (owner, withdraw @ expiry) [E-Q-001]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should allow LT order extended 2 intervals (owner, withdraw after expiry) [E-Q-002]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry.add(20))
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })
    
    it ("should allow LT order extended 2 intervals (delegate, withdraw @ expiry) [E-Q-003]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals as the delegate:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should allow LT order extended 2 intervals (delegate, withdraw after expiry) [E-Q-004]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals as the delegate:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry.add(50))
      
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should allow LT order extended 2 intervals (1->0, owner, withdraw @ expiry) [E-Q-005]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry.add(50))
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should allow LT order extended 2 intervals (1->0, delegate, withdraw @ expiry) [E-Q-006]", async function() {
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

      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of two intervals as the delegate:
      //
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry.add(50))
      
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should allow LT order extended before multiple withdraws (owner, withdraw @ expiry) [E-Q-007]", async function() {
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

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      let saleBlocks = 50 - orderInfoAfter.orderStart
      let expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })
    
    it ("should allow LT order extended before multiple withdraws (delegate, withdraw @ expiry) [E-Q-008]", async function() {
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

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(20)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltOwner.address,            // Variation: try owner as receiver
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      let saleBlocks = 50 - orderInfoAfter.orderStart
      let expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should allow LT order extended before multiple withdraws (1->0, owner, withdraw @ expiry) [E-Q-009]", async function() {
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

      // Issue an order extension of two intervals at block 40:
      //
      await seekToBlock(40)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T10 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      let saleBlocks = 50 - orderInfoAfter.orderStart
      let expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should allow LT order extended before multiple withdraws (1->0, delegate, withdraw @ expiry) [E-Q-010]", async function() {
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

      // Issue an order extension of two intervals at block 40:
      //
      await seekToBlock(40)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T10 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      let saleBlocks = 50 - orderInfoAfter.orderStart
      let expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm(
        orderId,
        ltDelegate,
        ltOwner
      )
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should allow LT order extended after mid-order withdraw (owner, withdraw @ expiry) [E-Q-011]", async function() {
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

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const orderId = swap.getOrderId()
      const orderInfo= await poolContract.connect(ltOwner).getOrder(orderId)
      let saleBlocks = 50 - orderInfo.orderStart
      let expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(80)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 3 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 3*OBI
      //   - Expect orders T0 to increase by 3*OBI*SR100
      //   - Expect vault reserves T0 to increase by 3*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO was run at withdraw, expect orders to reflect total amount, minus EVO sold amt:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks - saleBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      let expectedReservesT1 = INITIAL_LIQUIDITY_1.sub(expectedProceeds)
      let slipTolerance = (expectedReservesT1.mul(1)).div(1_000_000_000_000)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, slipTolerance)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T0.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${saleBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const twoThousandthsSlip = (SALES_RATE_T0.mul(2)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandthsSlip)
    })

    it ("should allow LT order extended after mid-order withdraw (owner, withdraw @ expiry) [E-Q-012]", async function() {
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

      // Mine to block 50 and withdraw, check pool accounting:
      //
      await seekToBlock(50)
      
      let balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      let balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      
      let balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }
      
      let expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const orderId = swap.getOrderId()
      const orderInfo= await poolContract.connect(ltOwner).getOrder(orderId)
      let saleBlocks = 50 - orderInfo.orderStart
      let expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      let fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(80)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const extendBlocks = 3 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 3*OBI
      //   - Expect orders T1 to increase by 3*OBI*SR100
      //   - Expect vault reserves T1 to increase by 3*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO was run at withdraw, expect orders to reflect total amount, minus EVO sold amt:
      //
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks - saleBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      let expectedReservesT0 = INITIAL_LIQUIDITY_0.sub(expectedProceeds)
      let slipTolerance = (expectedReservesT0.mul(1)).div(1_000_000_000_000)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, slipTolerance)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
      balNew = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }

      // Check amounts received:
      //
      balChange = {
        T0: balNew.T0.sub(balPrev.T0),
        T1: balNew.T1.sub(balPrev.T1)
      }

      expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      saleBlocks = extendedTradeBlocks - saleBlocks
      expectedProceeds = SALES_RATE_T1.mul(saleBlocks)
      fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${saleBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const twoThousandthsSlip = (SALES_RATE_T1.mul(2)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, twoThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, twoThousandthsSlip)
    })

    it ("should allow extended LT order cancellation (owner) [E-Q-013]", async function() {
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

      await seekToBlock(30)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of 4 intervals:
      //
      const extendBlocks = 4 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 4*OBI
      //   - Expect orders T0 to increase by 4*OBI*SR100
      //   - Expect vault reserves T0 to increase by 4*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Cancel the order at block 100, check pool accounting:
      //
      const cancelBlock = 100
      await seekToBlock(cancelBlock)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.cancelLongTerm()
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

      const soldBlocks = cancelBlock - orderInfoAfter.orderStart
      const unsoldBlocks = extendedTradeBlocks - soldBlocks
      const expectedProceeds = SALES_RATE_T0.mul(soldBlocks)
      const expectedRefund = SALES_RATE_T0.mul(unsoldBlocks)

      expect(balChange.T0, `Should get ${unsoldBlocks} sales rates T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${cancelBlock} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(soldBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(soldBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })
    
    it ("should allow extended LT order cancellation (delegate) [E-Q-014]", async function() {
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

      await seekToBlock(30)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of 4 intervals:
      //
      const extendBlocks = 4 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 4*OBI
      //   - Expect orders T0 to increase by 4*OBI*SR100
      //   - Expect vault reserves T0 to increase by 4*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Cancel the order at block 100, check pool accounting:
      //
      const cancelBlock = 100
      await seekToBlock(cancelBlock)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.cancelLongTerm(
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

      const soldBlocks = cancelBlock - orderInfoAfter.orderStart
      const unsoldBlocks = extendedTradeBlocks - soldBlocks
      const expectedProceeds = SALES_RATE_T0.mul(soldBlocks)
      const expectedRefund = SALES_RATE_T0.mul(unsoldBlocks)

      expect(balChange.T0, `Should get ${unsoldBlocks} sales rates T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${cancelBlock} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(soldBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(soldBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should allow extended LT order cancellation (owner, 1->0) [E-Q-015]", async function() {
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

      await seekToBlock(50)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of 5 intervals:
      //
      const extendBlocks = 5 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 5*OBI
      //   - Expect orders T1 to increase by 5*OBI*SR100
      //   - Expect vault reserves T1 to increase by 5*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Cancel the order at block 100, check pool accounting:
      //
      const cancelBlock = 100
      await seekToBlock(cancelBlock)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.cancelLongTerm()
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

      const soldBlocks = cancelBlock - orderInfoAfter.orderStart
      const unsoldBlocks = extendedTradeBlocks - soldBlocks
      const expectedProceeds = SALES_RATE_T1.mul(soldBlocks)
      const expectedRefund = SALES_RATE_T1.mul(unsoldBlocks)

      expect(balChange.T1, `Should get ${unsoldBlocks} sales rates T1 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${cancelBlock} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T0.mul(soldBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                    .add(SALES_RATE_T0.mul(soldBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should allow extended LT order cancellation (delegate, 1->0) [E-Q-016]", async function() {
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

      await seekToBlock(50)

      const orderId = swap.getOrderId()
      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      // Issue an order extension of 5 intervals:
      //
      const extendBlocks = 5 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 5*OBI
      //   - Expect orders T1 to increase by 5*OBI*SR100
      //   - Expect vault reserves T1 to increase by 5*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(extendedTradeBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Cancel the order at block 100, check pool accounting:
      //
      const cancelBlock = 100
      await seekToBlock(cancelBlock)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.cancelLongTerm(
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

      const soldBlocks = cancelBlock - orderInfoAfter.orderStart
      const unsoldBlocks = extendedTradeBlocks - soldBlocks
      const expectedProceeds = SALES_RATE_T1.mul(soldBlocks)
      const expectedRefund = SALES_RATE_T1.mul(unsoldBlocks)

      expect(balChange.T1, `Should get ${unsoldBlocks} sales rates T1 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${cancelBlock} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T0.mul(soldBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                    .add(SALES_RATE_T0.mul(soldBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })
    
    it ("should allow multiple LT order extensions (owner) [E-Q-017]", async function() {
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

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(20)

      const orderId = swap.getOrderId()
      let orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      let extendBlocks = 2 * BLOCK_INTERVAL
      let extendAmt = SALES_RATE_T0.mul(extendBlocks)
      let extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      let extendedTradeBlocks = tradeBlocks + extendBlocks

      let orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Issue an order extension of another two intervals at block 140:
      //
      await seekToBlock(140)

      orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      extendBlocks = 2 * BLOCK_INTERVAL
      extendAmt = SALES_RATE_T0.mul(extendBlocks)
      extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      extendedTradeBlocks += extendBlocks

      orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const twoThousandsSlip = (SALES_RATE_T0.mul(2)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandsSlip)
    })

    it ("should allow multiple LT order extensions (delegate) [E-Q-018]", async function() {
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

      // Issue an order extension of two intervals at block 20:
      //
      await seekToBlock(20)

      const orderId = swap.getOrderId()
      let orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      let extendBlocks = 2 * BLOCK_INTERVAL
      let extendAmt = SALES_RATE_T0.mul(extendBlocks)
      let extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      let extendedTradeBlocks = tradeBlocks + extendBlocks

      let orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Issue an order extension of another two intervals at block 140:
      //
      await seekToBlock(140)

      orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      extendBlocks = 2 * BLOCK_INTERVAL
      extendAmt = SALES_RATE_T0.mul(extendBlocks)
      extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      extendedTradeBlocks += extendBlocks

      orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      // EVO not yet run, expect orders to reflect total amount:
      orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(extendedTradeBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      const expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      let proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const twoThousandsSlip = (SALES_RATE_T0.mul(2)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, twoThousandsSlip)
    })

    it ("should extend paused LT order using remaining deposit (owner) [E-Q-019]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks - pausedBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using remaining deposit (delegate) [E-Q-020]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks - pausedBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using remaining deposit (owner) [E-Q-021]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 65
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order:
      //
      const resumeBlock = 125
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks - pausedBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(untradedOrderBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T1.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T1.mul(1)).div(10000)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should extend paused LT order using remaining deposit (delegate) [E-Q-022]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 65
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order:
      //
      const resumeBlock = 125
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T1.mul(extendBlocks - pausedBlocks)
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token1Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T1 to increase by 2*OBI*SR100
      //   - Expect vault reserves T1 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T1 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(untradedOrderBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T1.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T1.mul(1)).div(10000)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })
    
    it ("should extend paused LT order ignoring remaining deposit (owner) [E-Q-023]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks.add(pausedBlocks)))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks + pausedBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = SALES_RATE_T0.mul(pausedBlocks)
      expect(balChange.T0, `Should get ${pausedBlocks} sales rates T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order ignoring remaining deposit (delegate) [E-Q-024]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks.add(pausedBlocks)))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks + pausedBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = SALES_RATE_T0.mul(pausedBlocks)
      expect(balChange.T0, `Should get ${pausedBlocks} sales rates T0 back`).to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    }) 

    it ("should extend paused LT order ignoring remaining deposit (owner) [E-Q-025]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks - pausedBlocks - 1)
      const actualExtendBlocks = BLOCK_INTERVAL
      const remainingDeposit = SALES_RATE_T0.mul(BLOCK_INTERVAL - 1)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 1*OBI
      //   - Expect orders T0 to increase by (2*OBI-1)*SR100
      //   - Expect vault reserves T0 to increase by (2*OBI-1)*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + actualExtendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(actualExtendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(remainingDeposit.add(SALES_RATE_T0.mul(untradedOrderBlocks)))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(remainingDeposit.add(SALES_RATE_T0.mul(extendedTradeBlocks)))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      expect(balChange.T0, `Should get remaining deposit T0 back`).to.eq(remainingDeposit)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order ignoring remaining deposit (delegate) [E-Q-026]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order at block 50:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order at block 100:
      //
      const resumeBlock = 100
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 2 intervals at block 120, using the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(120)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = 2 * BLOCK_INTERVAL
      const extendAmt = SALES_RATE_T0.mul(extendBlocks - pausedBlocks - 1)
      const actualExtendBlocks = BLOCK_INTERVAL
      const remainingDeposit = SALES_RATE_T0.mul(BLOCK_INTERVAL - 1)
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 1*OBI
      //   - Expect orders T0 to increase by (2*OBI-1)*SR100
      //   - Expect vault reserves T0 to increase by (2*OBI-1)*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + actualExtendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(actualExtendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(remainingDeposit.add(SALES_RATE_T0.mul(untradedOrderBlocks)))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(remainingDeposit.add(SALES_RATE_T0.mul(extendedTradeBlocks)))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      expect(balChange.T0, `Should get remaining deposit T0 back`).to.eq(remainingDeposit)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (owner) [E-Q-027]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order at block 125:
      //
      const resumeBlock = 125
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (delegate) [E-Q-028]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order at block 125:
      //
      const resumeBlock = 125
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq(SALES_RATE_T0.mul(untradedOrderBlocks))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T0, 'Should get no T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (owner, 1->0) [E-Q-029]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 30
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order at block 105:
      //
      const resumeBlock = 105
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(149)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token1AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(untradedOrderBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T1.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T1.mul(1)).div(10000)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (delegate, 1->0) [E-Q-030]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 30
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order at block 105:
      //
      const resumeBlock = 105
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(149)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq(SALES_RATE_T1.mul(untradedOrderBlocks))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T1.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T1.mul(1)).div(10000)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      const expectedRefund = ZERO
      expect(balChange.T1, 'Should get no T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders1U112, 'T1 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds0U112, 'T0 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (owner) [E-Q-031]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltOwner).pauseOrder(orderId)

      // Resume order:
      //
      const resumeBlock = 130
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltOwner).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, extendAmt);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltOwner)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltOwner.address,
                                   ltOwner.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const expectedRefund = SALES_RATE_T0.mul(resumeBlock - pauseBlock - BLOCK_INTERVAL)

      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders0U112).to.eq((SALES_RATE_T0.mul(untradedOrderBlocks)).add(expectedRefund))
      expect(orders.orders1U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T0.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds0U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T0.mul(1)).div(10000)
      expect(proceeds.proceeds1U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT0 = INITIAL_LIQUIDITY_0.add(SALES_RATE_T0.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0.add(expectedRefund))
      expect(vaultReserves.reserve1).to.eq(INITIAL_LIQUIDITY_1)

      expect(orderInfoAfter.deposit).to.eq(expectedRefund)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
      const balPrev = {
        T0: await token0AssetContract.balanceOf(ltOwner.address),
        T1: await token1AssetContract.balanceOf(ltOwner.address)
      }
      await swap.withdrawLongTerm()
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

      expect(balChange.T0, 'Should get some T0 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T0.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T1, `Should get ~${extendedTradeBlocks} sales rates of T1 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .add(SALES_RATE_T0.mul(extendedTradeBlocks))
      const expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                          .sub(SALES_RATE_T0.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T0.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve0).to.eq(expectedReservesT0)
      expect(vaultReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve0).to.eq(expectedReservesT0)
      expect(twammReserves.reserve1).to.be.closeTo(expectedReservesT1, oneThousandthsSlip)
    })

    it ("should extend paused LT order using ONLY remaining deposit (delegate, 1->0) [E-Q-032]", async function() {
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
      const orderId = swap.getOrderId()

      // Pause order:
      //
      const pauseBlock = 50
      await seekToBlock(pauseBlock)
      await poolContract.connect(ltDelegate).pauseOrder(orderId)

      // Resume order:
      //
      const resumeBlock = 130
      await seekToBlock(resumeBlock)
      await poolContract.connect(ltDelegate).resumeOrder(orderId)

      // Extend the order 1 intervals using ONLY the remaining deposit from 
      // the pause/resume cycle:
      //
      await seekToBlock(140)

      const orderInfoBefore = await poolContract.connect(ltOwner).getOrder(orderId)

      const pausedBlocks = resumeBlock - pauseBlock
      const extendBlocks = BLOCK_INTERVAL
      const extendAmt = ZERO
      const extendObjects = await poolHelper.getExtendObjects(ZERO, extendAmt, swap.getOrderId());
      await token1AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, extendAmt);
      await token1AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);

      await balancerVaultContract.connect(ltDelegate)
                                 .joinPool(
                                   poolHelper.getPoolId(),
                                   ltDelegate.address,
                                   ltDelegate.address,
                                   extendObjects.joinStruct
                                 )
      await mineBlocks()

      // Check LVOB:
      //
      const lvob = await poolContract.getLastVirtualOrderBlock()
      expect(lvob, `Should be the block that ran order resume (${resumeBlock})`).to.eq(resumeBlock)

      // Check pool accounting and order:
      //
      //   - Expect order expiry extend 2*OBI
      //   - Expect orders T0 to increase by 2*OBI*SR100
      //   - Expect vault reserves T0 to increase by 2*OBI*SR100
      //   - Expect twamm reserves T0 to be unchanged (except SR100)
      //   - Expect unchanged LVOB
      //
      const extendedTradeBlocks = tradeBlocks + extendBlocks - pausedBlocks

      const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(orderId)
      expect(orderInfoAfter.orderExpiry).to.eq(orderInfoBefore.orderExpiry.add(extendBlocks))
      
      const expectedRefund = SALES_RATE_T1.mul(resumeBlock - pauseBlock - BLOCK_INTERVAL)

      const untradedOrderBlocks = orderInfoAfter.orderExpiry.sub(resumeBlock)
      // EVO run on resume, expect orders to reflect total amount:
      let orders = await poolContract.getOrderAmounts()
      expect(orders.orders1U112).to.eq((SALES_RATE_T1.mul(untradedOrderBlocks)).add(expectedRefund))
      expect(orders.orders0U112).to.eq(ZERO)

      let expectedProceeds = SALES_RATE_T1.mul(pauseBlock - orderInfoAfter.orderStart)
      let proceeds = await poolContract.getProceedAmounts()
      expect(proceeds.proceeds1U112).to.eq(ZERO)
      const oneTenThousandthsSlip = (SALES_RATE_T1.mul(1)).div(10000)
      expect(proceeds.proceeds0U112).to.be.closeTo(expectedProceeds, oneTenThousandthsSlip)

      let expectedReservesT1 = INITIAL_LIQUIDITY_1.add(SALES_RATE_T1.mul(extendedTradeBlocks))
      let vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1.add(expectedRefund))
      expect(vaultReserves.reserve0).to.eq(INITIAL_LIQUIDITY_0)

      expect(orderInfoAfter.deposit).to.eq(expectedRefund)

      // Mine to end of order and withdraw, check pool accounting:
      //
      await seekToBlock(orderInfoAfter.orderExpiry)
      
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

      expect(balChange.T1, 'Should get some T1 back').to.eq(expectedRefund)

      // Note: Approximately because we're not considering slippage since 
      //       the pool is so large (minus 1 for the pause)
      expectedProceeds = SALES_RATE_T1.mul(extendedTradeBlocks)
      const fiveMillionthsSlip = (expectedProceeds.mul(5)).div(1000000)
      expect(balChange.T0, `Should get ~${extendedTradeBlocks} sales rates of T0 proceeds`)
            .to.be.closeTo(expectedProceeds, fiveMillionthsSlip)

      // Check pool balances:
      //
      //   - Orders & proceeds should be nearly zero:
      //
      orders = await poolContract.getOrderAmounts()
      proceeds = await poolContract.getProceedAmounts()
      expect(orders.orders0U112, 'T0 orders should be zero').to.eq(ZERO)
      expect(proceeds.proceeds1U112, 'T1 proceeds should be zero').to.eq(ZERO)
      //
      //   - Vault & TWAMM reserves should essentially be modified in 
      //     whole by the order (T1 differing slightly due to CPAMM slip),
      //     minus the paused block:
      //
      const expectedReservesT0 = BigNumber.from(INITIAL_LIQUIDITY_0)
                                          .sub(SALES_RATE_T1.mul(extendedTradeBlocks))
      expectedReservesT1 = BigNumber.from(INITIAL_LIQUIDITY_1)
                                    .add(SALES_RATE_T1.mul(extendedTradeBlocks))

      const oneThousandthsSlip = (SALES_RATE_T1.mul(1)).div(1000)
      vaultReserves = await poolHelper.getVaultPoolReserves()
      expect(vaultReserves.reserve1).to.eq(expectedReservesT1)
      expect(vaultReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)

      const twammReserves = await poolHelper.getPoolReserves()
      expect(twammReserves.reserve1).to.eq(expectedReservesT1)
      expect(twammReserves.reserve0).to.be.closeTo(expectedReservesT0, oneThousandthsSlip)
    })
  })
})
