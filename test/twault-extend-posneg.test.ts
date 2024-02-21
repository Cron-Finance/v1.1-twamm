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
         ZERO } from "./helpers/misc"
import { PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

const hre = require('hardhat')

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-extend-posneg");
log.setLevel("DEBUG")

// Equal initial liquidity for both token 0 & 1 of 10k tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(10_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(10_000n, TOKEN1_DECIMALS);


describe("TWAULT (TWAMM Balancer Vault) Extend Positive Negative Suite", function ()
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
    poolModel = result.poolModel
    token0AssetContract = result.token0AssetContract
    token1AssetContract = result.token1AssetContract
    balancerVaultContract = result.balancerVaultContract
    poolContract = result.poolContract
    arbitrageListContract = result.arbitrageListContract
    arbitrageListContract2 = result.arbitrageListContract2

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
  })


  afterEach(function () {
    restoreSnapshot(waffle.provider);
  })


  describe("LT Order Extend Negative Tests", function() {
    it ("should not extend a non existent order [E-N-001]", async function() {
      const NON_EXISTANT_ORDER_ID = 255
      
      // Construct an LT extend transaction:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, NON_EXISTANT_ORDER_ID);
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, amt10kT0);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()

      // Issue the transaction:
      //
      await expect( balancerVaultContract.connect(ltOwner)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltOwner.address,
                                           ltOwner.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#008')
    })
    
    it ("should not extend another account's order [E-N-002]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)

      // Construct an LT Extend transaction (by a different account than the
      // owner):
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(arbitrageur1.address, amt10kT0);
      await token0AssetContract.connect(arbitrageur1)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()

      // Issue the transaction and expect failure:
      //
      await expect( balancerVaultContract.connect(arbitrageur1)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           arbitrageur1.address,
                                           arbitrageur1.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#008')
    })
    
    it ("should not extend an expired order (owner) [E-N-003]", async function() {
      // Issue an LT swap:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      // Construct an LT Extend transaction:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, amt10kT0);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()
      
      // Mine the order to expiry and confirm:
      //
      let blockNumber = await getLastBlockNumber()

      const orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const expiryBlock = orderInfo.orderExpiry
      const blocksToMine = expiryBlock - blockNumber
      await mineBlocks(blocksToMine)
      
      blockNumber = await getLastBlockNumber()
      expect(blockNumber).to.eq(expiryBlock)

      // Issue the extend transaction and expect failure:
      //
      await expect( balancerVaultContract.connect(ltOwner)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltOwner.address,
                                           ltOwner.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#229')
    })
    
    it ("should not extend an expired order (delegate) [E-N-004]", async function() {
      // Issue an LT swap:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      // Construct an LT Extend transaction:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, amt10kT0);
      await token0AssetContract.connect(ltDelegate)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()
      
      // Mine the order to expiry and confirm:
      //
      let blockNumber = await getLastBlockNumber()

      const orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const expiryBlock = orderInfo.orderExpiry
      const blocksToMine = expiryBlock - blockNumber
      await mineBlocks(blocksToMine)
      
      blockNumber = await getLastBlockNumber()
      expect(blockNumber).to.eq(expiryBlock)

      // Issue the extend transaction and expect failure:
      //
      await expect( balancerVaultContract.connect(ltDelegate)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltDelegate.address,
                                           ltDelegate.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#229')
    })
    
    it ("should not extend an order if insufficient funds [E-N-005] [E-N-006]", async function() {
      // Issue an LT swap:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      for (const extender of [ltOwner, ltDelegate]) {
        // Construct an LT Extend transaction with insufficient funds to get to the next block
        // interval:
        //
        //   NOTE: Tested this without minus 1n and the test does indeed fail meaning that
        //         we detect insufficient funds properly.
        //
        const orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
        const salesRate = BigInt(orderInfo.salesRate)
        const deposit = BigInt(orderInfo.deposit)
        const fundsToNextInterval = salesRate * BigInt(BLOCK_INTERVAL) - deposit
        const lessThanFundsToNextInterval = fundsToNextInterval - 1n
        const amt = BigNumber.from(lessThanFundsToNextInterval)

        const extendObjects = await poolHelper.getExtendObjects(amt, ZERO, swap.getOrderId());
        await token0AssetContract.connect(globalOwner)
                                  .transfer(extender.address, amt);
        await token0AssetContract.connect(extender)
                                 .approve(balancerVaultContract.address, extendObjects.token0Amt);
        await mineBlocks()

        // Issue the extend transaction and expect failure:
        //
        await expect(
                      balancerVaultContract.connect(extender)
                                           .joinPool(
                                             poolHelper.getPoolId(),
                                             extender.address,
                                             extender.address,
                                             extendObjects.joinStruct
                                           )
                    ).to.be.revertedWith('CFI#230')
        }
    })
    
    it ("should not extend a paused order [E-N-007] [E-N-008]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)

      // Pause the LT swap and confirm:
      //
      const txn = await poolContract.connect(ltOwner).pauseOrder(swap.getOrderId())
      await mineBlocks();

      const orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      expect(orderInfo.paused).to.eq(true)

      for (const extender of [ltOwner, ltDelegate]) {
        // Construct an LT Extend transaction:
        //
        const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
        const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, swap.getOrderId());
        await token0AssetContract.connect(globalOwner)
                                  .transfer(extender.address, amt10kT0);
        await token0AssetContract.connect(extender)
                                 .approve(balancerVaultContract.address, extendObjects.token0Amt);
        await mineBlocks()

        // Issue the extend transaction and expect failure:
        //
        await expect( balancerVaultContract.connect(extender)
                                           .joinPool(
                                             poolHelper.getPoolId(),
                                             extender.address,
                                             extender.address,
                                             extendObjects.joinStruct
                                           )
                    ).to.be.revertedWith('CFI#231')
      }
    })
    
    it ("should not extend a cancelled order [E-N-009]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt2kT0 = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt2kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)

      // Construct an LT Extend transaction:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const extendObjects = await poolHelper.getExtendObjects(amt10kT0, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, amt10kT0);
      await token0AssetContract.connect(ltOwner)
                               .approve(balancerVaultContract.address, extendObjects.token0Amt);
      await mineBlocks()

      // Cancel the order:
      //
      await swap.cancelLongTerm()

      // Issue the extend transaction and expect failure:
      //
      await expect( balancerVaultContract.connect(ltOwner)
                                         .joinPool(
                                           poolHelper.getPoolId(),
                                           ltOwner.address,
                                           ltOwner.address,
                                           extendObjects.joinStruct
                                         )
                  ).to.be.revertedWith('CFI#008')
    })

    it ("should not extend beyond maximum order length [E-N-010] [E-N-011]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)

      for (const extender of [ltOwner, ltDelegate]) {
        // Construct an LT Extend transaction with just enough funds to extend
        // to half the maximum order length:
        //
        let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())

        // Calculate the the maximum expiry block, aligned on block intervals:
        const blockIntervalN = BigInt(BLOCK_INTERVAL)
        const orderStart = BigInt(orderInfo.orderStart)
        const maxOrderIntervals = 175320n    // From STABLE_MAX_INTERVALS (Constants.sol)
        const tooManyOrderIntervals = maxOrderIntervals + 1n
        const maxExpiryBlock = orderStart + (tooManyOrderIntervals * blockIntervalN)
        const maxExpiryBlockAlignUp = maxExpiryBlock +
                                      (blockIntervalN -
                                        (maxExpiryBlock % blockIntervalN)
                                      )

        // Calc. amount difference needed for extend:
        const salesRate = BigInt(orderInfo.salesRate)
        const origExpiry = BigInt(orderInfo.orderExpiry)
        const deposit = BigInt(orderInfo.deposit)
        const fundsToMaxExpiry = (maxExpiryBlockAlignUp - origExpiry) * salesRate - deposit
        const differenceAmt = BigNumber.from(fundsToMaxExpiry)

        // Perform the extension:
        const extendObjects = await poolHelper.getExtendObjects(differenceAmt, ZERO, swap.getOrderId());
        await token0AssetContract.connect(globalOwner)
                                  .transfer(extender.address, differenceAmt);
        await token0AssetContract.connect(extender)
                                 .approve(balancerVaultContract.address, extendObjects.token0Amt);

        await expect( balancerVaultContract.connect(extender)
                                           .joinPool(
                                             poolHelper.getPoolId(),
                                             extender.address,
                                             extender.address,
                                             extendObjects.joinStruct
                                           )
                    ).to.be.revertedWith('CFI#223')
      }
    })

    it ("should not extend beyond maximum order length [E-N-012] [E-N-013]", async function() {
      // Mint more T0 Tokens to get above 2^112:
      //
      const moreThanBalMax = BigNumber.from(2n**116n)
      await token0AssetContract.connect(globalOwner).mint(globalOwner.address, moreThanBalMax);
      await mineBlocks()

      // Issue an LT Swap and mine a few blocks:
      //
      const amtAlotT0 = (BigNumber.from(2n ** 112n).sub(INITIAL_LIQUIDITY_0)).div(2)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amtAlotT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)

      for (const extender of [ltOwner, ltDelegate]) {
        // Calculate the amount to extend 2 intervals (this should be too much
        // for the Bal Pool) and then try to extend with that:
        //
        const orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
        const extendAmt = BigNumber.from(
          BigInt(orderInfo.salesRate) * BigInt(BLOCK_INTERVAL)
        )

        const extendObjects = await poolHelper.getExtendObjects(extendAmt, ZERO, swap.getOrderId());
        await token0AssetContract.connect(globalOwner)
                                  .transfer(extender.address, extendAmt);
        await token0AssetContract.connect(extender)
                                 .approve(balancerVaultContract.address, extendObjects.token0Amt);

        await expect( balancerVaultContract.connect(extender)
                                           .joinPool(
                                             poolHelper.getPoolId(),
                                             extender.address,
                                             extender.address,
                                             extendObjects.joinStruct
                                           )
                    ).to.be.revertedWith('CFI#401')   // <-- Expected BAL#526, but might be
                                                      //     hitting overflow first.
                                                      //     TODO: Explore further

        // Confirm no change to expiry:
        //
        const orderInfoAfter = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
        expect(orderInfoAfter.orderExpiry).to.eq(orderInfo.orderExpiry)
      }
    })
  })

  describe("LT Order Extend Positive Tests", function() {
    it ("should extend an order 1 block interval (owner) [E-P-001]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();


      // Construct an LT Extend transaction with just enough funds for 
      // one extra block interval and run it:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const origExpiry = orderInfo.orderExpiry
      const salesRate = BigInt(orderInfo.salesRate)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToNextInterval = salesRate * BigInt(BLOCK_INTERVAL) - deposit
      const amt = BigNumber.from(fundsToNextInterval)

      const extendObjects = await poolHelper.getExtendObjects(amt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, amt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const newExpiry = orderInfo.orderExpiry
      const extendBlocks = Number(newExpiry.sub(origExpiry))
      expect(extendBlocks, 'Should be one interval in future from original').to.be.eq(BLOCK_INTERVAL)
      expect(orderInfo.deposit).to.eq(ZERO)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(amt)
    })

    it ("should extend an order 1 block interval (delegate) [E-P-002]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();


      // Construct an LT Extend transaction with just enough funds for 
      // one extra block interval and run it:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const origExpiry = orderInfo.orderExpiry
      const salesRate = BigInt(orderInfo.salesRate)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToNextInterval = salesRate * BigInt(BLOCK_INTERVAL) - deposit
      const amt = BigNumber.from(fundsToNextInterval)

      const extendObjects = await poolHelper.getExtendObjects(amt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, amt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      const newExpiry = orderInfo.orderExpiry
      const extendBlocks = Number(newExpiry.sub(origExpiry))
      expect(extendBlocks, 'Should be one interval in future from original').to.be.eq(BLOCK_INTERVAL)
      expect(orderInfo.deposit).to.eq(ZERO)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(amt)
    })
    
    it ("should extend an order to 1/2 maximum expiry (owner) [E-P-003]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();

      // Construct an LT Extend transaction with just enough funds to extend
      // to half the maximum order length:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())

      // Calculate the block half way to the maximum expiry block, aligned on 
      // block intervals:
      const blockIntervalN = BigInt(BLOCK_INTERVAL)
      const orderStart = BigInt(orderInfo.orderStart)
      const maxOrderIntervals = 175320n    // From STABLE_MAX_INTERVALS (Constants.sol)
      const maxExpiryBlock = orderStart + (maxOrderIntervals * blockIntervalN)
      const halfMaxExpiryBlock = ((maxExpiryBlock - orderStart) / 2n) + orderStart
      const halfMaxExpiryBlockAlignedUp = halfMaxExpiryBlock + 
                                          (blockIntervalN - 
                                            (halfMaxExpiryBlock % blockIntervalN)
                                          )

      // Calc. amount difference needed for extend:
      const salesRate = BigInt(orderInfo.salesRate)
      const origExpiry = BigInt(orderInfo.orderExpiry)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToHalfMaxExpiry = (halfMaxExpiryBlockAlignedUp - origExpiry) * salesRate - deposit
      const differenceAmt = BigNumber.from(fundsToHalfMaxExpiry)

      // Perform the extension:
      const extendObjects = await poolHelper.getExtendObjects(differenceAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, differenceAmt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      expect(orderInfo.deposit).to.eq(ZERO)
      const newExpiry = orderInfo.orderExpiry
      expect(newExpiry, 'Should be extended to half the order max, aligned up')
            .to.be.eq(halfMaxExpiryBlockAlignedUp)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(differenceAmt)
    })
    
    it ("should extend an order to 1/2 maximum expiry (delegate) [E-P-004]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();

      // Construct an LT Extend transaction with just enough funds to extend
      // to half the maximum order length:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())

      // Calculate the block half way to the maximum expiry block, aligned on 
      // block intervals:
      const blockIntervalN = BigInt(BLOCK_INTERVAL)
      const orderStart = BigInt(orderInfo.orderStart)
      const maxOrderIntervals = 175320n    // From STABLE_MAX_INTERVALS (Constants.sol)
      const maxExpiryBlock = orderStart + (maxOrderIntervals * blockIntervalN)
      const halfMaxExpiryBlock = ((maxExpiryBlock - orderStart) / 2n) + orderStart
      const halfMaxExpiryBlockAlignedUp = halfMaxExpiryBlock + 
                                          (blockIntervalN - 
                                            (halfMaxExpiryBlock % blockIntervalN)
                                          )

      // Calc. amount difference needed for extend:
      const salesRate = BigInt(orderInfo.salesRate)
      const origExpiry = BigInt(orderInfo.orderExpiry)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToHalfMaxExpiry = (halfMaxExpiryBlockAlignedUp - origExpiry) * salesRate - deposit
      const differenceAmt = BigNumber.from(fundsToHalfMaxExpiry)

      // Perform the extension:
      const extendObjects = await poolHelper.getExtendObjects(differenceAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, differenceAmt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      expect(orderInfo.deposit).to.eq(ZERO)
      const newExpiry = orderInfo.orderExpiry
      expect(newExpiry, 'Should be extended to half the order max, aligned up')
            .to.be.eq(halfMaxExpiryBlockAlignedUp)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(differenceAmt)
    })

    it ("should extend an order to maximum expiry (owner) [E-P-005]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();

      // Construct an LT Extend transaction with just enough funds to extend
      // to half the maximum order length:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())

      // Calculate the the maximum expiry block, aligned on block intervals:
      const blockIntervalN = BigInt(BLOCK_INTERVAL)
      const orderStart = BigInt(orderInfo.orderStart)
      const maxOrderIntervals = 175320n    // From STABLE_MAX_INTERVALS (Constants.sol)
      const maxExpiryBlock = orderStart + (maxOrderIntervals * blockIntervalN)
      const maxExpiryBlockAlignUp = maxExpiryBlock +
                                    (blockIntervalN -
                                      (maxExpiryBlock % blockIntervalN)
                                    )

      // Calc. amount difference needed for extend:
      const salesRate = BigInt(orderInfo.salesRate)
      const origExpiry = BigInt(orderInfo.orderExpiry)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToMaxExpiry = (maxExpiryBlockAlignUp - origExpiry) * salesRate - deposit
      const differenceAmt = BigNumber.from(fundsToMaxExpiry)

      // Perform the extension:
      const extendObjects = await poolHelper.getExtendObjects(differenceAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltOwner.address, differenceAmt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      expect(orderInfo.deposit).to.eq(ZERO)
      const newExpiry = orderInfo.orderExpiry
      expect(newExpiry, 'Should be extended to order max, aligned up')
            .to.be.eq(maxExpiryBlockAlignUp)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(differenceAmt)
    })

    it ("should extend an order to maximum expiry (delegate) [E-P-006]", async function() {
      // Issue an LT Swap and mine a few blocks:
      //
      const amt10kT0 = scaleUp(10_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects1 = await swap.longTerm(
        amt10kT0,
        0,      // Intervals (contract adds 1)
        ltOwner,
        true,   // doSwap
        true,   // doApprovals 
        ltDelegate
      )

      await mineBlocks(10)
      const ordersBefore = await poolContract.getOrderAmounts();

      // Construct an LT Extend transaction with just enough funds to extend
      // to half the maximum order length:
      //
      let orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())

      // Calculate the the maximum expiry block, aligned on block intervals:
      const blockIntervalN = BigInt(BLOCK_INTERVAL)
      const orderStart = BigInt(orderInfo.orderStart)
      const maxOrderIntervals = 175320n    // From STABLE_MAX_INTERVALS (Constants.sol)
      const maxExpiryBlock = orderStart + (maxOrderIntervals * blockIntervalN)
      const maxExpiryBlockAlignUp = maxExpiryBlock +
                                    (blockIntervalN -
                                      (maxExpiryBlock % blockIntervalN)
                                    )

      // Calc. amount difference needed for extend:
      const salesRate = BigInt(orderInfo.salesRate)
      const origExpiry = BigInt(orderInfo.orderExpiry)
      const deposit = BigInt(orderInfo.deposit)
      const fundsToMaxExpiry = (maxExpiryBlockAlignUp - origExpiry) * salesRate - deposit
      const differenceAmt = BigNumber.from(fundsToMaxExpiry)

      // Perform the extension:
      const extendObjects = await poolHelper.getExtendObjects(differenceAmt, ZERO, swap.getOrderId());
      await token0AssetContract.connect(globalOwner)
                                .transfer(ltDelegate.address, differenceAmt);
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
      const ordersAfter = await poolContract.getOrderAmounts();
      
      // Confirm the new expiry:
      //
      orderInfo = await poolContract.connect(ltOwner).getOrder(swap.getOrderId())
      expect(orderInfo.deposit).to.eq(ZERO)
      const newExpiry = orderInfo.orderExpiry
      expect(newExpiry, 'Should be extended to order max, aligned up')
            .to.be.eq(maxExpiryBlockAlignUp)

      // Confirm that the order pool has the correct amount added to it:
      //
      const orderAmtAdded = ordersAfter.orders0U112.sub(ordersBefore.orders0U112)
      expect(orderAmtAdded, 'Extension should add entire amount to order pool').to.eq(differenceAmt)
    })
  })
})
